// 华为应用市场（AppGallery Connect）API 传报。移植自 android-make 的 Dart 实现。
// 文档：https://developer.huawei.com/consumer/cn/doc/AppGallery-connect-References
// 流程：OAuth client_credentials 取 token → 取上传地址 → 上传 APK（multipart）
//      → app-file-info 绑定 → 更新 app-language-info（更新说明/名称/简介/描述，按需）
//      →（可选图标）→（可选截图，整组替换）→（可选绿标文件）→（可选隐私链接）→ 提交审核。
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { HuaweiReleaseMode, HuaweiReleaseOptions } from '../../../core/types.js';
import { UploadError } from '../../../core/types.js';
import { withRetry } from '../../../infra/http.js';

const TOKEN_URL = 'https://connect-api.cloud.huawei.com/api/oauth2/v1/token';
const BASE = 'https://connect-api.cloud.huawei.com/api/publish/v2';

type HuaweiReleaseType = 1 | 3;

export interface HuaweiPhasedReleaseInfo {
  state?: string;
  phasedReleaseStartTime?: string;
  phasedReleaseEndTime?: string;
  phasedReleasePercent?: string | number;
  phasedReleaseDescription?: string;
}

export interface HuaweiReleasePlan {
  mode: Exclude<HuaweiReleaseMode, 'auto'>;
  releaseType: HuaweiReleaseType;
  phasedReleaseInfo?: {
    phasedReleaseStartTime: string;
    phasedReleaseEndTime: string;
    phasedReleasePercent: string;
    phasedReleaseDescription: string;
  };
}

interface HuaweiPhasedReleaseContext {
  info?: HuaweiPhasedReleaseInfo;
  reason?: 'ACTIVE_PHASED_RELEASE' | 'DRAFT_ON_SHELF_UPGRADE';
}

interface HuaweiRegistrationInfo {
  registeredIdType: 1 | 2 | 3;
  registeredIdNumber: string;
}

const HUAWEI_PHASED_START_LEAD_MS = 10 * 60 * 1000;
const HUAWEI_PHASED_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function releaseUrl(
  path: string,
  appId: string,
  releaseType: HuaweiReleaseType,
  params: Record<string, string> = {},
): string {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set('appId', appId);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('releaseType', String(releaseType));
  return url.toString();
}

function normalizePhasedPercent(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new UploadError('huawei_release', `华为分阶段比例必须在 0 到 100 之间，收到: ${value}`);
  }
  return parsed.toFixed(2);
}

function isActivePhasedRelease(info: HuaweiPhasedReleaseInfo | undefined): boolean {
  const state = info?.state?.toUpperCase();
  return state === 'RELEASE' || state === 'SUSPEND';
}

export function isHuaweiDraftOnShelfUpgrade(args: {
  info?: HuaweiPhasedReleaseInfo;
  phasedReleaseState?: number;
  fullOnShelfVersion?: string;
  phasedOnShelfVersion?: string;
}): boolean {
  return (
    args.info?.state?.toUpperCase() === 'DRAFT' &&
    args.phasedReleaseState === 7 &&
    Boolean(args.info.phasedReleasePercent) &&
    Boolean(args.fullOnShelfVersion) &&
    Boolean(args.phasedOnShelfVersion) &&
    args.fullOnShelfVersion !== args.phasedOnShelfVersion
  );
}

function formatHuaweiUtc(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    '-',
    pad(date.getUTCMonth() + 1),
    '-',
    pad(date.getUTCDate()),
    'T',
    pad(date.getUTCHours()),
    ':',
    pad(date.getUTCMinutes()),
    ':',
    pad(date.getUTCSeconds()),
    '+0000',
  ].join('');
}

function createHuaweiPhasedSchedule(now: Date): {
  startTime: string;
  endTime: string;
} {
  const start = new Date(now.getTime() + HUAWEI_PHASED_START_LEAD_MS);
  const end = new Date(start.getTime() + HUAWEI_PHASED_DURATION_MS);
  return {
    startTime: formatHuaweiUtc(start),
    endTime: formatHuaweiUtc(end),
  };
}

