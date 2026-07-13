// 文档：https://developer.samsung.com/galaxy-store/galaxy-store-developer-api/content-publish-api/overview.html
// 鉴权：用 private_key（RSA PEM）对 service_account 签 RS256 JWT，POST /auth/accessToken 换 accessToken。
// 上传流程：换 token → contentInfo 取应用现状 → createUploadSessionId + multipart fileUpload 上传 APK
//          → contentUpdate（元数据/更新说明，进 REGISTERING）→ addNewBinary(v2 挂 APK) → contentSubmit 提审。
// 注：三星 2025-03 弃用、2026-07 起彻底拒绝 contentUpdate.binaryList，二进制变更改走 POST /seller/v2/content/binary。
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createSign } from 'node:crypto';
import { UploadError } from '../../../core/types.js';
import { withRetry } from '../../../infra/http.js';

const AUTH_URL = 'https://devapi.samsungapps.com/auth/accessToken';
const SESSION_URL = 'https://devapi.samsungapps.com/seller/createUploadSessionId';
const FILE_UPLOAD_URL = 'https://seller.samsungapps.com/galaxyapi/fileUpload';
const CONTENT_INFO_URL = 'https://devapi.samsungapps.com/seller/contentInfo';
const CONTENT_UPDATE_URL = 'https://devapi.samsungapps.com/seller/contentUpdate';
const CONTENT_SUBMIT_URL = 'https://devapi.samsungapps.com/seller/contentSubmit';
// 三星 2025-03 弃用、2026-07 起彻底拒绝 contentUpdate.binaryList；二进制变更改走此 v2 API。
const CONTENT_BINARY_URL = 'https://devapi.samsungapps.com/seller/v2/content/binary';

/** fileUpload 返回的文件信息 */
export interface FileInfo {
  fileKey: string;
  fileName: string;
  fileSize: string;
}

/** contentInfo 返回的单个 app 信息（仅建模需要回写的字段）。 */
interface Binary {
  filekey?: string | null;
  binarySeq: string;
  gms: string;
  versionCode?: string | null;
  versionName?: string | null;
  packageName?: string | null;
}

interface AppInfo {
  binaryList: Binary[];
  usExportLaws: boolean;
  defaultLanguageCode: string;
  paid: string;
  /** 年龄分级（线上值，回填以免每次提交重置） */
  ageLimit: string;
  /** 中国大陆年龄分级（线上值，回填以免每次提交重置） */
  chinaAgeLimit: string;
  /** 发布类型（线上值，回填以免每次提交重置） */
  publicationType: string;
  /** 应用整体状态，例如 REGISTERING/FOR_SALE/REJECTED 等 */
  contentStatus?: string;
}

/** 三星推断出的线上/最新版本信息 */
export interface SamsungOnlineInfo {
  contentStatus?: string;
  onlineVersionName?: string;
  onlineVersionCode?: string;
  latestVersionName?: string;
  latestVersionCode?: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * - 算法 RS256（RSA-SHA256，PKCS#1 v1.5），header = { alg:'RS256', typ:'JWT' }
 * - claims：iss=service_account，scopes=['publishing']，iat=now，exp=now+15min（秒）
 */
export function signSamsungJwt(serviceAccount: string, privateKey: string): string {
  const now = Math.round(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount,
    scopes: ['publishing'],
    iat: now,
    exp: now + 60 * 15,
  };
  const pem = privateKey.replace(/\\n/g, '\n');
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(
    Buffer.from(JSON.stringify(payload)),
  )}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(pem);
  return `${signingInput}.${base64url(signature)}`;
}

/** 用 JWT 换 accessToken。 */
export async function fetchAccessToken(args: {
  serviceAccount: string;
  privateKey: string;
  timeoutMs: number;
}): Promise<string> {
  const token = signSamsungJwt(args.serviceAccount, args.privateKey);
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON，data 留空，走下方报错 */
  }
  if (res.status === 200 && data?.ok && data?.createdItem?.accessToken) {
    return String(data.createdItem.accessToken);
  }
  throw new UploadError(res.status, `accessToken 获取失败: ${text.slice(0, 300)}`);
}

function authHeaders(accessToken: string, serviceAccount: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'service-account-id': serviceAccount,
  };
}

