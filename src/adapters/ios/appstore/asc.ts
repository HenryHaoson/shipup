// App Store Connect API v1 客户端。
// 鉴权：JWT ES256（node:crypto，EC P-256）。封装 ascFetch 自动带 Authorization: Bearer。
import { createPrivateKey, sign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { UploadError } from '../../../core/types.js';
import { withRetry } from '../../../infra/http.js';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export interface AscCreds {
  /** ASC API Key ID（creds.key_id） */
  keyId: string;
  /** ASC Issuer ID（creds.issuer_id） */
  issuerId: string;
  /** .p8 / PKCS#8 PEM 内容（creds.private_key） */
  privateKey: string;
}

/** 各 locale 的文案字段（key 直接对应 ASC localization 属性名）。 */
export type LocalizationFields = Partial<{
  whatsNew: string;
  description: string;
  promotionalText: string;
  keywords: string;
}>;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * 生成 ASC JWT（ES256）。
 * header  {alg:'ES256', kid:key_id, typ:'JWT'}
 * payload {iss:issuer_id, iat:now, exp:now+1200, aud:'appstoreconnect-v1'}
 * 签名用 dsaEncoding:'ieee-p1363' 直接得到 JOSE(R||S) 格式（无需 DER→JOSE 手工转换）。
 */
export function makeAscToken(creds: AscCreds): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: creds.keyId, typ: 'JWT' };
  const payload = { iss: creds.issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(creds.privateKey);
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

const enc = encodeURIComponent;

export class AscClient {
  private readonly creds: AscCreds;
  private readonly requestTimeoutMs: number;
  private token?: string;
  private tokenExp = 0;

  constructor(creds: AscCreds, requestTimeoutMs = 60_000) {
    this.creds = creds;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private authToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (!this.token || now >= this.tokenExp - 60) {
      this.token = makeAscToken(this.creds);
      this.tokenExp = now + 1200;
    }
    return this.token;
  }

  /**
   * 通用请求：method/path(+body)，自动带鉴权；非 2xx 抛 UploadError（携带 ASC 错误码，合并全部 errors）。
   * 仅对 **GET** 在 5xx/429/网络/超时 时重试（幂等）；POST/PATCH 不自动重试，避免重复创建/重复提交。
   */
  async ascFetch(method: string, path: string, body?: unknown): Promise<any> {
    const url = path.startsWith('http') ? path : `${ASC_BASE}${path}`;
    return withRetry(
      async () => {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.authToken()}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          let code: string | number = res.status;
          let msg = text.slice(0, 800);
          try {
            const errs = JSON.parse(text)?.errors;
            if (Array.isArray(errs) && errs.length > 0) {
              code = errs[0].code ?? res.status;
              // 提审失败常一次返回多条（缺截图/缺合规/缺 whatsNew），全部拼出便于诊断。
              msg =
                errs
                  .map((e: any) => [e.title, e.detail].filter(Boolean).join(' — '))
                  .filter(Boolean)
                  .join(' | ') || msg;
            }
          } catch {
            /* 保留原始文本 */
          }
          throw new UploadError(code, `ASC ${method} ${path} -> ${res.status}: ${msg}`);
        }
        if (!text) return null; // 204 No Content（如 PATCH relationships）
        try {
          return JSON.parse(text);
        } catch {
          throw new UploadError('parse', `ASC 非 JSON 响应: ${text.slice(0, 300)}`);
        }
      },
      { label: `ASC ${method} ${path}`, retries: method === 'GET' ? 3 : 0 },
    );
  }

  // ── builds ──

  /**
   * 轮询 build 直到 processingState=VALID，返回 build id。
   * GET /v1/builds?filter[app]=<appId>&filter[version]=<buildVersion>
   *
   * 两点健壮性（避免「上游上传失败 → 静默轮询到超时」的坑）：
   * - build 完全查不到（空结果）通常意味着上游 altool 上传失败/未完成：只容忍 notFoundGraceMs，
   *   之后 **快速失败** 并给出可诊断信息，而不是一路静默轮询到 deadline（默认 30min）。
   *   一旦见过该 build（哪怕仍在 PROCESSING），就转为正常等待到 deadline。
   * - 每次轮询打一行 stderr 进度（VALID 命中直接返回、不打日志，健康路径保持安静）。
   */
  async waitBuildValid(
    appId: string,
    buildVersion: string,
    preReleaseVersion: string | undefined,
    deadlineMs: number,
    intervalMs = 15_000,
    notFoundGraceMs = 300_000,
  ): Promise<string> {
    // 用 CFBundleVersion + 营销版本(版本列车)双过滤，避免跨版本列车复用同一 build 号时选错；
    // sort=-uploadedDate 取最新上传，避免 data[0] 顺序不确定。
    const train = preReleaseVersion
      ? `&filter[preReleaseVersion.version]=${enc(preReleaseVersion)}`
      : '';
    const query = `/v1/builds?filter[app]=${enc(appId)}&filter[version]=${enc(buildVersion)}${train}&sort=-uploadedDate&limit=1`;
    const label = `${buildVersion}(${preReleaseVersion ?? '-'})`;
    const notFoundDeadline = Math.min(Date.now() + notFoundGraceMs, deadlineMs);
    let seen = false;
    for (let attempt = 1; ; attempt++) {
      const data = await this.ascFetch('GET', query);
      const build = data?.data?.[0];
      const state: string | undefined = build?.attributes?.processingState;
      if (state === 'VALID') return build.id as string;
      if (state === 'FAILED' || state === 'INVALID') {
        throw new UploadError(state, `build ${label} 处理失败: ${state}`);
      }
      if (build) seen = true;
      const now = Date.now();
      console.error(
        `[asc] 等待 build ${label} 就绪… 第 ${attempt} 次，state=${state ?? '未出现（ASC 上暂无此 build）'}`,
      );
      // 从未出现且已过宽限期：几乎必然是上游没传上来，快速失败（而非空转到 deadline）。
      if (!seen && now > notFoundDeadline) {
        throw new UploadError(
          'build_not_found',
          `ASC 上找不到 build ${label}（${Math.round(notFoundGraceMs / 1000)}s 内始终未出现）。` +
            '通常是上游 altool 上传失败/未完成——请检查 asc-app 部署日志确认 build 已成功上传到 App Store Connect，再重试提审。',
        );
      }
      if (now > deadlineMs) {
        throw new UploadError('timeout', `等待 build ${label} 进入 VALID 超时（最后 state=${state ?? '未出现'}）`);
      }
      await sleep(intervalMs);
    }
  }

  // ── appStoreVersions ──

  /** GET /v1/apps/<appId>/appStoreVersions?filter[versionString]&filter[platform]=IOS，取第一条或 null。 */
  async getAppStoreVersion(appId: string, versionString: string): Promise<any | null> {
    const data = await this.ascFetch(
      'GET',
      `/v1/apps/${enc(appId)}/appStoreVersions?filter[versionString]=${enc(versionString)}&filter[platform]=IOS&limit=1`,
    );
    return data?.data?.[0] ?? null;
  }

  /**
   * 用 bundleId 反查 app 的数字 Apple ID。
   * altool 传包靠 ipa 里的 bundleId 定位 app（不需数字 id），但 REST API 要数字 id 引用资源。
   */
  async getAppIdByBundleId(bundleId: string): Promise<string> {
    const data = await this.ascFetch('GET', `/v1/apps?filter[bundleId]=${enc(bundleId)}&limit=1`);
    const id = data?.data?.[0]?.id;
    if (!id) {
      throw new UploadError(
        'not_found',
        `ASC 未找到 bundleId=${bundleId} 对应的 app（确认 bundle id 正确、且该 API key 有此 app 权限）`,
      );
    }
    return String(id);
  }

  /** app_id 优先；否则用 bundleId 反查。两者都没有则报错。 */
  async resolveAppId(appId?: string, bundleId?: string): Promise<string> {
    if (appId) return appId;
    if (bundleId) return this.getAppIdByBundleId(bundleId);
    throw new UploadError('input', '需要 --app-id 或 --bundle-id 之一');
  }

  /** 取已有 appStoreVersion，否则创建（POST /v1/appStoreVersions）。返回 version id。 */
  async ensureAppStoreVersion(appId: string, versionString: string, releaseType?: string): Promise<string> {
    const existing = await this.getAppStoreVersion(appId, versionString);
    if (existing) {
      // 已存在版本：若 releaseType 与现值不同则纠正（仅在可编辑态有效，否则 ASC 会拒）。
      if (releaseType && existing.attributes?.releaseType !== releaseType) {
        await this.ascFetch('PATCH', `/v1/appStoreVersions/${enc(existing.id)}`, {
          data: { type: 'appStoreVersions', id: existing.id, attributes: { releaseType } },
        });
      }
      return existing.id as string;
    }
    const attributes: Record<string, string> = { platform: 'IOS', versionString };
    if (releaseType) attributes.releaseType = releaseType;
    const res = await this.ascFetch('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes,
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    return res.data.id as string;
  }

  // ── localizations ──

  /** 写多地区文案：已存在的 locale PATCH，否则 POST（仅写非空字段）。 */
  async writeLocalizations(versionId: string, byLocale: Record<string, LocalizationFields>): Promise<void> {
    const locales = Object.keys(byLocale);
    if (locales.length === 0) return;
    const list = await this.ascFetch(
      'GET',
      `/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations?limit=50`,
    );
    const existing: any[] = list?.data ?? [];
    for (const locale of locales) {
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(byLocale[locale])) {
        if (v != null && v !== '') attrs[k] = v;
      }
      if (Object.keys(attrs).length === 0) continue;
      const found = existing.find((l) => l.attributes?.locale === locale);
      if (found) {
        await this.ascFetch('PATCH', `/v1/appStoreVersionLocalizations/${enc(found.id)}`, {
          data: { type: 'appStoreVersionLocalizations', id: found.id, attributes: attrs },
        });
      } else {
        await this.ascFetch('POST', '/v1/appStoreVersionLocalizations', {
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: { locale, ...attrs },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        });
      }
    }
  }

  /** 关联 build：PATCH /v1/appStoreVersions/<id>/relationships/build。 */
  async attachBuild(versionId: string, buildId: string): Promise<void> {
    await this.ascFetch('PATCH', `/v1/appStoreVersions/${enc(versionId)}/relationships/build`, {
      data: { type: 'builds', id: buildId },
    });
  }

  // ── reviewSubmissions（三步）──

  async submitForReview(appId: string, versionId: string): Promise<void> {
    const sub = await this.ascFetch('POST', '/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    const subId = sub.data.id as string;
    await this.ascFetch('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: subId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
    await this.ascFetch('PATCH', `/v1/reviewSubmissions/${enc(subId)}`, {
      data: { type: 'reviewSubmissions', id: subId, attributes: { submitted: true } },
    });
  }

  // ── phased release / release request ──

  /** GET /v1/appStoreVersions/<id>/appStoreVersionPhasedRelease（to-one），无则 null。 */
  async getPhasedRelease(versionId: string): Promise<any | null> {
    const data = await this.ascFetch(
      'GET',
      `/v1/appStoreVersions/${enc(versionId)}/appStoreVersionPhasedRelease`,
    );
    return data?.data ?? null;
  }

  /** 开启 7 天灰度：POST /v1/appStoreVersionPhasedReleases。 */
  async startPhasedRelease(versionId: string): Promise<any> {
    const res = await this.ascFetch('POST', '/v1/appStoreVersionPhasedReleases', {
      data: {
        type: 'appStoreVersionPhasedReleases',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
    return res.data;
  }

  /** PATCH /v1/appStoreVersionPhasedReleases/<id> 设 phasedReleaseState（合法值 ACTIVE/PAUSED/COMPLETE）。 */
  async setPhasedReleaseState(phasedId: string, state: 'COMPLETE' | 'PAUSED' | 'ACTIVE'): Promise<void> {
    await this.ascFetch('PATCH', `/v1/appStoreVersionPhasedReleases/${enc(phasedId)}`, {
      data: { type: 'appStoreVersionPhasedReleases', id: phasedId, attributes: { phasedReleaseState: state } },
    });
  }

  /** 手动触发发布：POST /v1/appStoreVersionReleaseRequests。 */
  async requestRelease(versionId: string): Promise<void> {
    await this.ascFetch('POST', '/v1/appStoreVersionReleaseRequests', {
      data: {
        type: 'appStoreVersionReleaseRequests',
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
  }
}
