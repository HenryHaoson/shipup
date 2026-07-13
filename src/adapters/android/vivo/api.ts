// 接口：统一网关 https://developer-api.vivo.com.cn/router/rest（multipart/form-data，method 区分动作）。
// 流程：app.upload.icon（取 icon serialnumber，可选）→ app.upload.screenshot（取截图 serialnumber，可选，多张）
//      → app.upload.apk.app（取 apk serialnumber）→ app.sync.update.app（提交版本更新，即提交审核）。
// 市场元数据按需更新：app.sync.update.app 额外携带 app_name/simpleDesc/detailDesc/icon/screenshot 等字段，
// 仅当对应入参有值时下发，否则保持商店现有内容。
// 状态：app.query.details 返回 status / saleStatus，由 index.ts 映射到 NormalizedStatus。
import { readFile } from 'node:fs/promises';
import { hmacSha256Hex, md5Hex } from '../../../infra/crypto.js';
import { withRetry } from '../../../infra/http.js';
import { UploadError } from '../../../core/types.js';

const ENDPOINT = 'https://developer-api.vivo.com.cn/router/rest';

/**
 * 端口自 package:collection 的 compareAsciiUpperCase：忽略大小写的 ASCII 序。
 * 仅当两个字符大写形式相同（如 'a' 与 'A'）时，才以原始码点差作为次序裁决。
 * vivo 的参数签名按此规则排序 key，与 QQ 的纯 ASCII 排序不同（务必保留）。
 */
function compareAsciiUpperCase(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let defaultResult = 0;
  for (let i = 0; i < limit; i++) {
    const aChar = a.charCodeAt(i);
    const bChar = b.charCodeAt(i);
    if (aChar === bChar) continue;
    let aUpper = aChar;
    let bUpper = bChar;
    if (aChar >= 97 && aChar <= 122) aUpper -= 32; // 'a'..'z' -> 'A'..'Z'
    if (bChar >= 97 && bChar <= 122) bUpper -= 32;
    if (aUpper !== bUpper) return Math.sign(aUpper - bUpper);
    if (defaultResult === 0) defaultResult = aChar - bChar;
  }
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return Math.sign(defaultResult);
}

/**
 * vivo 签名：除 sign 外的全部参数按 key（忽略大小写 ASCII 序）升序拼 k=v&...，
 */
export function signVivo(params: Record<string, string>, accessSecret: string): string {
  const str = Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort(compareAsciiUpperCase)
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return hmacSha256Hex(accessSecret, str);
}

/**
 * WHATWG FormData 会在 multipart 序列化时把文本字段中的 CR/LF 统一为 CRLF。
 * vivo 服务端按实际收到的字段值重算签名，因此必须在签名前做相同规范化；
 * 否则多行 updateDesc/detailDesc 会因签名原文与线上字节不一致而返回 10001。
 */
function normalizeMultipartParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([k]) => k !== 'sign')
      .map(([k, v]) => [k, v.replace(/\r\n|\r|\n/g, '\r\n')]),
  );
}

/** 网关公共参数（timestamp 为毫秒，与 QQ 的秒不同）。 */
function commonParams(accessKey: string, method: string): Record<string, string> {
  return {
    access_key: accessKey,
    format: 'json',
    timestamp: String(Date.now()),
    sign_method: 'hmac',
    method,
    v: '1.0',
    target_app_key: 'developer',
  };
}