/** 创建上传 session 并 multipart 上传一段字节，返回 fileKey 等信息（APK 与图标共用此逻辑）。 */
async function uploadBytes(args: {
  accessToken: string;
  serviceAccount: string;
  bytes: Buffer;
  fileName: string;
  timeoutMs: number;
}): Promise<FileInfo> {
  // 1. 取 sessionId（幂等：每次创建全新 session，失败即未生效，可重试）
  const sessionId = await withRetry(
    async () => {
      const sessRes = await fetch(SESSION_URL, {
        method: 'POST',
        headers: authHeaders(args.accessToken, args.serviceAccount),
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      const sessText = await sessRes.text();
      if (sessRes.status !== 200) {
        throw new UploadError(
          sessRes.status,
          `createUploadSessionId 失败: ${sessText.slice(0, 300)}`,
        );
      }
      let sessData: any;
      try {
        sessData = JSON.parse(sessText);
      } catch {
        throw new UploadError(
          sessRes.status,
          `createUploadSessionId 非 JSON 响应: ${sessText.slice(0, 300)}`,
        );
      }
      return String(sessData.sessionId);
    },
    { label: 'samsung createUploadSessionId' },
  );

  // 2. multipart 上传（大文件，超时放宽到 >= 15min）
  const form = new FormData();
  form.append('sessionId', sessionId);
  // 不手动设置 Content-Type，交给 fetch 生成带 boundary 的 multipart/form-data。
  form.append('file', new Blob([args.bytes]), args.fileName);
  const uploadTimeout = Math.max(args.timeoutMs, 900000);
  const upRes = await fetch(FILE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      'service-account-id': args.serviceAccount,
    },
    body: form,
    signal: AbortSignal.timeout(uploadTimeout),
  });
  const upText = await upRes.text();
  if (upRes.status !== 200) {
    throw new UploadError(upRes.status, `fileUpload 失败: ${upText.slice(0, 300)}`);
  }
  let data: any;
  try {
    data = JSON.parse(upText);
  } catch {
    throw new UploadError(upRes.status, `fileUpload 非 JSON 响应: ${upText.slice(0, 300)}`);
  }
  if (!data?.fileKey) {
    throw new UploadError(data?.errorCode ?? 'upload', `fileUpload 无 fileKey: ${upText.slice(0, 300)}`);
  }
  return {
    fileKey: String(data.fileKey),
    fileName: String(data.fileName ?? ''),
    fileSize: String(data.fileSize ?? ''),
  };
}

/** 创建上传 session 并 multipart 上传单个文件（从路径读字节），返回 fileKey 等信息。 */
export async function uploadFile(args: {
  accessToken: string;
  serviceAccount: string;
  filePath: string;
  timeoutMs: number;
}): Promise<FileInfo> {
  const bytes = await readFile(args.filePath);
  return uploadBytes({
    accessToken: args.accessToken,
    serviceAccount: args.serviceAccount,
    bytes,
    fileName: basename(args.filePath),
    timeoutMs: args.timeoutMs,
  });
}

