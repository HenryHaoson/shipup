// 文档域名：https://oop-openapi-cn.heytapmobi.com
// 流程：token → 上传 APK（get-upload-url + multipart）→ enrich（拉取线上应用信息并合并）
//       →（可选）上传图标(photo 资源)/软著证书资源 → app/upd 提交（即提交审核）。
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { hmacSha256Hex, md5Hex } from '../../../infra/crypto.js';
import { postForm, isRetryable } from '../../../infra/http.js';
import { UploadError } from '../../../core/types.js';

const BASE = 'https://oop-openapi-cn.heytapmobi.com';
const TOKEN_EP = '/developer/v1/token';
const APP_INFO_EP = '/resource/v1/app/info';
const APP_UPD_EP = '/resource/v1/app/upd';
const UPLOAD_URL_EP = '/resource/v1/upload/get-upload-url';

const MAX_RETRIES = 3;
// 大文件上传超时下限（15min），与 ctx.timeoutMs 取大。
const BIG_UPLOAD_MIN_MS = 900000;

// enrich 时仅保留这些字段（避免把 version_name/audit_status 等只读态混入 upd 请求）。
const APP_INFO_KEYS = [
  'second_category_id',
  'third_category_id',
  'summary',
  'detail_desc',
  'privacy_source_url',
  'icon_url',
  'pic_url',
  'test_desc',
  'copyright_url',
  'electronic_cert_url',
  'special_url',
  'special_file_url',
  'business_username',
  'business_email',
  'business_mobile',
  'age_level',
  'adaptive_equipment',
  'adaptive_type',
  'other_cetificate_url', // 注意：OPPO 服务端字段拼写为 cetificate（少一个 r）
];