/**
 * 将 CLI 策略和华为当前分阶段信息合并为本次上传唯一的发布计划。
 * releaseType 必须贯穿 upload-url、素材/文案更新和 app-submit，不能只在最后提审时设置。
 */
export function resolveHuaweiReleasePlan(args: {
  options?: HuaweiReleaseOptions;
  currentPhasedReleaseInfo?: HuaweiPhasedReleaseInfo;
  phasedContextReason?: HuaweiPhasedReleaseContext['reason'];
  releaseNote?: string | null;
  now?: Date;
}): HuaweiReleasePlan {
  const mode = args.options?.mode ?? 'auto';
  const hasDetectedPhasedContext =
    isActivePhasedRelease(args.currentPhasedReleaseInfo) ||
    args.phasedContextReason === 'DRAFT_ON_SHELF_UPGRADE';
  const targetMode: 'full' | 'phased' =
    mode === 'auto' ? (hasDetectedPhasedContext ? 'phased' : 'full') : mode;

  if (targetMode === 'full') return { mode: 'full', releaseType: 1 };

  const current = args.currentPhasedReleaseInfo;
  const override = args.options?.phased;
  const shouldGenerateSchedule = args.phasedContextReason === 'DRAFT_ON_SHELF_UPGRADE';
  const generatedSchedule = shouldGenerateSchedule
    ? createHuaweiPhasedSchedule(args.now ?? new Date())
    : undefined;
  const phasedReleaseStartTime =
    override?.startTime ??
    current?.phasedReleaseStartTime ??
    generatedSchedule?.startTime;
  const phasedReleaseEndTime =
    override?.endTime ??
    current?.phasedReleaseEndTime ??
    generatedSchedule?.endTime;
  const phasedReleasePercent = normalizePhasedPercent(
    override?.percent ?? current?.phasedReleasePercent,
  );
  const releaseNoteDescription = args.releaseNote?.trim();
  const phasedReleaseDescription =
    override?.description ??
    (releaseNoteDescription ? releaseNoteDescription.slice(0, 500) : undefined) ??
    current?.phasedReleaseDescription;

  const missing: string[] = [];
  if (!phasedReleaseStartTime) missing.push('--huawei-phased-start');
  if (!phasedReleaseEndTime) missing.push('--huawei-phased-end');
  if (!phasedReleasePercent) missing.push('--huawei-phased-percent');
  if (!phasedReleaseDescription) missing.push('--huawei-phased-description（或 --release-note）');
  if (missing.length > 0) {
    throw new UploadError(
      'huawei_release',
      `华为分阶段发布缺少参数: ${missing.join('、')}。auto 会继承在架分阶段版本；首次显式 phased 需补齐这些参数。`,
    );
  }
  // 上面的 missing 校验已确保四个值存在；单独收窄类型供后续校验和返回使用。
  const startTime = phasedReleaseStartTime as string;
  const endTime = phasedReleaseEndTime as string;
  const percent = phasedReleasePercent as string;
  const description = phasedReleaseDescription as string;
  if (description.length > 500) {
    throw new UploadError('huawei_release', '华为分阶段发布说明不能超过 500 字符');
  }

  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new UploadError(
      'huawei_release',
      '华为分阶段发布时间无效：start/end 需带时区，且 start 必须早于 end',
    );
  }

  return {
    mode: 'phased',
    releaseType: 3,
    phasedReleaseInfo: {
      phasedReleaseStartTime: startTime,
      phasedReleaseEndTime: endTime,
      phasedReleasePercent: percent,
      phasedReleaseDescription: description,
    },
  };
}