/** GET contentInfo，返回原始数组（每个元素是一个 app 的信息）。 */
async function fetchContentInfoRaw(args: {
  accessToken: string;
  serviceAccount: string;
  appId: string;
  timeoutMs: number;
}): Promise<any[]> {
  // 幂等 GET：瞬时失败（5xx/429/网络/超时）可安全重试。
  return withRetry(
    async () => {
      const res = await fetch(`${CONTENT_INFO_URL}?contentId=${encodeURIComponent(args.appId)}`, {
        method: 'GET',
        headers: authHeaders(args.accessToken, args.serviceAccount),
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      const text = await res.text();
      if (res.status !== 200) {
        throw new UploadError(res.status, `contentInfo 失败: ${text.slice(0, 300)}`);
      }
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new UploadError(res.status, `contentInfo 非 JSON 响应: ${text.slice(0, 300)}`);
      }
      return Array.isArray(parsed) ? parsed : [];
    },
    { label: 'samsung contentInfo' },
  );
}

/** 把 contentInfo 返回的原始 binary 规整为回写 contentUpdate 所需的字段。 */
function normalizeBinary(raw: any): Binary {
  return {
    filekey: raw?.filekey ?? null,
    binarySeq: String(raw?.binarySeq ?? ''),
    gms: String(raw?.gms ?? 'N'),
    versionCode: raw?.versionCode ?? null,
    versionName: raw?.versionName ?? null,
    packageName: raw?.packageName ?? null,
  };
}

/**
 * 新增 binary（三星 v2 Binary API，替代已弃用的 contentUpdate.binaryList）。
 * 只需 contentId + filekey + gms；versionCode/versionName/packageName 三星从 APK 自身读取。
 * 要求 app 处于 REGISTERING 态——contentUpdate 已使其进入。成功返回 200（data 含 binarySeq）。
 */
async function addNewBinary(args: {
  accessToken: string;
  serviceAccount: string;
  contentId: string;
  fileKey: string;
  gms: string;
  timeoutMs: number;
}): Promise<void> {
  const res = await fetch(CONTENT_BINARY_URL, {
    method: 'POST',
    headers: authHeaders(args.accessToken, args.serviceAccount),
    body: JSON.stringify({ contentId: args.contentId, filekey: args.fileKey, gms: args.gms }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new UploadError(res.status, `addNewBinary 失败: ${t.slice(0, 300)}`);
  }
}

/**
 * 完整传报：换 token → 取 contentInfo → 上传 APK → contentUpdate（元数据，进 REGISTERING）
 * → addNewBinary（挂 APK）→ contentSubmit。
 * 图标：与 APK 共用 session 文件上传（uploadFile/fileUpload）机制，得 fileKey 后以 iconKey 写入 contentUpdate body。
 *      仅当传入 iconBytes 时才上传并带 iconKey；缺失时不带（不报错，沿用商店现有图标）。
 * 文案：appTitle / shortDescription / longDescription 均「按需生效」——仅当对应入参有值才写入 body，
 *      否则保持现有行为（仅 newFeature）。三星按 UTF-8 字节计，长度告警在上层 index.ts 处理。
 */
export async function uploadSamsung(args: {
  appId: string;
  serviceAccount: string;
  privateKey: string;
  apkPath: string;
  iconBytes?: Buffer;
  /** 截图字节列表 → contentUpdate.screenshots（可选，按需下发新图） */
  screenshotBytesList?: Buffer[];
  /** 应用名称 → contentUpdate.appTitle（可选，按需下发） */
  appTitle?: string;
  /** 一句话简介 → contentUpdate.shortDescription（可选，按需下发） */
  shortDescription?: string;
  /** 长描述 → contentUpdate.longDescription（可选，按需下发） */
  longDescription?: string;
  updateDesc: string;
  privacyUrl: string;
  timeoutMs: number;
}): Promise<void> {
  const accessToken = await fetchAccessToken({
    serviceAccount: args.serviceAccount,
    privateKey: args.privateKey,
    timeoutMs: args.timeoutMs,
  });

  const list = await fetchContentInfoRaw({
    accessToken,
    serviceAccount: args.serviceAccount,
    appId: args.appId,
    timeoutMs: args.timeoutMs,
  });
  if (list.length === 0) {
    throw new UploadError('contentInfo', `contentInfo 返回空，contentId=${args.appId}`);
  }
  const rawApp: any = list[0];
  const appInfo: AppInfo = {
    binaryList: Array.isArray(rawApp.binaryList) ? rawApp.binaryList.map(normalizeBinary) : [],
    usExportLaws: Boolean(rawApp.usExportLaws),
    defaultLanguageCode: String(rawApp.defaultLanguageCode ?? ''),
    paid: String(rawApp.paid ?? 'N'),
    // 分级/发布类型优先回填线上值，缺失再兜底常量，避免每次提交把线上分级重置为 '12'/'01'。
    ageLimit: String(rawApp.ageLimit ?? '12'),
    chinaAgeLimit: String(rawApp.chinaAgeLimit ?? '12'),
    publicationType: String(rawApp.publicationType ?? '01'),
    contentStatus: rawApp.contentStatus,
  };

  const body: Record<string, unknown> = {
    contentId: args.appId,
    newFeature: args.updateDesc,
    ageLimit: appInfo.ageLimit,
    chinaAgeLimit: appInfo.chinaAgeLimit,
    usExportLaws: appInfo.usExportLaws,
    defaultLanguageCode: appInfo.defaultLanguageCode,
    paid: appInfo.paid,
    addLanguage: null,
    sellCountryList: null,
    privatePolicyURL: args.privacyUrl,
    // 截图默认 null = 沿用线上；ctx.screenshots 非空时下方上传后覆盖为对象数组。
    screenshots: null,
    // 文档未列出，但实测为 required 字段
    publicationType: appInfo.publicationType,
  };

  // 文案按需生效：仅当对应入参有值才写入 body（三星支持 appTitle/shortDescription/longDescription），
  // 不传则不带该字段，沿用商店现有文案，绝不破坏现有「仅 newFeature」的上传+提审。
  if (args.appTitle) body.appTitle = args.appTitle;
  if (args.shortDescription) body.shortDescription = args.shortDescription;
  if (args.longDescription) body.longDescription = args.longDescription;

  // 上传新 APK，得 fileKey（binary 不再随 contentUpdate 提交，改用下方 addNewBinary v2 API 挂载）。
  const apkFileInfo = await uploadFile({
    accessToken,
    serviceAccount: args.serviceAccount,
    filePath: args.apkPath,
    timeoutMs: args.timeoutMs,
  });

  // 可选：上传图标（与 APK 同一文件上传机制），成功后把 iconKey 写入 body；缺失则不带，沿用线上图标。
  if (args.iconBytes && args.iconBytes.length > 0) {
    const iconFileInfo = await uploadBytes({
      accessToken,
      serviceAccount: args.serviceAccount,
      bytes: args.iconBytes,
      fileName: 'icon.png',
      timeoutMs: args.timeoutMs,
    });
    body.iconKey = iconFileInfo.fileKey;
  }

  // 可选：上传截图（与图标同一文件上传机制）。官方 contentUpdate.screenshots 结构为对象数组：
  // [{ screenshotKey: fileKey, reuseYn: false }]，新图 reuseYn=false（reuseYn=true + key=null 表示复用线上）。
  if (args.screenshotBytesList && args.screenshotBytesList.length > 0) {
    const shots: Array<{ screenshotKey: string; reuseYn: boolean }> = [];
    for (let i = 0; i < args.screenshotBytesList.length; i++) {
      const shotInfo = await uploadBytes({
        accessToken,
        serviceAccount: args.serviceAccount,
        bytes: args.screenshotBytesList[i],
        fileName: `screenshot_${i + 1}.png`,
        timeoutMs: args.timeoutMs,
      });
      shots.push({ screenshotKey: shotInfo.fileKey, reuseYn: false });
    }
    body.screenshots = shots;
  }

  // contentUpdate：更新应用元数据（不再带 binaryList）；对 FOR_SALE 的 app 会使其进入 REGISTERING。
  const updateRes = await fetch(CONTENT_UPDATE_URL, {
    method: 'POST',
    headers: authHeaders(accessToken, args.serviceAccount),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (updateRes.status !== 200) {
    const t = await updateRes.text();
    throw new UploadError(updateRes.status, `contentUpdate 失败: ${t.slice(0, 300)}`);
  }

  // addNewBinary：app 已进入 REGISTERING，把上传好的 APK 挂上去（替代弃用的 contentUpdate.binaryList）。
  await addNewBinary({
    accessToken,
    serviceAccount: args.serviceAccount,
    contentId: args.appId,
    fileKey: apkFileInfo.fileKey,
    gms: 'N',
    timeoutMs: args.timeoutMs,
  });

  // contentSubmit：提审（成功返回 204）
  const submitRes = await fetch(CONTENT_SUBMIT_URL, {
    method: 'POST',
    headers: authHeaders(accessToken, args.serviceAccount),
    body: JSON.stringify({ contentId: args.appId }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (submitRes.status !== 204) {
    const t = await submitRes.text();
    throw new UploadError(submitRes.status, `contentSubmit 失败: ${t.slice(0, 300)}`);
  }
}

/**
 * - contentStatus 原样返回，供上层映射到 NormalizedStatus。
 * - 线上版本推断：审核中（非 FOR_SALE/REJECT 等）且 binary >= 2 时取倒数第二条为线上，否则取最新一条。
 */
export async function queryOnlineAndLatest(args: {
  appId: string;
  serviceAccount: string;
  privateKey: string;
  timeoutMs: number;
}): Promise<SamsungOnlineInfo> {
  const accessToken = await fetchAccessToken({
    serviceAccount: args.serviceAccount,
    privateKey: args.privateKey,
    timeoutMs: args.timeoutMs,
  });
  const list = await fetchContentInfoRaw({
    accessToken,
    serviceAccount: args.serviceAccount,
    appId: args.appId,
    timeoutMs: args.timeoutMs,
  });
  if (list.length === 0) {
    return {};
  }
  const rawApp: any = list[0];
  const binaryList: Binary[] = Array.isArray(rawApp.binaryList)
    ? rawApp.binaryList.map(normalizeBinary)
    : [];
  const contentStatus: string | undefined = rawApp.contentStatus;

  const latest = binaryList.length > 0 ? binaryList[binaryList.length - 1] : undefined;

  const s = (contentStatus ?? '').toUpperCase();
  const underReview =
    !!contentStatus &&
    s !== 'FOR_SALE' &&
    !s.includes('REJECT') &&
    s !== 'SUSPENDED' &&
    s !== 'TERMINATED';

  let online = latest;
  if (underReview && binaryList.length >= 2) {
    online = binaryList[binaryList.length - 2];
  }

  return {
    contentStatus,
    onlineVersionName: online?.versionName ?? undefined,
    onlineVersionCode: online?.versionCode ?? undefined,
    latestVersionName: latest?.versionName ?? undefined,
    latestVersionCode: latest?.versionCode ?? undefined,
  };
}
