// 流程：OAuth client_credentials 取 token → get-app-detail 取应用信息 → 更新更新日志
//      →（可选隐私链接）→ 取上传地址 + multipart 上传 APK → update-file-info 绑定 → 提交审核。
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { postForm, withRetry } from '../../../infra/http.js';
import { UploadError } from '../../../core/types.js';

const TOKEN_URL = 'https://iam.developer.hihonor.com/auth/token';
const BASE = 'https://appmarket-openapi-drcn.cloud.hihonor.com/openapi/v1/publish';

// 文件类型：图标 1 / APK 100。
const FILE_TYPE_ICON = 1;
const FILE_TYPE_APK = 100;
// 应用介绍截图-纵向 1080×1920（官方文件类型表 fileType=3；横向为 2）。绑定时需带 order 0..N。
const FILE_TYPE_SCREENSHOT_PORTRAIT = 3;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function authHeaders(clientId: string, accessToken: string): Record<string, string> {
  return {
    client_id: clientId,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

/** 通用 JSON 请求（GET/POST），非 200 抛 UploadError。 */
/** 发请求返回原始文本（不 JSON.parse）。body 为字符串时按原样发送——用于保 objectId 大整数精度。 */
async function honorRequestText(
  method: 'GET' | 'POST',
  url: string,
  clientId: string,
  accessToken: string,
  body: unknown,
  timeoutMs: number,
): Promise<string> {
  const init: RequestInit = {
    method,
    headers: authHeaders(clientId, accessToken),
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new UploadError(res.status, `http ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function honorJson(
  method: 'GET' | 'POST',
  url: string,
  clientId: string,
  accessToken: string,
  bodyObj: unknown,
  timeoutMs: number,
): Promise<any> {
  const text = await honorRequestText(method, url, clientId, accessToken, bodyObj, timeoutMs);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new UploadError('parse', `非 JSON 响应: ${text.slice(0, 300)}`);
  }
}

/**
 * 校验荣耀业务响应：外层 code 须 '0000'，内层 data.code（存在时）须 0，否则抛出荣耀的真实原因。
 * 荣耀错误字段用 msg（非 message），空时附完整响应。此前 bindFiles 等不校验业务码，
 * 绑定失败会被静默吞掉、直到 submit 才以「APK file not bound」暴露。
 */
function assertHonorOk(data: any, label: string): void {
  // 荣耀各接口成功码不统一：submit-audit 外层用 '0000'，绑定/上传等用数字 0 + msg "Success"。两者都认。
  const c = data?.code;
  const outerOk = c === '0000' || c === 0 || c === '0';
  if (!outerOk) {
    const m =
      data?.msg && String(data.msg).length > 0
        ? String(data.msg)
        : `${label} failed（resp: ${JSON.stringify(data)}）`;
    throw new UploadError(String(data?.code ?? label), m);
  }
  const inner = data?.data;
  if (inner && inner.code != null && Number(inner.code) !== 0) {
    const m =
      inner.msg && String(inner.msg).length > 0
        ? String(inner.msg)
        : `${label} failed（resp: ${JSON.stringify(data)}）`;
    throw new UploadError(String(inner.code), m);
  }
}

/** OAuth client_credentials 取 access_token（表单编码端点，复用 postForm）。 */
export async function fetchAccessToken(args: {
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}): Promise<string> {
  const data = await postForm(
    TOKEN_URL,
    {
      grant_type: 'client_credentials',
      client_id: args.clientId,
      client_secret: args.clientSecret,
    },
    args.timeoutMs,
  );
  const token = data?.access_token;
  if (!token) throw new UploadError('token', `取 token 失败: ${JSON.stringify(data).slice(0, 300)}`);
  return String(token);
}

/** 取应用详情（含 basicInfo / languageInfo），供更新日志与隐私链接复用。 */
async function getAppInfo(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  timeoutMs: number;
}): Promise<any> {
  // get-app-detail 为幂等 GET，瞬时失败自动重试。
  const resp = await withRetry(
    () =>
      honorJson(
        'GET',
        `${BASE}/get-app-detail?appId=${args.appId}`,
        args.clientId,
        args.accessToken,
        undefined,
        args.timeoutMs,
      ),
    { label: 'honor get-app-detail' },
  );
  return resp?.data;
}

/**
 * 更新语言文案（update-language-info）：在每条 languageInfo 上按需覆写字段。
 * 仅当对应入参有值时才覆写，未传字段沿用商店现有值（PubLanguageInfo 模型字段）：
 *  - newFeature 更新说明；appName 应用名称；briefIntro 一句话简介(≤80)；intro 应用介绍/长描述(≤8000)。
 *    字段均经荣耀官方文档（doc/guides/101359 PubLanguageInfo）确认。
 */
async function updateLanguageInfo(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  appInfo: any;
  newFeature?: string | null;
  appName?: string | null;
  summary?: string | null;
  description?: string | null;
  timeoutMs: number;
}): Promise<void> {
  const has = (v?: string | null): v is string => typeof v === 'string' && v.length > 0;
  // 线上 languageInfo 为空数组/缺失时，直接 map 会得到空 list，导致即便传了 releaseNote 也发空更新。
  // 此时兜底构造一条 { languageId: 'zh-CN' } 作为基底，再按需写入文案字段，确保更新生效。
  const existing = Array.isArray(args.appInfo?.languageInfo) ? args.appInfo.languageInfo : [];
  const baseList: any[] = existing.length > 0 ? existing : [{ languageId: 'zh-CN' }];
  const languageInfoList = baseList.map((e: any) => {
    const next = { ...e };
    if (has(args.newFeature)) next.newFeature = args.newFeature;
    if (has(args.appName)) next.appName = args.appName;
    if (has(args.summary)) next.briefIntro = args.summary;
    if (has(args.description)) next.intro = args.description;
    return next;
  });
  await honorJson(
    'POST',
    `${BASE}/update-language-info?appId=${args.appId}`,
    args.clientId,
    args.accessToken,
    { languageInfoList },
    args.timeoutMs,
  );
}

/** 更新隐私政策链接（在 basicInfo 上改写后整体回传）。 */
async function updatePrivacy(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  appInfo: any;
  privacyUrl: string;
  timeoutMs: number;
}): Promise<void> {
  const body = { ...(args.appInfo?.basicInfo ?? {}), privacyPolicyUrl: args.privacyUrl };
  await honorJson(
    'POST',
    `${BASE}/update-app-info?appId=${args.appId}`,
    args.clientId,
    args.accessToken,
    body,
    args.timeoutMs,
  );
}

/** 取文件上传地址（含 objectId）。 */
async function getFileUploadInfo(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  file: { fileName: string; fileSha256: string; fileSize: number; fileType: number };
  timeoutMs: number;
}): Promise<{ uploadUrl: string; fileName: string; objectId: string }> {
  // 取上传地址为幂等操作（仅分配上传槽位，失败即未生效），瞬时失败自动重试。
  const raw = await withRetry(
    () =>
      honorRequestText(
        'POST',
        `${BASE}/get-file-upload-url?appId=${args.appId}`,
        args.clientId,
        args.accessToken,
        [args.file],
        args.timeoutMs,
      ),
    { label: 'honor get-file-upload-url' },
  );
  let resp: any;
  try {
    resp = raw ? JSON.parse(raw) : {};
  } catch {
    throw new UploadError('parse', `非 JSON 响应: ${raw.slice(0, 300)}`);
  }
  const info = resp?.data?.[0];
  if (!info?.uploadUrl) {
    throw new UploadError('upload-url', `取上传地址失败: ${raw.slice(0, 300)}`);
  }
  // objectId 保精度：从原始文本抽取数字串。JSON.parse/Number 会把 >2^53 的大整数截断，
  // 导致绑定阶段报 20030「objectId is not exists」（荣耀 objectId 为 64 位整数）。
  const m = raw.match(/"objectId"\s*:\s*"?(\d+)"?/);
  const objectId = m ? m[1] : String(info.objectId ?? '');
  if (!objectId) throw new UploadError('upload-url', `未取到 objectId: ${raw.slice(0, 300)}`);
  return { uploadUrl: String(info.uploadUrl), fileName: String(info.fileName), objectId };
}

/**
 * 图标与 APK 共用此逻辑，仅 fileName/fileType 不同。
 */
async function uploadFile(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  fileName: string;
  bytes: Buffer;
  fileType: number;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<string> {
  const sha256 = createHash('sha256').update(args.bytes).digest('hex');
  const urlInfo = await getFileUploadInfo({
    appId: args.appId,
    clientId: args.clientId,
    accessToken: args.accessToken,
    file: {
      fileName: args.fileName,
      fileSha256: sha256,
      fileSize: args.bytes.length,
      fileType: args.fileType,
    },
    timeoutMs: args.timeoutMs,
  });

  const form = new FormData();
  form.append('file', new Blob([args.bytes]), args.fileName);
  // 不要手动设置 Content-Type，交给 fetch 生成 multipart boundary。
  const res = await fetch(urlInfo.uploadUrl, {
    method: 'POST',
    headers: { client_id: args.clientId, Authorization: `Bearer ${args.accessToken}` },
    body: form,
    signal: AbortSignal.timeout(args.uploadTimeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UploadError(res.status, `上传文件失败 ${res.status}: ${text.slice(0, 300)}`);
  }
  return urlInfo.objectId;
}

/** 上传 APK（fileType=APK），返回 objectId。 */
async function uploadApk(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  apkBytes: Buffer;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<string> {
  return uploadFile({
    appId: args.appId,
    clientId: args.clientId,
    accessToken: args.accessToken,
    fileName: 'honor.apk',
    bytes: args.apkBytes,
    fileType: FILE_TYPE_APK,
    uploadTimeoutMs: args.uploadTimeoutMs,
    timeoutMs: args.timeoutMs,
  });
}

/**
 * 荣耀图标尺寸 512×512（由调用方缩放后传入字节）。
 */
async function updateIcon(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  iconBytes: Buffer;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<string> {
  return uploadFile({
    appId: args.appId,
    clientId: args.clientId,
    accessToken: args.accessToken,
    fileName: 'honor_icon.png',
    bytes: args.iconBytes,
    fileType: FILE_TYPE_ICON,
    uploadTimeoutMs: args.uploadTimeoutMs,
    timeoutMs: args.timeoutMs,
  });
}

/**
 * 绑定已上传文件（zh-CN）。截图需带 fileType + order（同类文件展示顺序）。
 * 截图为全量替换：传入的 screenshots 即视为该语言的完整截图集，会覆盖线上原有截图，
 * 而非追加。这是「设置截图」的正确语义（整组替换否则无法删图）——切勿改成与线上截图合并。
 */
async function bindFiles(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  objectIds: string[];
  screenshots?: Array<{ objectId: string; order: number }>;
  timeoutMs: number;
}): Promise<void> {
  // objectId 是 64 位大整数（可能超 JS 安全整数）。用占位符构造后替换回原始数字，
  const placeholders: Array<[string, string]> = [];
  let seq = 0;
  const ph = (oid: string): string => {
    const token = `@@OID${seq++}@@`;
    placeholders.push([`"${token}"`, oid]);
    return token;
  };
  const bindingFileList: Array<Record<string, unknown>> = args.objectIds.map((oid) => ({
    objectId: ph(oid),
    languageId: 'zh-CN',
  }));
  for (const s of args.screenshots ?? []) {
    bindingFileList.push({
      objectId: ph(s.objectId),
      languageId: 'zh-CN',
      fileType: FILE_TYPE_SCREENSHOT_PORTRAIT,
      order: s.order,
    });
  }
  let body = JSON.stringify({ bindingFileList });
  for (const [quoted, digits] of placeholders) body = body.replace(quoted, digits);

  const text = await honorRequestText(
    'POST',
    `${BASE}/update-file-info?appId=${args.appId}`,
    args.clientId,
    args.accessToken,
    body,
    args.timeoutMs,
  );
  let resp: any;
  try {
    resp = text ? JSON.parse(text) : {};
  } catch {
    throw new UploadError('parse', `非 JSON 响应: ${text.slice(0, 300)}`);
  }
  // 校验绑定业务码——绑定失败必须立刻暴露，否则会以 submit 阶段的「APK file not bound」间接报出。
  assertHonorOk(resp, 'bind');
}

/** 提交审核（releaseType=1）。校验外层 code=='0000' 且内层 data.code==0。 */
async function submit(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  timeoutMs: number;
}): Promise<void> {
  const data = await honorJson(
    'POST',
    `${BASE}/submit-audit?appId=${args.appId}`,
    args.clientId,
    args.accessToken,
    { releaseType: 1 },
    args.timeoutMs,
  );
  assertHonorOk(data, 'submit');
}

/** 完整传报：取应用信息 → 更新日志 →（可选隐私）→ 上传 APK → 绑定 → 提交审核。 */
export async function uploadHonor(args: {
  appId: string;
  clientId: string;
  clientSecret: string;
  apkPath: string;
  releaseNote?: string | null;
  privacyUrl?: string | null;
  /** 可选应用名称（更新则传，按需覆写 languageInfo.appName）。 */
  appName?: string | null;
  /** 可选一句话简介（更新则传，按需覆写 languageInfo.briefIntro）。 */
  summary?: string | null;
  /** 可选应用介绍/长描述（更新则传，按需覆写 languageInfo.intro）。 */
  description?: string | null;
  /** 可选图标字节（PNG）。存在时上传图标并加入绑定，缺失时仅绑定 APK。 */
  iconBytes?: Buffer;
  /** 可选截图字节列表。非空时按 fileType=3（纵向 1080×1920）逐张上传并按 order 绑定。 */
  screenshotBytesList?: Buffer[];
  timeoutMs: number;
}): Promise<void> {
  const uploadTimeoutMs = Math.max(args.timeoutMs, 900000);
  const apkBytes = await readFile(args.apkPath);

  const accessToken = await fetchAccessToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    timeoutMs: args.timeoutMs,
  });

  // 1. 取应用信息（更新日志/隐私链接均需基于现有数据回传）
  const appInfo = await getAppInfo({
    appId: args.appId,
    clientId: args.clientId,
    accessToken,
    timeoutMs: args.timeoutMs,
  });

  // 2. 更新文案（更新说明 + 可选名称/简介/介绍，按需生效；任一有值才请求）
  const hasText = (v?: string | null): boolean => typeof v === 'string' && v.length > 0;
  if (
    hasText(args.releaseNote) ||
    hasText(args.appName) ||
    hasText(args.summary) ||
    hasText(args.description)
  ) {
    await updateLanguageInfo({
      appId: args.appId,
      clientId: args.clientId,
      accessToken,
      appInfo,
      newFeature: args.releaseNote,
      appName: args.appName,
      summary: args.summary,
      description: args.description,
      timeoutMs: args.timeoutMs,
    });
  }

  // 3. 更新隐私政策链接（可选）
  if (args.privacyUrl && args.privacyUrl.length > 0) {
    await updatePrivacy({
      appId: args.appId,
      clientId: args.clientId,
      accessToken,
      appInfo,
      privacyUrl: args.privacyUrl,
      timeoutMs: args.timeoutMs,
    });
  }

  // 4. 上传 APK
  const apkObjectId = await uploadApk({
    appId: args.appId,
    clientId: args.clientId,
    accessToken,
    apkBytes,
    uploadTimeoutMs,
    timeoutMs: args.timeoutMs,
  });

  // 5. 上传图标（可选）：存在图标字节时上传并加入 objectIds，否则仅绑定 APK（不报错）。
  const objectIds = [apkObjectId];
  if (args.iconBytes && args.iconBytes.length > 0) {
    const iconObjectId = await updateIcon({
      appId: args.appId,
      clientId: args.clientId,
      accessToken,
      iconBytes: args.iconBytes,
      uploadTimeoutMs,
      timeoutMs: args.timeoutMs,
    });
    objectIds.push(iconObjectId);
  }

  // 5b. 上传截图（可选）：纵向 fileType=3，逐张上传，按 order 0..N 绑定。
  const screenshotBinds: Array<{ objectId: string; order: number }> = [];
  if (args.screenshotBytesList && args.screenshotBytesList.length > 0) {
    for (let i = 0; i < args.screenshotBytesList.length; i++) {
      const shotObjectId = await uploadFile({
        appId: args.appId,
        clientId: args.clientId,
        accessToken,
        fileName: `honor_screenshot_${i + 1}.png`,
        bytes: args.screenshotBytesList[i],
        fileType: FILE_TYPE_SCREENSHOT_PORTRAIT,
        uploadTimeoutMs,
        timeoutMs: args.timeoutMs,
      });
      screenshotBinds.push({ objectId: shotObjectId, order: i });
    }
  }

  // 6. 绑定文件（APK，及可选图标 / 截图）
  await bindFiles({
    appId: args.appId,
    clientId: args.clientId,
    accessToken,
    objectIds,
    screenshots: screenshotBinds,
    timeoutMs: args.timeoutMs,
  });

  // 延迟让荣耀异步处理完绑定再提审，规避 "multiple icons"(30026) / "APK file not bound"(30036) 等
  await delay(5000);

  // 7. 提交审核
  await submit({
    appId: args.appId,
    clientId: args.clientId,
    accessToken,
    timeoutMs: args.timeoutMs,
  });
}

/** 查询发布状态（get-app-detail），返回原始 JSON 供状态映射。 */
export async function queryHonorPublishStatus(args: {
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
  // get-app-detail 为幂等 GET，瞬时失败自动重试。
  return withRetry(
    () =>
      honorJson(
        'GET',
        `${BASE}/get-app-detail?appId=${args.appId}`,
        args.clientId,
        accessToken,
        undefined,
        args.timeoutMs,
      ),
    { label: 'honor get-app-detail' },
  );
}