function nowSec(): string {
  return String(Math.floor(Date.now() / 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 签名：除 api_sign 外全部参数（非空）按 key 升序（ASCII 大小写无关）拼 k=v&...，HmacSHA256(clientSecret) 小写 hex。 */
export function signOppo(params: Record<string, string>, clientSecret: string): string {
  const str = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort((a, b) => {
      const A = a.toUpperCase();
      const B = b.toUpperCase();
      return A < B ? -1 : A > B ? 1 : 0;
    })
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return hmacSha256Hex(clientSecret, str);
}

/**
 * 通用重试：仅对可重试的瞬时失败（5xx / 429 / 网络 / 超时，由共享 isRetryable 判定）做指数退避
 * （2s * attempt）；4xx / 签名 / 参数 / 解析等非可重试错误立即原样抛出（重试无意义）。
 * 仅用于幂等请求（token / app/info / get-upload-url / 资源上传）；非幂等的 app/upd 提交不走此包裹。
 */
async function withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_RETRIES || !isRetryable(e)) throw e;
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

function safeErrMsg(data: any): string {
  return String(data?.data?.message ?? 'Unknown error');
}

/** GET 返回 JSON（非 200 / 非 JSON 抛 UploadError）。 */
async function httpGetJson(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    throw new UploadError(res.status, `http ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UploadError('parse', `非 JSON 响应: ${text.slice(0, 300)}`);
  }
}

/** multipart/form-data 上传（文件直传到 get-upload-url 返回的地址）。 */
async function postMultipart(
  uploadUrl: string,
  fields: Record<string, string>,
  fileBytes: Buffer,
  fileName: string,
  timeoutMs: number,
): Promise<any> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([fileBytes]), fileName);
  // 不手动设置 Content-Type，交由 fetch 自动带上 multipart boundary。
  const res = await fetch(uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    throw new UploadError(res.status, `上传失败 ${res.status}: ${text.slice(0, 300)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UploadError('parse', `上传返回非 JSON: ${text.slice(0, 300)}`);
  }
  if (Number(data?.errno) !== 0) {
    throw new UploadError(data?.errno ?? -1, safeErrMsg(data));
  }
  return data;
}

/** 获取 access_token（GET，client_id/client_secret 明文入参）。 */
export async function fetchAccessToken(args: {
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}): Promise<string> {
  return withRetry('获取AccessToken', async () => {
    const qs = new URLSearchParams({ client_id: args.clientId, client_secret: args.clientSecret });
    const data = await httpGetJson(`${BASE}${TOKEN_EP}?${qs.toString()}`, args.timeoutMs);
    if (Number(data?.errno) !== 0) throw new UploadError(data?.errno ?? -1, safeErrMsg(data));
    return String(data?.data?.access_token ?? '');
  });
}

/** 拉取线上应用信息的 data 对象（用于 enrich 合并 / 查询审核态）。 */
export async function fetchAppInfoData(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  timeoutMs: number;
}): Promise<Record<string, any>> {
  return withRetry('获取应用信息', async () => {
    const q: Record<string, string> = {
      pkg_name: args.packageName,
      access_token: args.accessToken,
      timestamp: nowSec(),
    };
    const api_sign = signOppo(q, args.clientSecret);
    const qs = new URLSearchParams({ ...q, api_sign });
    const data = await httpGetJson(`${BASE}${APP_INFO_EP}?${qs.toString()}`, args.timeoutMs);
    if (Number(data?.errno) !== 0) throw new UploadError(data?.errno ?? -1, safeErrMsg(data));
    return (data?.data ?? {}) as Record<string, any>;
  });
}

/** 获取上传地址：返回 { sign, uploadUrl }。 */
async function getUploadUrl(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  timeoutMs: number;
}): Promise<{ sign: string; uploadUrl: string }> {
  const q: Record<string, string> = {
    pkg_name: args.packageName,
    access_token: args.accessToken,
    timestamp: nowSec(),
  };
  const api_sign = signOppo(q, args.clientSecret);
  const qs = new URLSearchParams({ ...q, api_sign });
  const data = await httpGetJson(`${BASE}${UPLOAD_URL_EP}?${qs.toString()}`, args.timeoutMs);
  if (Number(data?.errno) !== 0) throw new UploadError(data?.errno ?? -1, safeErrMsg(data));
  return { sign: String(data?.data?.sign ?? ''), uploadUrl: String(data?.data?.upload_url ?? '') };
}

/** 通用资源直传（get-upload-url → multipart），返回服务端 url。type: apk/resource/photo。 */
async function uploadFile(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  type: string;
  bytes: Buffer;
  fileName: string;
  timeoutMs: number;
}): Promise<string> {
  return withRetry(`上传(${args.type})`, async () => {
    const { sign, uploadUrl } = await getUploadUrl({
      clientSecret: args.clientSecret,
      packageName: args.packageName,
      accessToken: args.accessToken,
      timeoutMs: args.timeoutMs,
    });
    const fields: Record<string, string> = { type: args.type, sign, timestamp: nowSec() };
    fields.api_sign = signOppo(fields, args.clientSecret);
    const data = await postMultipart(
      uploadUrl,
      fields,
      args.bytes,
      args.fileName,
      Math.max(args.timeoutMs, BIG_UPLOAD_MIN_MS),
    );
    return String(data?.data?.url ?? '');
  });
}

/** 上传 APK，返回服务端 url。 */
export async function uploadApkFile(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  apkBytes: Buffer;
  fileName: string;
  timeoutMs: number;
}): Promise<string> {
  return uploadFile({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken: args.accessToken,
    type: 'apk',
    bytes: args.apkBytes,
    fileName: args.fileName,
    timeoutMs: args.timeoutMs,
  });
}

/** 上传应用图标（512×512 PNG）为 photo 类型资源，返回服务端图标 url（用作 submit 的 icon_url）。 */
export async function uploadIconFile(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  iconBytes: Buffer;
  timeoutMs: number;
}): Promise<string> {
  return uploadFile({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken: args.accessToken,
    type: 'photo', // 图标使用 photo 资源类型。
    bytes: args.iconBytes,
    fileName: 'icon.png',
    timeoutMs: args.timeoutMs,
  });
}

/** 上传单张竖版截图（PNG）为 photo 类型资源，返回服务端图片 url（用作 submit 的 pic_url）。 */
export async function uploadScreenshotFile(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  bytes: Buffer;
  index: number;
  timeoutMs: number;
}): Promise<string> {
  return uploadFile({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken: args.accessToken,
    type: 'photo', // 截图与图标同走 photo 资源类型。
    bytes: args.bytes,
    fileName: `screenshot-${args.index + 1}.png`,
    timeoutMs: args.timeoutMs,
  });
}

