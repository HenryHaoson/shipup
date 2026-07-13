// 文档：https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-References
// 流程：OAuth client_credentials 取 token → 取上传地址 → 上传 APK（multipart）
//      → app-file-info 绑定 → 更新 app-language-info（更新说明/名称/简介/描述，按需）
//      →（可选图标）→（可选截图，整组替换）→（可选绿标文件）→（可选隐私链接）→ 提交审核。
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { UploadError } from '../../../core/types.js';
import { withRetry } from '../../../infra/http.js';

const TOKEN_URL = 'https://connect-api.cloud.huawei.com/api/oauth2/v1/token';
const BASE = 'https://connect-api.cloud.huawei.com/api/publish/v2';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function authHeaders(clientId: string, accessToken: string): Record<string, string> {
  return {
    client_id: clientId,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

/** 通用 JSON 请求（GET/PUT/POST），非 200 抛 UploadError。 */
async function hwJson(
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  clientId: string,
  accessToken: string,
  bodyObj: unknown,
  timeoutMs: number,
): Promise<any> {
  const init: RequestInit = {
    method,
    headers: authHeaders(clientId, accessToken),
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (bodyObj !== undefined) init.body = JSON.stringify(bodyObj);
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new UploadError(res.status, `http ${res.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new UploadError('parse', `非 JSON 响应: ${text.slice(0, 300)}`);
  }
}

/** OAuth client_credentials 取 access_token。幂等，瞬时失败自动重试。 */
export async function fetchAccessToken(args: {
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}): Promise<string> {
  return withRetry(
    async () => {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: args.clientId,
          client_secret: args.clientSecret,
        }),
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) throw new UploadError(res.status, `token http ${res.status}: ${text.slice(0, 300)}`);
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new UploadError('parse', `token 非 JSON 响应: ${text.slice(0, 300)}`);
      }
      const token = data?.access_token;
      if (!token) throw new UploadError(String(data?.ret ?? 'token'), `取 token 失败: ${text.slice(0, 300)}`);
      return String(token);
    },
    { label: 'huawei token' },
  );
}

/** 取上传地址（含 authCode）。 */
async function getUploadUrl(args: {
  appId: string;
  suffix: string;
  clientId: string;
  accessToken: string;
  timeoutMs: number;
}): Promise<{ uploadUrl: string; authCode: string }> {
  // 取上传地址为幂等 GET，瞬时失败自动重试。
  const data = await withRetry(
    () =>
      hwJson(
        'GET',
        `${BASE}/upload-url?appId=${args.appId}&suffix=${args.suffix}`,
        args.clientId,
        args.accessToken,
        undefined,
        args.timeoutMs,
      ),
    { label: 'huawei get-upload-url' },
  );
  return { uploadUrl: String(data.uploadUrl), authCode: String(data.authCode) };
}

/** 取上传地址后 multipart 直传文件，返回 result.UploadFileRsp（含 fileInfoList）。 */
async function uploadFileToHuawei(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  bytes: Buffer;
  fileName: string;
  isImg: boolean;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<any> {
  const suffix = extname(args.fileName).replace('.', '');
  const urlInfo = await getUploadUrl({
    appId: args.appId,
    suffix,
    clientId: args.clientId,
    accessToken: args.accessToken,
    timeoutMs: args.timeoutMs,
  });

  const form = new FormData();
  form.append('authCode', urlInfo.authCode);
  form.append('fileCount', '1');
  form.append('parseType', args.isImg ? '1' : '0');
  form.append('file', new Blob([args.bytes]), args.fileName);

  // 注意：不要手动设置 Content-Type，交给 fetch 生成 multipart boundary。
  const res = await fetch(urlInfo.uploadUrl, {
    method: 'POST',
    headers: { client_id: args.clientId, Authorization: `Bearer ${args.accessToken}` },
    body: form,
    signal: AbortSignal.timeout(args.uploadTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new UploadError(res.status, `上传文件失败 ${res.status}: ${text.slice(0, 300)}`);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UploadError('parse', `上传文件非 JSON 响应: ${text.slice(0, 300)}`);
  }
  return data?.result?.UploadFileRsp;
}

/** 上传 APK 并通过 app-file-info 绑定（fileType=5）。 */
async function uploadApk(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  apkBytes: Buffer;
  apkName: string;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<void> {
  const rsp = await uploadFileToHuawei({
    appId: args.appId,
    clientId: args.clientId,
    accessToken: args.accessToken,
    bytes: args.apkBytes,
    fileName: args.apkName,
    isImg: false,
    uploadTimeoutMs: args.uploadTimeoutMs,
    timeoutMs: args.timeoutMs,
  });
  // rsp(UploadFileRsp) 或 fileInfoList 缺失时，直接抛带响应片段的 UploadError，
  // 避免后续 rsp.fileInfoList 触发 TypeError 并吞掉真正的渠道错误。
  if (!rsp || !Array.isArray(rsp.fileInfoList) || rsp.fileInfoList.length === 0) {
    throw new UploadError(
      'upload',
      `上传 APK 响应缺少 fileInfoList: ${JSON.stringify(rsp ?? null).slice(0, 300)}`,
    );
  }
  rsp.fileInfoList[0].fileName = args.apkName;

  const body = { fileType: 5, files: rsp.fileInfoList, lang: 'zh-CN' };
  // 华为接口此处字段为 fileDestUrl，而取地址返回的是拼写错误的 fileDestUlr，需修正。
  const serialized = JSON.stringify(body).replace(/fileDestUlr/g, 'fileDestUrl');
  const res = await fetch(`${BASE}/app-file-info?appId=${args.appId}`, {
    method: 'PUT',
    headers: authHeaders(args.clientId, args.accessToken),
    body: serialized,
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UploadError(res.status, `app-file-info 失败 ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** 上传图标并通过 app-file-info 绑定（fileType=0，isImg）。 */
async function updateIcon(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  iconBytes: Buffer;
  iconName: string;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<void> {
  const rsp = await uploadFileToHuawei({
    appId: args.appId,
    clientId: args.clientId,
    accessToken: args.accessToken,
    bytes: args.iconBytes,
    fileName: args.iconName,
    isImg: true,
    uploadTimeoutMs: args.uploadTimeoutMs,
    timeoutMs: args.timeoutMs,
  });
  // 同 uploadApk：rsp / fileInfoList 缺失时抛带响应片段的 UploadError，避免 TypeError 吞错。
  if (!rsp || !Array.isArray(rsp.fileInfoList) || rsp.fileInfoList.length === 0) {
    throw new UploadError(
      'upload',
      `上传图标响应缺少 fileInfoList: ${JSON.stringify(rsp ?? null).slice(0, 300)}`,
    );
  }

  const body = { fileType: 0, files: rsp.fileInfoList, lang: 'zh-CN' };
  // 同 app-file-info：取地址返回的拼写错误字段 fileDestUlr 需修正为 fileDestUrl。
  const serialized = JSON.stringify(body).replace(/fileDestUlr/g, 'fileDestUrl');
  const res = await fetch(`${BASE}/app-file-info?appId=${args.appId}`, {
    method: 'PUT',
    headers: authHeaders(args.clientId, args.accessToken),
    body: serialized,
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UploadError(res.status, `app-file-info(icon) 失败 ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * 更新 app-language-info（zh-CN）：更新说明(newFeatures) + 应用名称(appName)
 * + 一句话简介(briefInfo) + 应用描述(appDesc)，四者均「按需」——仅对传入的非空字段更新，
 * 其余沿用线上。无任何可更新字段时直接跳过，不发请求。
 */
async function updateLanguageInfo(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  newFeatures?: string | null;
  appName?: string | null;
  briefInfo?: string | null;
  appDesc?: string | null;
  timeoutMs: number;
}): Promise<void> {
  const body: Record<string, unknown> = { lang: 'zh-CN' };
  if (args.newFeatures && args.newFeatures.length > 0) body.newFeatures = args.newFeatures;
  if (args.appName && args.appName.length > 0) body.appName = args.appName;
  if (args.briefInfo && args.briefInfo.length > 0) body.briefInfo = args.briefInfo;
  if (args.appDesc && args.appDesc.length > 0) body.appDesc = args.appDesc;
  // 只剩 lang、无任何可更新字段：跳过（保持现有行为，绝不空更新）。
  if (Object.keys(body).length <= 1) return;
  await hwJson(
    'PUT',
    `${BASE}/app-language-info?appId=${args.appId}`,
    args.clientId,
    args.accessToken,
    body,
    args.timeoutMs,
  );
}

/**
 * 更新应用截图（app-file-info，fileType=2，竖屏 imgShowType=0，lang=zh-CN）。
 * 逐张走 upload-url+upload-file 直传得 fileInfoList，再一次性绑定。
 * --screenshot 为全量替换：传入即视为该语言的完整截图集，会覆盖线上原有截图。
 * 这是「设置截图」的正确语义（整组替换而非追加），否则将无法删除线上多余截图——
 * 切勿改成「与线上截图合并后再提交」的追加语义。
 */
async function updateScreenshots(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  images: Buffer[];
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<void> {
  const fileInfoList: any[] = [];
  for (let i = 0; i < args.images.length; i++) {
    const fileName = `screenshot-${i + 1}.png`;
    const rsp = await uploadFileToHuawei({
      appId: args.appId,
      clientId: args.clientId,
      accessToken: args.accessToken,
      bytes: args.images[i],
      fileName,
      isImg: true,
      uploadTimeoutMs: args.uploadTimeoutMs,
      timeoutMs: args.timeoutMs,
    });
    const info = rsp?.fileInfoList?.[0];
    if (info) {
      info.fileName = fileName;
      fileInfoList.push(info);
    }
  }
  if (fileInfoList.length === 0) return;

  const body = { fileType: 2, lang: 'zh-CN', imgShowType: 0, files: fileInfoList };
  // 同 app-file-info：取地址返回的拼写错误字段 fileDestUlr 需修正为 fileDestUrl。
  const serialized = JSON.stringify(body).replace(/fileDestUlr/g, 'fileDestUrl');
  const res = await fetch(`${BASE}/app-file-info?appId=${args.appId}`, {
    method: 'PUT',
    headers: authHeaders(args.clientId, args.accessToken),
    body: serialized,
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UploadError(
      res.status,
      `app-file-info(screenshot) 失败 ${res.status}: ${text.slice(0, 300)}`,
    );
  }
}

/** 更新隐私政策链接。 */
async function updatePrivacy(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  privacyUrl: string;
  timeoutMs: number;
}): Promise<void> {
  await hwJson(
    'PUT',
    `${BASE}/app-info?appId=${args.appId}`,
    args.clientId,
    args.accessToken,
    { privacyPolicy: args.privacyUrl },
    args.timeoutMs,
  );
}

/** 下载绿标检测文件并上传到华为，返回其 fileDestUlr。 */
async function uploadGreenVerifyFile(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  greenFileUrl: string;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<string> {
  const dl = await fetch(args.greenFileUrl, { signal: AbortSignal.timeout(args.uploadTimeoutMs) });
  if (!dl.ok) throw new UploadError(dl.status, `下载绿标文件失败 ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  const rsp = await uploadFileToHuawei({
    appId: args.appId,
    clientId: args.clientId,
    accessToken: args.accessToken,
    bytes,
    fileName: 'green_verify.zip',
    isImg: false,
    uploadTimeoutMs: args.uploadTimeoutMs,
    timeoutMs: args.timeoutMs,
  });
  return String(rsp?.fileInfoList?.[0]?.fileDestUlr ?? '');
}

/** 提交审核。ret.code==0 成功；204144727 表示处理中，延迟重试（≤30 次）。 */
async function submit(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`${BASE}/app-submit?appId=${args.appId}`, {
      method: 'POST',
      headers: authHeaders(args.clientId, args.accessToken),
      body: JSON.stringify(args.body),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new UploadError(res.status, `submit http ${res.status}: ${text.slice(0, 300)}`);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new UploadError('parse', `submit 非 JSON 响应: ${text.slice(0, 300)}`);
    }
    const code = Number(data?.ret?.code ?? -1);
    if (code === 0) return;
    if (code === 204144727) {
      await delay(2000);
      continue;
    }
    throw new UploadError(code, String(data?.ret?.msg ?? 'submit failed'));
  }
  throw new UploadError(204144727, 'submit failed, retry count > 30');
}

/** 完整传报：取上传地址 → 上传 APK → 更新日志 →（可选绿标）→（可选隐私）→ 提交审核。 */
export async function uploadHuawei(args: {
  appId: string;
  clientId: string;
  clientSecret: string;
  apkPath: string;
  packageName: string;
  /** 已缩放好的图标 PNG 字节（华为 216×216）；存在时上传图标，缺失则跳过。 */
  iconBytes?: Buffer;
  releaseNote?: string | null;
  /** 应用名称（按需，走 app-language-info 的 appName）。 */
  appName?: string | null;
  /** 一句话简介（按需，走 app-language-info 的 briefInfo）。 */
  summary?: string | null;
  /** 应用描述/长描述（按需，走 app-language-info 的 appDesc）。 */
  description?: string | null;
  /** 已按渠道格式（华为 png）+ 大小上限编码好的截图字节；非空时整组替换线上截图。 */
  screenshots?: Buffer[];
  privacyUrl?: string | null;
  greenVerifyFileUrl?: string | null;
  /** 发布结果回调地址（可选，由调用方注入；工具不内置任何业务回调） */
  callbackAddr?: string | null;
  timeoutMs: number;
}): Promise<void> {
  const uploadTimeoutMs = Math.max(args.timeoutMs, 900000);
  const apkBytes = await readFile(args.apkPath);
  const apkName = basename(args.apkPath);

  const accessToken = await fetchAccessToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    timeoutMs: args.timeoutMs,
  });

  // 1. 上传 APK
  await uploadApk({
    appId: args.appId,
    clientId: args.clientId,
    accessToken,
    apkBytes,
    apkName,
    uploadTimeoutMs,
    timeoutMs: args.timeoutMs,
  });

  // 2. 更新 app-language-info：更新说明 + 名称/简介/描述（均按需，函数内部无字段则跳过）
  await updateLanguageInfo({
    appId: args.appId,
    clientId: args.clientId,
    accessToken,
    newFeatures: args.releaseNote,
    appName: args.appName,
    briefInfo: args.summary,
    appDesc: args.description,
    timeoutMs: args.timeoutMs,
  });

  // 3. 更新图标（可选）：上传调用方传入的图标 PNG（华为要求 216×216）。
  //    无图标字节时跳过，不报错。
  if (args.iconBytes && args.iconBytes.length > 0) {
    await updateIcon({
      appId: args.appId,
      clientId: args.clientId,
      accessToken,
      iconBytes: args.iconBytes,
      iconName: 'icon.png',
      uploadTimeoutMs,
      timeoutMs: args.timeoutMs,
    });
  }

  // 3b. 更新截图（可选）：传入截图非空时整组替换线上截图（覆盖语义见 updateScreenshots 注释）。
  if (args.screenshots && args.screenshots.length > 0) {
    await updateScreenshots({
      appId: args.appId,
      clientId: args.clientId,
      accessToken,
      images: args.screenshots,
      uploadTimeoutMs,
      timeoutMs: args.timeoutMs,
    });
  }

  // 4. 提交体（回调地址可选，由调用方注入）
  const submitBody: Record<string, unknown> = {
    requestId: args.packageName,
  };
  if (args.callbackAddr) submitBody.callbackAddr = args.callbackAddr;

  // 5. 绿标检测材料（可选）
  if (args.greenVerifyFileUrl && args.greenVerifyFileUrl.length > 0) {
    const greenFileHWUrl = await uploadGreenVerifyFile({
      appId: args.appId,
      clientId: args.clientId,
      accessToken,
      greenFileUrl: args.greenVerifyFileUrl,
      uploadTimeoutMs,
      timeoutMs: args.timeoutMs,
    });
    submitBody.isPureDetection = '1';
    submitBody.sensitivePermissionIconUrl = greenFileHWUrl;
    submitBody.isCommitSensitivePermissionTips = 'true';
  }

  // 6. 隐私政策链接（可选）
  if (args.privacyUrl && args.privacyUrl.length > 0) {
    await updatePrivacy({
      appId: args.appId,
      clientId: args.clientId,
      accessToken,
      privacyUrl: args.privacyUrl,
      timeoutMs: args.timeoutMs,
    });
  }

  // 7. 提交审核
  await submit({
    appId: args.appId,
    clientId: args.clientId,
    accessToken,
    body: submitBody,
    timeoutMs: args.timeoutMs,
  });
}

/** 查询应用信息（app-info），返回原始 JSON 供状态映射。 */
export async function queryHuaweiAppInfo(args: {
  appId: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}): Promise<any> {
  const accessToken = await fetchAccessToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    timeoutMs: args.timeoutMs,
  });
  // 查询应用信息为幂等 GET，瞬时失败自动重试。
  return withRetry(
    () =>
      hwJson(
        'GET',
        `${BASE}/app-info?appId=${args.appId}`,
        args.clientId,
        accessToken,
        undefined,
        args.timeoutMs,
      ),
    { label: 'huawei queryAppInfo' },
  );
}
