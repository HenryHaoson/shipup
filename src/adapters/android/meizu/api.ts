// 文档：https://open.flyme.cn/docs?id=333（域名 developer.meizu.com）
// 能力：更新已上架应用的版本（新版本发布）。要求 64 位安装包。
//
// 调用流程：
// 1) GET /open/api/v1/token 换 accessToken（header: clientId/clientSecret）
// 2) POST /open/api/v1/app/apk/upload  multipart 上传 APK，得 destFileName(packageUrl)
// 3) GET /open/api/v1/app/list 按包名找 appId / 最新 verId
// 4) GET /open/api/v1/app/detail 取当前版本全部字段（分类/标签/备案/资质等）
// 5) POST /open/api/v1/app/image/upload 上传图标
// 6) POST /open/api/v1/app/publish 复用 detail 字段 + 新包 + 新版本说明，发布新版本
//
// 每个业务请求都带签名：参与字段 traceId/clientId/timestamp/uri，
// 按 "key=value" 升序拼 & 后追加 ":clientSecret"，SHA-256 转小写 hex。
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../../../infra/crypto.js';
import { redactSensitive, UploadError } from '../../../core/types.js';
import { withRetry } from '../../../infra/http.js';

const BASE = 'https://developer.meizu.com';

/** 魅族鉴权三元组（clientId/clientSecret 来自 access_key/access_secret 配置）。 */
export interface MeizuAuth {
  clientId: string;
  clientSecret: string;
  accessToken: string;
}

/**
 * 签名：参与字段 traceId、clientId、timestamp、uri；
 * 按 "key=value" 升序拼 & 后追加 ":clientSecret"，SHA-256 转小写 hex。
 */
export function signMeizu(args: {
  traceId: string;
  clientId: string;
  timestamp: string;
  uri: string;
  clientSecret: string;
}): string {
  const parts = [
    `clientId=${args.clientId}`,
    `timestamp=${args.timestamp}`,
    `traceId=${args.traceId}`,
    `uri=${args.uri}`,
  ].sort();
  const raw = `${parts.join('&')}:${args.clientSecret}`;
  return sha256Hex(raw);
}

/** 组装公共请求头（含签名）。multipart 时不要带 Content-Type，交给 fetch 自动加 boundary。 */
function commonHeaders(uri: string, auth: MeizuAuth): Record<string, string> {
  const traceId = randomUUID();
  const timestamp = String(Date.now());
  const sign = signMeizu({
    traceId,
    clientId: auth.clientId,
    timestamp,
    uri,
    clientSecret: auth.clientSecret,
  });
  return {
    traceId,
    clientId: auth.clientId,
    timestamp,
    sign,
    accessToken: auth.accessToken,
  };
}

/** 校验响应 code===200，否则抛 UploadError；返回 value。 */
function checkValue(data: any, fallbackMsg: string): any {
  if (Number(data?.code ?? -1) !== 200) {
    throw new UploadError(data?.code ?? -1, String(data?.msg ?? fallbackMsg));
  }
  return data?.value;
}