/** 统一 multipart POST：补 sign → 发请求 → 校验 code===0 && subCode==='0'。 */
async function postMultipart(
  params: Record<string, string>,
  accessSecret: string,
  timeoutMs: number,
  file?: { field: string; bytes: Uint8Array; filename: string },
): Promise<any> {
  const signedParams = normalizeMultipartParams(params);
  signedParams.sign = signVivo(signedParams, accessSecret);
  const form = new FormData();
  for (const [k, v] of Object.entries(signedParams)) form.append(k, v);
  if (file) {
    form.append(file.field, new Blob([file.bytes]), file.filename);
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new UploadError(res.status, `http ${res.status}: ${text.slice(0, 500)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UploadError('parse', `非 JSON 响应: ${text.slice(0, 500)}`);
  }
  if (Number(data?.code) !== 0 || String(data?.subCode) !== '0') {
    const code = data?.subCode ?? data?.code ?? -1;
    throw new UploadError(String(code), String(data?.msg ?? data?.errorReason ?? 'unknown'));
  }
  return data;
}

/** 上传图标，返回 serialnumber（method=app.upload.icon）。 */
export async function uploadIcon(args: {
  accessKey: string;
  accessSecret: string;
  packageName: string;
  iconBytes: Uint8Array;
  timeoutMs: number;
}): Promise<string> {
  const params: Record<string, string> = {
    packageName: args.packageName,
    ...commonParams(args.accessKey, 'app.upload.icon'),
  };
  const data = await postMultipart(params, args.accessSecret, args.timeoutMs, {
    field: 'file',
    bytes: args.iconBytes,
    filename: 'icon.png',
  });
  return String(data?.data?.serialnumber ?? '');
}

/** 上传单张截图，返回 serialnumber（method=app.upload.screenshot，沿用 icon 的 multipart file 实现）。 */
export async function uploadScreenshot(args: {
  accessKey: string;
  accessSecret: string;
  packageName: string;
  screenshotBytes: Uint8Array;
  filename: string;
  timeoutMs: number;
}): Promise<string> {
  const params: Record<string, string> = {
    packageName: args.packageName,
    ...commonParams(args.accessKey, 'app.upload.screenshot'),
  };
  const data = await postMultipart(params, args.accessSecret, args.timeoutMs, {
    field: 'file',
    bytes: args.screenshotBytes,
    filename: args.filename,
  });
  return String(data?.data?.serialnumber ?? '');
}

/** 上传 APK，返回 serialnumber（method=app.upload.apk.app；fileMd5 参与签名）。 */
export async function uploadApk(args: {
  accessKey: string;
  accessSecret: string;
  packageName: string;
  apkBytes: Uint8Array;
  apkMd5: string;
  timeoutMs: number;
}): Promise<string> {
  const params: Record<string, string> = {
    packageName: args.packageName,
    fileMd5: args.apkMd5,
    ...commonParams(args.accessKey, 'app.upload.apk.app'),
  };
  const data = await postMultipart(params, args.accessSecret, args.timeoutMs, {
    field: 'file',
    bytes: args.apkBytes,
    filename: `${args.packageName}.apk`,
  });
  return String(data?.data?.serialnumber ?? '');
}

/** 提交版本更新（method=app.sync.update.app）。onlineType=1 上线、compatibleDevice=2 全机型。 */
export async function syncUpdateApp(args: {
  accessKey: string;
  accessSecret: string;
  packageName: string;
  versionCode: string;
  apkMd5: string;
  apkSerialNumber: string;
  iconSerialNumber?: string;
  appName?: string;
  summary?: string;
  description?: string;
  updateDesc: string;
  privacyUrl?: string;
  /** 多张截图 serialnumber 逗号拼接 */
  screenshot?: string;
  timeoutMs: number;
}): Promise<void> {
  const params: Record<string, string> = {
    packageName: args.packageName,
    versionCode: args.versionCode,
    fileMd5: args.apkMd5,
    onlineType: '1',
    updateDesc: args.updateDesc,
    compatibleDevice: '2',
    apk: args.apkSerialNumber,
    ...commonParams(args.accessKey, 'app.sync.update.app'),
  };
  if (args.privacyUrl) params.privateSelfCheckUrl = args.privacyUrl;
  if (args.appName) params.app_name = args.appName;
  if (args.summary) params.simpleDesc = args.summary;
  if (args.description) params.detailDesc = args.description;
  if (args.iconSerialNumber) params.icon = args.iconSerialNumber;
  if (args.screenshot) params.screenshot = args.screenshot;
  await postMultipart(params, args.accessSecret, args.timeoutMs);
}

/** 查询应用详情（method=app.query.details），返回审核/在售状态用于映射。 */
export async function queryAppDetails(args: {
  accessKey: string;
  accessSecret: string;
  packageName: string;
  timeoutMs: number;
}): Promise<{ status: number | null; saleStatus: number | null; marketVersion?: string }> {
  const params: Record<string, string> = {
    packageName: args.packageName,
    ...commonParams(args.accessKey, 'app.query.details'),
  };
  // app.query.details 为幂等读操作，瞬时失败可安全重试。
  const data = await withRetry(
    () => postMultipart(params, args.accessSecret, args.timeoutMs),
    { label: 'vivo query' },
  );
  const d = data?.data ?? {};
  // 线上版本号字段名以官方为准，做兜底取值；取不到则不填 marketVersion。
  const versionRaw = d.onlineVersion ?? d.versionName ?? d.version;
  return {
    status: d.status != null ? Number(d.status) : null,
    saleStatus: d.saleStatus != null ? Number(d.saleStatus) : null,
    marketVersion:
      versionRaw != null && String(versionRaw) !== '' ? String(versionRaw) : undefined,
  };
}

/** 完整传报：上传图标（可选）→ 上传 APK → 提交更新（即提交审核）。 */
export async function uploadVivo(args: {
  accessKey: string;
  accessSecret: string;
  packageName: string;
  versionCode: string;
  apkPath: string;
  updateDesc: string;
  privacyUrl?: string;
  appName?: string;
  summary?: string;
  description?: string;
  iconBytes?: Uint8Array;
  screenshotBytesList?: Uint8Array[];
  timeoutMs: number;
}): Promise<void> {
  const apkBytes = await readFile(args.apkPath);
  const md5sum = md5Hex(apkBytes);
  // 大文件上传：超时取 max(ctx.timeoutMs, 900000)
  const uploadTimeout = Math.max(args.timeoutMs, 900000);

  let iconSerial: string | undefined;
  if (args.iconBytes && args.iconBytes.length > 0) {
    iconSerial = await uploadIcon({
      accessKey: args.accessKey,
      accessSecret: args.accessSecret,
      packageName: args.packageName,
      iconBytes: args.iconBytes,
      timeoutMs: args.timeoutMs,
    });
  }

  // 截图：逐张上传取 serialnumber，多张以逗号拼接填入 app.sync.update.app 的 screenshot 字段。
  let screenshotSerials: string | undefined;
  if (args.screenshotBytesList && args.screenshotBytesList.length > 0) {
    const serials: string[] = [];
    for (let i = 0; i < args.screenshotBytesList.length; i++) {
      const serial = await uploadScreenshot({
        accessKey: args.accessKey,
        accessSecret: args.accessSecret,
        packageName: args.packageName,
        screenshotBytes: args.screenshotBytesList[i],
        filename: `screenshot_${i + 1}.jpg`,
        timeoutMs: args.timeoutMs,
      });
      serials.push(serial);
    }
    screenshotSerials = serials.join(',');
  }

  const apkSerial = await uploadApk({
    accessKey: args.accessKey,
    accessSecret: args.accessSecret,
    packageName: args.packageName,
    apkBytes,
    apkMd5: md5sum,
    timeoutMs: uploadTimeout,
  });

  await syncUpdateApp({
    accessKey: args.accessKey,
    accessSecret: args.accessSecret,
    packageName: args.packageName,
    versionCode: args.versionCode,
    apkMd5: md5sum,
    apkSerialNumber: apkSerial,
    iconSerialNumber: iconSerial,
    appName: args.appName,
    summary: args.summary,
    description: args.description,
    updateDesc: args.updateDesc,
    privacyUrl: args.privacyUrl,
    screenshot: screenshotSerials,
    timeoutMs: args.timeoutMs,
  });
}