function authHeaders(clientId: string, accessToken: string): Record<string, string> {
  return {
    client_id: clientId,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * 校验华为主办单位资料。两项属于一组：
 * registeredIdType=1/2/3 分别对应企业/个人/机构，证件号分别是统一社会信用代码、
 * 身份证号、机构代码。证件号只用于请求体，不得写入日志。
 */
export function normalizeHuaweiRegistrationInfo(args: {
  registeredIdType?: string | number | null;
  registeredIdNumber?: string | null;
}): HuaweiRegistrationInfo | undefined {
  const rawType = args.registeredIdType;
  const registeredIdNumber = args.registeredIdNumber?.trim();
  const hasType = rawType !== undefined && rawType !== null && String(rawType).trim() !== '';
  const hasNumber = Boolean(registeredIdNumber);
  if (!hasType && !hasNumber) return undefined;
  if (!hasType || !hasNumber) {
    throw new UploadError(
      'huawei_registration',
      '华为主办单位资料必须同时配置 registered_id_type 和 registered_id_number',
    );
  }

  const parsedType = Number(rawType);
  if (parsedType !== 1 && parsedType !== 2 && parsedType !== 3) {
    throw new UploadError(
      'huawei_registration',
      `华为 registered_id_type 仅支持 1（企业）、2（个人）、3（机构），收到: ${String(rawType)}`,
    );
  }
  return {
    registeredIdType: parsedType,
    registeredIdNumber: registeredIdNumber!,
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
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new UploadError('parse', `非 JSON 响应: ${text.slice(0, 300)}`);
  }
  assertHuaweiBusinessOk(data);
  return data;
}

function assertHuaweiBusinessOk(data: any): void {
  const rawCode = data?.ret?.code;
  if (rawCode === undefined || rawCode === null || rawCode === '') return;
  const code = Number(rawCode);
  if (code === 0) return;
  throw new UploadError(
    Number.isFinite(code) ? code : String(rawCode),
    String(data?.ret?.msg ?? 'huawei request failed'),
  );
}

async function assertHuaweiResponseOk(res: Response, label: string): Promise<void> {
  const text = await res.text();
  if (!res.ok) {
    throw new UploadError(res.status, `${label} 失败 ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text) return;
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UploadError('parse', `${label} 非 JSON 响应: ${text.slice(0, 300)}`);
  }
  assertHuaweiBusinessOk(data);
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
  releaseType: HuaweiReleaseType;
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
        releaseUrl('upload-url', args.appId, args.releaseType, { suffix: args.suffix }),
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
  releaseType: HuaweiReleaseType;
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
    releaseType: args.releaseType,
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
  releaseType: HuaweiReleaseType;
  clientId: string;
  accessToken: string;
  apkBytes: Buffer;
  apkName: string;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<void> {
  const rsp = await uploadFileToHuawei({
    appId: args.appId,
    releaseType: args.releaseType,
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
  const res = await fetch(releaseUrl('app-file-info', args.appId, args.releaseType), {
    method: 'PUT',
    headers: authHeaders(args.clientId, args.accessToken),
    body: serialized,
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  await assertHuaweiResponseOk(res, 'app-file-info');
}

/** 上传图标并通过 app-file-info 绑定（fileType=0，isImg）。 */
async function updateIcon(args: {
  appId: string;
  releaseType: HuaweiReleaseType;
  clientId: string;
  accessToken: string;
  iconBytes: Buffer;
  iconName: string;
  uploadTimeoutMs: number;
  timeoutMs: number;
}): Promise<void> {
  const rsp = await uploadFileToHuawei({
    appId: args.appId,
    releaseType: args.releaseType,
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
  const res = await fetch(releaseUrl('app-file-info', args.appId, args.releaseType), {
    method: 'PUT',
    headers: authHeaders(args.clientId, args.accessToken),
    body: serialized,
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  await assertHuaweiResponseOk(res, 'app-file-info(icon)');
}

/**
 * 更新 app-language-info（zh-CN）：更新说明(newFeatures) + 应用名称(appName)
 * + 一句话简介(briefInfo) + 应用描述(appDesc)，四者均「按需」——仅对传入的非空字段更新，
 * 其余沿用线上。无任何可更新字段时直接跳过，不发请求。
 */
async function updateLanguageInfo(args: {
  appId: string;
  releaseType: HuaweiReleaseType;
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
    releaseUrl('app-language-info', args.appId, args.releaseType),
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
  releaseType: HuaweiReleaseType;
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
      releaseType: args.releaseType,
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
  const res = await fetch(releaseUrl('app-file-info', args.appId, args.releaseType), {
    method: 'PUT',
    headers: authHeaders(args.clientId, args.accessToken),
    body: serialized,
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  await assertHuaweiResponseOk(res, 'app-file-info(screenshot)');
}

/** 更新隐私政策链接。 */
async function updatePrivacy(args: {
  appId: string;
  releaseType: HuaweiReleaseType;
  clientId: string;
  accessToken: string;
  privacyUrl: string;
  timeoutMs: number;
}): Promise<void> {
  await hwJson(
    'PUT',
    releaseUrl('app-info', args.appId, args.releaseType),
    args.clientId,
    args.accessToken,
    { privacyPolicy: args.privacyUrl },
    args.timeoutMs,
  );
}

/** 更新华为 APP 主办单位类型及证件号，修复旧应用提审时两项为空的问题。 */
async function updateRegistrationInfo(args: {
  appId: string;
  releaseType: HuaweiReleaseType;
  clientId: string;
  accessToken: string;
  registration: HuaweiRegistrationInfo;
  timeoutMs: number;
}): Promise<void> {
  await hwJson(
    'PUT',
    releaseUrl('app-info', args.appId, args.releaseType),
    args.clientId,
    args.accessToken,
    args.registration,
    args.timeoutMs,
  );
}

/** 下载绿标检测文件并上传到华为，返回其 fileDestUlr。 */
async function uploadGreenVerifyFile(args: {
  appId: string;
  releaseType: HuaweiReleaseType;
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
    releaseType: args.releaseType,
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
  releaseType: HuaweiReleaseType;
  clientId: string;
  accessToken: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(releaseUrl('app-submit', args.appId, args.releaseType), {
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
    const message = String(data?.ret?.msg ?? 'submit failed');
    const registrationHint =
      code === 204144660 &&
      message.includes('registeredIdType') &&
      message.includes('registeredIdNumber')
        ? '。当前应用缺少华为主办单位资料，请在 huawei 凭证中同时配置 registered_id_type（1企业/2个人/3机构）和 registered_id_number'
        : '';
    throw new UploadError(code, `${message}${registrationHint}`);
  }
  throw new UploadError(204144727, 'submit failed, retry count > 30');
}

function extractPhasedReleaseInfo(data: any): HuaweiPhasedReleaseInfo | undefined {
  const candidates = [
    data?.phasedReleaseInfo,
    data?.appInfo?.phasedReleaseInfo,
    data?.data?.phasedReleaseInfo,
    data?.data?.appInfo?.phasedReleaseInfo,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === 'object') as
    | HuaweiPhasedReleaseInfo
    | undefined;
}

function diagnosticValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-';
  return String(value).replace(/[\r\n|]/g, ' ').slice(0, 80);
}

function diagnosticKeys(value: unknown): string {
  if (!value || typeof value !== 'object') return '-';
  return Object.keys(value as Record<string, unknown>).sort().slice(0, 40).join('/');
}

function summarizeHuaweiReleaseProbe(
  data: any,
  releaseType: HuaweiReleaseType,
  info: HuaweiPhasedReleaseInfo | undefined,
): string {
  const appInfo = data?.appInfo ?? data?.data?.appInfo ?? {};
  const phasePath = data?.phasedReleaseInfo
    ? 'phasedReleaseInfo'
    : data?.appInfo?.phasedReleaseInfo
      ? 'appInfo.phasedReleaseInfo'
      : data?.data?.phasedReleaseInfo
        ? 'data.phasedReleaseInfo'
        : data?.data?.appInfo?.phasedReleaseInfo
          ? 'data.appInfo.phasedReleaseInfo'
          : '-';
  return [
    `releaseType=${releaseType}`,
    `ret=${diagnosticValue(data?.ret?.code)}`,
    `appReleaseState=${diagnosticValue(appInfo?.releaseState)}`,
    `releasePhase=${diagnosticValue(appInfo?.releasePhase)}`,
    `version=${diagnosticValue(appInfo?.versionNumber)}`,
    `onShelfVersion=${diagnosticValue(appInfo?.onShelfVersionNumber)}`,
    `phasePath=${phasePath}`,
    `phaseState=${diagnosticValue(info?.state)}`,
    `phaseStart=${info?.phasedReleaseStartTime ? 'yes' : 'no'}`,
    `phaseEnd=${info?.phasedReleaseEndTime ? 'yes' : 'no'}`,
    `phasePercent=${diagnosticValue(info?.phasedReleasePercent)}`,
    `topKeys=${diagnosticKeys(data)}`,
    `appInfoKeys=${diagnosticKeys(appInfo)}`,
    `dataKeys=${diagnosticKeys(data?.data)}`,
  ].join(',');
}

/**
 * 查询分阶段版本上下文。
 *
 * 华为 app-info 的 releaseType 默认值为 1，当前在架版本的响应顶层也会携带
 * phasedReleaseInfo。必须先查这个上下文；直接只查 releaseType=3 可能命中分阶段
 * 编辑服务而拿不到当前在架灰度，随后误按 full 写入并触发 204144647。
 * releaseType=3 保留为兜底，用于兼容只在分阶段服务返回该信息的应用状态。
 */
async function queryPhasedReleaseInfo(args: {
  appId: string;
  clientId: string;
  accessToken: string;
  timeoutMs: number;
  onProbe?: (summary: string) => void;
}): Promise<HuaweiPhasedReleaseContext> {
  let fallback: HuaweiPhasedReleaseInfo | undefined;
  let phasedServiceInfo: HuaweiPhasedReleaseInfo | undefined;
  let fullOnShelfVersion: string | undefined;
  let phasedOnShelfVersion: string | undefined;
  let phasedReleaseState: number | undefined;
  for (const releaseType of [1, 3] as const) {
    const data = await withRetry(
      () =>
        hwJson(
          'GET',
          releaseUrl('app-info', args.appId, releaseType),
          args.clientId,
          args.accessToken,
          undefined,
          args.timeoutMs,
        ),
      { label: `huawei query phased release (releaseType=${releaseType})` },
    );
    const code = Number(data?.ret?.code ?? -1);
    if (code !== 0) {
      throw new UploadError(
        Number.isFinite(code) ? code : 'huawei_release',
        `查询华为分阶段版本失败: ${String(data?.ret?.msg ?? 'unknown')}`,
      );
    }
    const info = extractPhasedReleaseInfo(data);
    const appInfo = data?.appInfo ?? data?.data?.appInfo ?? {};
    const onShelfVersion = appInfo?.onShelfVersionNumber?.toString();
    if (releaseType === 1) {
      fullOnShelfVersion = onShelfVersion;
    } else {
      phasedServiceInfo = info;
      phasedOnShelfVersion = onShelfVersion;
      const rawState = appInfo?.releaseState;
      const parsedState = Number(rawState);
      if (rawState !== undefined && rawState !== null && Number.isFinite(parsedState)) {
        phasedReleaseState = parsedState;
      }
    }
    args.onProbe?.(summarizeHuaweiReleaseProbe(data, releaseType, info));
    fallback ??= info;
    if (isActivePhasedRelease(info)) {
      return { info, reason: 'ACTIVE_PHASED_RELEASE' };
    }
  }
  const candidate = phasedServiceInfo ?? fallback;
  const isDraftOnShelfUpgrade = isHuaweiDraftOnShelfUpgrade({
    info: candidate,
    phasedReleaseState,
    fullOnShelfVersion,
    phasedOnShelfVersion,
  });
  return {
    info: candidate,
    reason: isDraftOnShelfUpgrade ? 'DRAFT_ON_SHELF_UPGRADE' : undefined,
  };
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
  /** 华为主办单位类型：1 企业、2 个人、3 机构。与 registeredIdNumber 同时配置。 */
  registeredIdType?: string | number | null;
  /** 对应的统一社会信用代码、身份证号或机构代码。只发给华为，不写日志。 */
  registeredIdNumber?: string | null;
  /** 发布结果回调地址（可选，由封装层注入；工具不内置任何业务回调） */
  callbackAddr?: string | null;
  /** 全网/分阶段发布策略；默认 auto，存在在架分阶段版本时继续创建分阶段升级版本。 */
  releaseOptions?: HuaweiReleaseOptions;
  timeoutMs: number;
}): Promise<void> {
  const registration = normalizeHuaweiRegistrationInfo({
    registeredIdType: args.registeredIdType,
    registeredIdNumber: args.registeredIdNumber,
  });
  const uploadTimeoutMs = Math.max(args.timeoutMs, 900000);
  const apkBytes = await readFile(args.apkPath);
  const apkName = basename(args.apkPath);

  const accessToken = await fetchAccessToken({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    timeoutMs: args.timeoutMs,
  });

  const requestedMode = args.releaseOptions?.mode ?? 'auto';
  const releaseDiagnostics: string[] = [];
  const phasedOverrides = args.releaseOptions?.phased;
  const hasCompletePhasedInput = Boolean(
    phasedOverrides?.startTime &&
      phasedOverrides.endTime &&
      phasedOverrides.percent &&
      (phasedOverrides.description || args.releaseNote?.trim()),
  );
  const phasedContext: HuaweiPhasedReleaseContext =
    requestedMode === 'auto' || (requestedMode === 'phased' && !hasCompletePhasedInput)
      ? await queryPhasedReleaseInfo({
          appId: args.appId,
          clientId: args.clientId,
          accessToken,
          timeoutMs: args.timeoutMs,
          onProbe: (summary) => {
            releaseDiagnostics.push(summary);
            console.error(`[shipup] huawei 灰度探测: ${summary}`);
          },
        })
      : {};
  const releasePlan = resolveHuaweiReleasePlan({
    options: args.releaseOptions,
    currentPhasedReleaseInfo: phasedContext.info,
    phasedContextReason: phasedContext.reason,
    releaseNote: args.releaseNote,
  });
  const validateDraftScheduleAtSubmission = Boolean(
    phasedContext.reason === 'DRAFT_ON_SHELF_UPGRADE' && releasePlan.phasedReleaseInfo,
  );
  releaseDiagnostics.push(
    `contextReason=${phasedContext.reason ?? '-'},requestedMode=${requestedMode},resolvedMode=${releasePlan.mode},writeReleaseType=${releasePlan.releaseType}`,
  );
  console.error(
    `[shipup] huawei 发布策略: ${requestedMode} -> ${releasePlan.mode} (releaseType=${releasePlan.releaseType}, reason=${phasedContext.reason ?? '-'})`,
  );

  const runStage = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
    console.error(
      `[shipup] huawei 请求阶段=${stage} releaseType=${releasePlan.releaseType}`,
    );
    try {
      return await action();
    } catch (error) {
      const diagnosticText = [`失败阶段=${stage}`, ...releaseDiagnostics].join(' | ');
      console.error(`[shipup] huawei 失败诊断: ${diagnosticText}`);
      if (error instanceof UploadError) {
        throw new UploadError(error.code, `${error.message}；华为诊断：${diagnosticText}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`${message}；华为诊断：${diagnosticText}`);
      if (error instanceof Error) wrapped.name = error.name;
      throw wrapped;
    }
  };

  // 1. 上传 APK
  await runStage('upload-apk', () =>
    uploadApk({
      appId: args.appId,
      releaseType: releasePlan.releaseType,
      clientId: args.clientId,
      accessToken,
      apkBytes,
      apkName,
      uploadTimeoutMs,
      timeoutMs: args.timeoutMs,
    }),
  );

  // 1b. 旧应用可能没有华为后来新增的主办单位资料。显式配置时补齐当前发布槽，
  //     避免 APK 已上传后在 app-submit 阶段才报 registeredIdType/Number 为空。
  if (registration) {
    await runStage('update-registration', () =>
      updateRegistrationInfo({
        appId: args.appId,
        releaseType: releasePlan.releaseType,
        clientId: args.clientId,
        accessToken,
        registration,
        timeoutMs: args.timeoutMs,
      }),
    );
  }

  // 2. 更新 app-language-info：更新说明 + 名称/简介/描述（均按需，函数内部无字段则跳过）
  await runStage('update-language', () =>
    updateLanguageInfo({
      appId: args.appId,
      releaseType: releasePlan.releaseType,
      clientId: args.clientId,
      accessToken,
      newFeatures: args.releaseNote,
      appName: args.appName,
      briefInfo: args.summary,
      appDesc: args.description,
      timeoutMs: args.timeoutMs,
    }),
  );

  // 3. 更新图标（可选）：上传调用方传入的图标 PNG（华为要求 216×216）。
  //    无图标字节时跳过，不报错。
  if (args.iconBytes && args.iconBytes.length > 0) {
    await runStage('update-icon', () =>
      updateIcon({
        appId: args.appId,
        releaseType: releasePlan.releaseType,
        clientId: args.clientId,
        accessToken,
        iconBytes: args.iconBytes!,
        iconName: 'icon.png',
        uploadTimeoutMs,
        timeoutMs: args.timeoutMs,
      }),
    );
  }

  // 3b. 更新截图（可选）：传入截图非空时整组替换线上截图（覆盖语义见 updateScreenshots 注释）。
  if (args.screenshots && args.screenshots.length > 0) {
    await runStage('update-screenshots', () =>
      updateScreenshots({
        appId: args.appId,
        releaseType: releasePlan.releaseType,
        clientId: args.clientId,
        accessToken,
        images: args.screenshots!,
        uploadTimeoutMs,
        timeoutMs: args.timeoutMs,
      }),
    );
  }

  // 4. 提交体（回调地址可选，由封装层注入）
  const submitBody: Record<string, unknown> = {
    requestId: args.packageName,
  };
  if (args.callbackAddr) submitBody.callbackAddr = args.callbackAddr;
  if (releasePlan.phasedReleaseInfo) Object.assign(submitBody, releasePlan.phasedReleaseInfo);

  // 5. 绿标检测材料（可选）
  if (args.greenVerifyFileUrl && args.greenVerifyFileUrl.length > 0) {
    const greenFileHWUrl = await runStage('upload-green-verify', () =>
      uploadGreenVerifyFile({
        appId: args.appId,
        releaseType: releasePlan.releaseType,
        clientId: args.clientId,
        accessToken,
        greenFileUrl: args.greenVerifyFileUrl!,
        uploadTimeoutMs,
        timeoutMs: args.timeoutMs,
      }),
    );
    submitBody.isPureDetection = '1';
    submitBody.sensitivePermissionIconUrl = greenFileHWUrl;
    submitBody.isCommitSensitivePermissionTips = 'true';
  }

  // 6. 隐私政策链接（可选）
  if (args.privacyUrl && args.privacyUrl.length > 0) {
    await runStage('update-privacy', () =>
      updatePrivacy({
        appId: args.appId,
        releaseType: releasePlan.releaseType,
        clientId: args.clientId,
        accessToken,
        privacyUrl: args.privacyUrl!,
        timeoutMs: args.timeoutMs,
      }),
    );
  }

  // 7. 提交审核
  if (validateDraftScheduleAtSubmission) {
    const schedule = createHuaweiPhasedSchedule(new Date());
    const minimumStart = Date.parse(schedule.startTime);
    const inheritedStart = Date.parse(String(submitBody.phasedReleaseStartTime ?? ''));
    const refreshStartTime =
      !phasedOverrides?.startTime &&
      (!Number.isFinite(inheritedStart) || inheritedStart < minimumStart);
    if (refreshStartTime) {
      submitBody.phasedReleaseStartTime = schedule.startTime;
    }
    const effectiveStart = Date.parse(String(submitBody.phasedReleaseStartTime ?? ''));
    const inheritedEnd = Date.parse(String(submitBody.phasedReleaseEndTime ?? ''));
    const refreshEndTime =
      !phasedOverrides?.endTime &&
      (refreshStartTime || !Number.isFinite(inheritedEnd) || inheritedEnd <= effectiveStart);
    if (refreshEndTime) {
      submitBody.phasedReleaseEndTime = formatHuaweiUtc(
        new Date(effectiveStart + HUAWEI_PHASED_DURATION_MS),
      );
    }
    const scheduleDiagnostic = [
      `scheduleAction=${refreshStartTime || refreshEndTime ? 'refreshed' : 'preserved'}`,
      `autoScheduleStart=${String(submitBody.phasedReleaseStartTime)}`,
      `autoScheduleEnd=${String(submitBody.phasedReleaseEndTime)}`,
    ].join(',');
    releaseDiagnostics.push(scheduleDiagnostic);
    console.error(`[shipup] huawei 自动灰度周期: ${scheduleDiagnostic}`);
  }
  await runStage('submit-review', () =>
    submit({
      appId: args.appId,
      releaseType: releasePlan.releaseType,
      clientId: args.clientId,
      accessToken,
      body: submitBody,
      timeoutMs: args.timeoutMs,
    }),
  );
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