/** 下载软著证书文件并以 resource 类型上传到 OPPO，返回服务端 url。 */
export async function uploadOtherCertificate(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  certUrl: string;
  timeoutMs: number;
}): Promise<string> {
  const res = await fetch(args.certUrl, { signal: AbortSignal.timeout(Math.max(args.timeoutMs, BIG_UPLOAD_MIN_MS)) });
  if (!res.ok) {
    throw new UploadError(res.status, `下载软著证书失败: ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const fileName = args.certUrl.split('/').pop() || 'certificate.zip';
  return uploadFile({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken: args.accessToken,
    type: 'resource',
    bytes,
    fileName,
    timeoutMs: args.timeoutMs,
  });
}

/** 合并线上应用信息与本次更新字段。 */
async function enrich(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  body: Record<string, string>;
  timeoutMs: number;
}): Promise<Record<string, string>> {
  const data = await fetchAppInfoData({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken: args.accessToken,
    timeoutMs: args.timeoutMs,
  });

  const result: Record<string, string> = {};
  for (const k of APP_INFO_KEYS) {
    const v = data[k];
    if (v !== undefined && v !== null) result[k] = String(v);
  }
  if (data.app_name !== undefined && data.app_name !== null) result.app_name = String(data.app_name);

  // 历史未设置过适配方式时 API 返回 "0"，是非法值，需移除。
  if (result.adaptive_type === '0') delete result.adaptive_type;

  // copyright_url 为空且 electronic_cert_url 不为空时，用后者兜底。
  if ((result.copyright_url === undefined || result.copyright_url === '') && result.electronic_cert_url) {
    result.copyright_url = result.electronic_cert_url;
  }

  // 合并本次更新字段（覆盖线上）。
  Object.assign(result, args.body);
  return result;
}

/** 提交应用更新（app/upd，即提交审核）。 */
export async function submitUpdate(args: {
  clientSecret: string;
  packageName: string;
  accessToken: string;
  apkInfo: { url: string; md5: string; cpu_code: number };
  versionCode: string;
  updateDesc: string;
  privacyUrl?: string;
  iconUrl?: string;
  otherCertUrl?: string;
  appName?: string;
  /** 一句话简介（覆盖线上 summary，OPPO ≤13 字符且禁标点空格） */
  summary?: string;
  /** 应用简介 / 长描述（覆盖线上 detail_desc） */
  description?: string;
  /** 竖版截图 url 串（覆盖线上 pic_url，多张由调用方拼好） */
  picUrl?: string;
  timeoutMs: number;
}): Promise<void> {
  // app/upd 为「提交发版」，非幂等：不自动重试（下方 postForm 传 retries=0），避免重复提交。
  // app/upd 仍是整个流程的最后一步。
  const body: Record<string, string> = {
    access_token: args.accessToken,
    apk_url: JSON.stringify([args.apkInfo]),
    online_type: '1', // 及时发布（审核通过后立即上线）
    timestamp: nowSec(),
    pkg_name: args.packageName,
    update_desc: args.updateDesc,
    version_code: args.versionCode,
  };
  if (args.privacyUrl) body.privacy_source_url = args.privacyUrl;
  // 文案：仅当传入时覆盖 enrich 合并进来的线上值，否则沿用线上（按需生效）。
  if (args.appName) body.app_name = args.appName;
  if (args.summary) body.summary = args.summary;
  if (args.description) body.detail_desc = args.description;
  // 截图：有上传后的竖版 pic_url 串才覆盖，否则沿用线上 pic_url。
  if (args.picUrl) body.pic_url = args.picUrl;
  // 图标：有上传后的 OPPO 图标 url 才带 icon_url（覆盖 enrich 合并进来的线上 icon_url）；
  if (args.iconUrl) body.icon_url = args.iconUrl;

  const resultBody = await enrich({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken: args.accessToken,
    body,
    timeoutMs: args.timeoutMs,
  });

  // 软著证书：优先用线上已有值；否则若传入 certUrl 则下载并上传换取 OPPO 链接；都没有则移除该字段。
  const serverCert = resultBody.other_cetificate_url;
  if (serverCert && serverCert.length > 0) {
    // 线上已有有效证书链接，直接复用（已在 resultBody 中）。
  } else if (args.otherCertUrl && args.otherCertUrl.length > 0) {
    resultBody.other_cetificate_url = await uploadOtherCertificate({
      clientSecret: args.clientSecret,
      packageName: args.packageName,
      accessToken: args.accessToken,
      certUrl: args.otherCertUrl,
      timeoutMs: args.timeoutMs,
    });
  } else {
    delete resultBody.other_cetificate_url;
  }

  resultBody.api_sign = signOppo(resultBody, args.clientSecret);
  // app/upd 为提交发版（非幂等）→ retries=0，关闭 postForm 的自动重试，避免重复提交。
  const data = await postForm(`${BASE}${APP_UPD_EP}`, resultBody, args.timeoutMs, 0);
  if (Number(data?.errno) !== 0) {
    throw new UploadError(data?.errno ?? -1, safeErrMsg(data));
  }
}

/** 完整传报：token → 上传 APK → enrich+提交更新（即提交审核）。 */
export async function uploadOppo(args: {
  clientId: string;
  clientSecret: string;
  packageName: string;
  versionCode: string;
  apkPath: string;
  updateDesc: string;
  privacyUrl?: string;
  iconBytes?: Buffer;
  otherCertificateUrl?: string;
  /** 文案（按需覆盖线上 app_name/summary/detail_desc） */
  appName?: string;
  summary?: string;
  description?: string;
  /** 竖版截图 PNG 字节列表（已按渠道处理）；非空时上传并覆盖 pic_url */
  screenshotBytes?: Buffer[];
  timeoutMs: number;
}): Promise<void> {
  const apkBytes = await readFile(args.apkPath);
  const md5sum = md5Hex(apkBytes);

  const accessToken = await fetchAccessToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    timeoutMs: args.timeoutMs,
  });

  const apkUrl = await uploadApkFile({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken,
    apkBytes,
    fileName: basename(args.apkPath),
    timeoutMs: args.timeoutMs,
  });

  // 仅当传入图标字节时才上传图标换取 OPPO 图标 url；否则不带 icon_url，沿用线上图标。
  let iconUrl: string | undefined;
  if (args.iconBytes && args.iconBytes.length > 0) {
    iconUrl = await uploadIconFile({
      clientSecret: args.clientSecret,
      packageName: args.packageName,
      accessToken,
      iconBytes: args.iconBytes,
      timeoutMs: args.timeoutMs,
    });
  }

  // 仅当传入截图字节时才逐张上传换取 OPPO 图片 url；否则不带 pic_url，沿用线上截图。
  let picUrl: string | undefined;
  if (args.screenshotBytes && args.screenshotBytes.length > 0) {
    const urls: string[] = [];
    for (let i = 0; i < args.screenshotBytes.length; i++) {
      urls.push(
        await uploadScreenshotFile({
          clientSecret: args.clientSecret,
          packageName: args.packageName,
          accessToken,
          bytes: args.screenshotBytes[i],
          index: i,
          timeoutMs: args.timeoutMs,
        }),
      );
    }
    // 多张竖版 url 以逗号拼接覆盖 pic_url（与 enrich 对数组字段 String() 序列化的口径一致）。
    // 待联调：OPPO app/upd 对 pic_url 的确切分隔/JSON 形态需以真实 app/info 回环为准。
    picUrl = urls.join(',');
  }

  await submitUpdate({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken,
    apkInfo: { url: apkUrl, md5: md5sum, cpu_code: 0 },
    versionCode: args.versionCode,
    updateDesc: args.updateDesc,
    privacyUrl: args.privacyUrl,
    iconUrl,
    otherCertUrl: args.otherCertificateUrl,
    appName: args.appName,
    summary: args.summary,
    description: args.description,
    picUrl,
    timeoutMs: args.timeoutMs,
  });
}

/** 查询审核状态：返回审核态名称、state 与线上版本号。 */
export async function queryOppoStatus(args: {
  clientId: string;
  clientSecret: string;
  packageName: string;
  timeoutMs: number;
}): Promise<{ auditName: string; state: string; versionName?: string; versionCode?: string }> {
  const accessToken = await fetchAccessToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    timeoutMs: args.timeoutMs,
  });
  const data = await fetchAppInfoData({
    clientSecret: args.clientSecret,
    packageName: args.packageName,
    accessToken,
    timeoutMs: args.timeoutMs,
  });
  return {
    auditName: String(data.audit_status_name ?? ''),
    state: String(data.state ?? ''),
    versionName: data.version_name != null ? String(data.version_name) : undefined,
    versionCode: data.version_code != null ? String(data.version_code) : undefined,
  };
}