/** 获取鉴权 accessToken（header 传 clientId/clientSecret，无签名）。 */
export async function getToken(args: {
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}): Promise<string> {
  return withRetry(
    async () => {
      const res = await fetch(`${BASE}/open/api/v1/token`, {
        method: 'GET',
        headers: { clientId: args.clientId, clientSecret: args.clientSecret },
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      const data = JSON.parse(await res.text());
      const value = checkValue(data, 'token error');
      return String(value.accessToken);
    },
    { label: 'meizu token' },
  );
}

/** GET 请求（公共头），返回 value。query 不参与签名（签名只用 path）。 */
async function getValue(
  uri: string,
  query: Record<string, string>,
  auth: MeizuAuth,
  timeoutMs: number,
): Promise<any> {
  const url = new URL(`${BASE}${uri}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return withRetry(
    async () => {
      // commonHeaders 放进闭包：每次重试都重算 traceId/timestamp/sign，避免签名过期。
      const res = await fetch(url, {
        method: 'GET',
        headers: commonHeaders(uri, auth),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = JSON.parse(await res.text());
      return checkValue(data, `get error: ${uri}`);
    },
    { label: `meizu ${uri}` },
  );
}

/** multipart 上传单文件，返回 value.destFileName。 */
async function uploadFile(
  uri: string,
  bytes: Buffer | Uint8Array,
  filename: string,
  contentType: string,
  auth: MeizuAuth,
  timeoutMs: number,
  fallbackMsg: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const res = await fetch(`${BASE}${uri}`, {
    method: 'POST',
    headers: commonHeaders(uri, auth), // 不含 Content-Type，fetch 自动补 multipart boundary
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = JSON.parse(await res.text());
  const value = checkValue(data, fallbackMsg);
  return String(value.destFileName);
}

/** 上传 APK，返回 destFileName（packageUrl）。 */
export async function uploadApk(args: {
  auth: MeizuAuth;
  apkBytes: Buffer | Uint8Array;
  apkFilename: string;
  timeoutMs: number;
}): Promise<string> {
  return uploadFile(
    '/open/api/v1/app/apk/upload',
    args.apkBytes,
    args.apkFilename,
    'application/octet-stream',
    args.auth,
    args.timeoutMs,
    'apk upload error',
  );
}

/** 上传图片（图标/截图），返回 destFileName。 */
export async function uploadImage(args: {
  auth: MeizuAuth;
  imageBytes: Buffer | Uint8Array;
  imageFilename: string;
  contentType: string;
  timeoutMs: number;
}): Promise<string> {
  return uploadFile(
    '/open/api/v1/app/image/upload',
    args.imageBytes,
    args.imageFilename,
    args.contentType,
    args.auth,
    args.timeoutMs,
    'image upload error',
  );
}

/** 按包名查找开发者应用，返回 {id, verId, versionName, status, ...}。 */
export async function findAppByPackage(args: {
  auth: MeizuAuth;
  packageName: string;
  timeoutMs: number;
}): Promise<any> {
  let start = 0;
  const limit = 10;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await getValue(
      '/open/api/v1/app/list',
      { start: String(start), limit: String(limit) },
      args.auth,
      args.timeoutMs,
    );
    const list: any[] = Array.isArray(value?.data) ? value.data : [];
    for (const app of list) {
      if (String(app?.pkgName) === args.packageName) return app;
    }
    const total = Number(value?.total ?? 0);
    start += limit;
    if (list.length === 0 || start >= total) {
      throw new UploadError(-1, `魅族未找到应用: ${args.packageName}`);
    }
  }
}

/** 根据 verId 获取应用详情（全部字段）。 */
export async function getAppDetail(args: {
  auth: MeizuAuth;
  verId: string;
  timeoutMs: number;
}): Promise<any> {
  return getValue('/open/api/v1/app/detail', { verId: args.verId }, args.auth, args.timeoutMs);
}

/** 获取应用版本列表（用于回退查找可复用的截图）。 */
export async function getAppVersions(args: {
  auth: MeizuAuth;
  appId: string;
  timeoutMs: number;
}): Promise<any[]> {
  const value = await getValue('/open/api/v1/app/versions', { appId: args.appId }, args.auth, args.timeoutMs);
  return Array.isArray(value) ? value : [];
}

/** 解析可复用的截图：优先当前 detail；为空则遍历历史版本 detail 取第一份非空。 */
export async function resolveScreenShots(args: {
  auth: MeizuAuth;
  appId: string;
  detail: any;
  timeoutMs: number;
}): Promise<any[]> {
  const cur = args.detail?.screenShots;
  if (Array.isArray(cur) && cur.length > 0) return cur;
  const versions = await getAppVersions({ auth: args.auth, appId: args.appId, timeoutMs: args.timeoutMs });
  for (const v of versions) {
    const verId = v?.verId != null ? String(v.verId) : '';
    if (!verId) continue;
    try {
      const d = await getAppDetail({ auth: args.auth, verId, timeoutMs: args.timeoutMs });
      const ss = d?.screenShots;
      if (Array.isArray(ss) && ss.length > 0) {
        console.error(`[meizu] 复用历史版本 ${verId} 的截图（${ss.length} 张）`);
        return ss;
      }
    } catch {
      /* 忽略单个历史版本详情失败，继续找下一个 */
    }
  }
  return [];
}

/** 发布新版本：复用 detail 字段，覆盖 packageUrl/verDesc/icon/screenShots。返回新 verId。 */
export async function publish(args: {
  auth: MeizuAuth;
  detail: any;
  packageUrl: string;
  verDesc: string;
  icon: string;
  screenShots: any[];
  /** 按需覆盖 detail 回填的文案（有值才覆盖，否则复用线上 detail） */
  appName?: string;
  summary?: string;
  description?: string;
  privacyPolicyUrl?: string;
  timeoutMs: number;
}): Promise<number> {
  const uri = '/open/api/v1/app/publish';
  const detail = args.detail ?? {};
  const certificatesRaw = detail.certificates;
  const certificates = Array.isArray(certificatesRaw)
    ? certificatesRaw
    : certificatesRaw != null
      ? String(certificatesRaw).split(',')
      : [];
  // 文案真值守卫：仅当外部传入非空串才覆盖，否则复用线上 detail 回填（与 samsung/qq 的真值判断一致）。
  // 空串 '' 是 falsy → 走 fallback，避免空文案覆盖线上已有值。
  const pick = (override: string | undefined, fallback: unknown): unknown =>
    override ? override : fallback ?? null;
  const payload: Record<string, unknown> = {
    appName: pick(args.appName, detail.name),
    appDesc: pick(args.description, detail.appDescription),
    verDesc: args.verDesc,
    // 主分类从 detail 回填，取不到再兜底 1，避免硬编码 catid:1 覆盖线上主分类。
    catid: detail.category1Id ?? 1,
    cat2id: detail.category2Id ?? null,
    tagId: detail.tagId ?? null,
    authorName: detail.authorName ?? null,
    packageUrl: args.packageUrl,
    icon: args.icon,
    screenShots: args.screenShots,
    certificates,
    privacyPolicyUrl: args.privacyPolicyUrl ?? detail.privacyPolicyUrl ?? null,
    keyword: detail.keyword ?? null,
    recommendDesc: pick(args.summary, detail.recommendDesc),
    softwareAuthorNum: detail.softwareAuthorNum ?? null,
    devContact: detail.devContact ?? null,
    ageBracket: detail.ageBracket ?? null,
    qualifcation: detail.qualifcation ?? null,
    dwmc: detail.dwmc ?? null,
    zjlx: detail.zjlx ?? null,
    zjhm: detail.zjhm ?? null,
    yyzzjlx: detail.yyzzjlx ?? null,
    yyzmc: detail.yyzmc ?? null,
    yyzzjhm: detail.yyzzjhm ?? null,
    yyzlxrlxfs: detail.yyzlxrlxfs ?? null,
    yylb: detail.yylb ?? null,
    zbzShengId: detail.zbzShengId ?? null,
  };

  // 诊断：publish 全字段必填，若 detail 未回吐某些备案/资质字段会导致 113001 缺少参数。
  // 找出为空的必填字段（仅打印 key，不打印值，避免泄露证件号等敏感信息）。
  const requiredKeys = [
    'appName', 'appDesc', 'verDesc', 'cat2id', 'tagId', 'authorName',
    'packageUrl', 'icon', 'screenShots', 'certificates', 'privacyPolicyUrl',
    'keyword', 'recommendDesc', 'softwareAuthorNum', 'devContact', 'ageBracket',
    'qualifcation', 'dwmc', 'zjlx', 'zjhm', 'yyzzjlx', 'yyzmc', 'yyzzjhm',
    'yyzlxrlxfs', 'yylb', 'zbzShengId',
  ];
  const missing: string[] = [];
  for (const k of requiredKeys) {
    const v = payload[k];
    if (
      v === null ||
      v === undefined ||
      (typeof v === 'string' && v.length === 0) ||
      (Array.isArray(v) && v.length === 0)
    ) {
      missing.push(k);
    }
  }
  console.error(`[meizu] detail 返回字段: ${JSON.stringify(Object.keys(detail))}`);
  if (missing.length > 0) {
    console.error(`[meizu] publish 必填但为空的字段（来自 detail 复用）: ${missing.join(', ')}`);
  }

  const headers = { ...commonHeaders(uri, args.auth), 'Content-Type': 'application/json' };
  const res = await fetch(`${BASE}${uri}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  const respBody = await res.text();
  console.error(`[meizu] publish resp: ${redactSensitive(respBody).slice(0, 500)}`);
  const data = JSON.parse(respBody);
  if (Number(data?.code ?? -1) !== 200) {
    const code = data?.code ?? -1;
    // 魅族错误响应字段可能是 msg 或 message；都空时带上原始响应，便于定位 113046 这类服务端拒绝。
    const rawMsg = data?.msg ?? data?.message;
    const base =
      rawMsg != null && String(rawMsg).length > 0
        ? `${rawMsg}（resp: ${respBody}）`
        : `publish error（resp: ${respBody}）`;
    const hint = missing.length === 0 ? '' : `；疑似缺失字段(detail 未回吐): ${missing.join(', ')}`;
    throw new UploadError(code, `${base}${hint}`);
  }
  return Number(data.value.verId);
}

/** 应用状态码 → 文案（见文档附录 3.12.6）。 */
export function meizuStatusText(status: unknown): string {
  switch (Number(status)) {
    case 20:
      return '待审核';
    case 30:
      return '审核不通过';
    case 50:
      return '上架';
    case 70:
      return '下架';
    case 100:
      return '审核中';
    default:
      return `status=${status}`;
  }
}

/**
 * 完整传报：换 token → 传包 → 传图标 → 取线上详情/截图 → 发布新版本。
 *
 * 魅族 /app/detail 不回吐 icon/screenShots：icon 用 APK 提取图标重新上传，
 * screenShots 复用线上已有（detail 或历史版本）。
 *
 * 幂等：publish 实际成功后服务端会保存版本，但重复提交会被拒为 113046/113040。
 * 因此发布前先比对线上最新版本号，已是本包版本则跳过；publish 报错后再复查，
 * 若版本已出现则判定为成功（避免“其实传上去了却报错”）。
 */
export async function uploadMeizu(args: {
  clientId: string;
  clientSecret: string;
  packageName: string;
  apkBytes: Buffer | Uint8Array;
  apkFilename: string;
  iconBytes: Buffer | Uint8Array;
  iconFilename: string;
  iconContentType: string;
  versionName: string;
  verDesc: string;
  privacyUrl?: string;
  /** 应用名称（按需覆盖 detail.name） */
  appName?: string;
  /** 一句话推荐语（按需覆盖 detail.recommendDesc） */
  summary?: string;
  /** 应用简介/长描述（按需覆盖 detail.appDescription） */
  description?: string;
  /** 外部提供的截图（已按 jpg 编码）；非空时逐张上传得 destFileName 覆盖 screenShots，空/未传则复用线上/历史 */
  screenshotImages?: Array<{ bytes: Buffer | Uint8Array; filename: string; contentType: string }>;
  /** 元数据类请求（token/list/detail/publish）超时 */
  timeoutMs: number;
  /** 大文件上传（apk/图片）超时 */
  uploadTimeoutMs: number;
}): Promise<void> {
  console.error('[meizu] get token');
  const accessToken = await getToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    timeoutMs: args.timeoutMs,
  });
  const auth: MeizuAuth = { clientId: args.clientId, clientSecret: args.clientSecret, accessToken };

  console.error(`[meizu] find app for ${args.packageName}`);
  const app = await findAppByPackage({ auth, packageName: args.packageName, timeoutMs: args.timeoutMs });
  // 幂等预检：线上最新版本已是本包版本 → 视为已提交，跳过
  if (String(app?.versionName) === args.versionName) {
    console.error(
      `[meizu] 版本 ${args.versionName} 已是最新提交版本(${meizuStatusText(app?.status)})，跳过 publish，视为成功`,
    );
    return;
  }

  console.error('[meizu] upload apk');
  const packageUrl = await uploadApk({
    auth,
    apkBytes: args.apkBytes,
    apkFilename: args.apkFilename,
    timeoutMs: args.uploadTimeoutMs,
  });

  console.error('[meizu] upload icon');
  const iconPath = await uploadImage({
    auth,
    imageBytes: args.iconBytes,
    imageFilename: args.iconFilename,
    contentType: args.iconContentType,
    timeoutMs: args.uploadTimeoutMs,
  });

  const detail = await getAppDetail({ auth, verId: String(app?.verId), timeoutMs: args.timeoutMs });

  // 截图：外部提供则逐张 /image/upload 得 destFileName 覆盖 screenShots；空则复用线上/历史（detail 或历史版本）。
  let screenShots: any[];
  if (args.screenshotImages && args.screenshotImages.length > 0) {
    console.error(`[meizu] upload ${args.screenshotImages.length} screenshot(s)`);
    screenShots = [];
    for (const img of args.screenshotImages) {
      const dest = await uploadImage({
        auth,
        imageBytes: img.bytes,
        imageFilename: img.filename,
        contentType: img.contentType,
        timeoutMs: args.uploadTimeoutMs,
      });
      screenShots.push(dest);
    }
  } else {
    screenShots = await resolveScreenShots({
      auth,
      appId: String(app?.id),
      detail,
      timeoutMs: args.timeoutMs,
    });
    if (screenShots.length === 0) {
      throw new UploadError(
        113001,
        '魅族缺少应用截图（detail 与历史版本均未返回 screenShots），请先在 Flyme 控制台为该应用配置截图后重试',
      );
    }
  }

  console.error('[meizu] publish new version');
  try {
    const verId = await publish({
      auth,
      detail,
      packageUrl,
      icon: iconPath,
      screenShots,
      verDesc: args.verDesc,
      appName: args.appName,
      summary: args.summary,
      description: args.description,
      privacyPolicyUrl: args.privacyUrl,
      timeoutMs: args.timeoutMs,
    });
    console.error(`[meizu] published, verId=${verId}`);
  } catch (e) {
    // publish 报错后复查：服务端可能其实已创建该版本（如 113046/113040）
    try {
      const after = await findAppByPackage({ auth, packageName: args.packageName, timeoutMs: args.timeoutMs });
      if (String(after?.versionName) === args.versionName) {
        console.error(
          `[meizu] publish 返回错误但版本 ${args.versionName} 已出现(${meizuStatusText(after?.status)})，判定为成功: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return;
      }
    } catch {
      /* 复查失败则按原始错误抛出 */
    }
    throw e;
  }
}
