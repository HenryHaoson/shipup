// 小米按 packageName 识别应用，无 app_id。鉴权方式：把 {password, sig:[...]} 这段 JSON
// 用开发者 RSA 公钥（PKCS#1 v1.5）整体加密、hex 编码后放入 multipart 字段 SIG；
// 服务端解密后校验 password 及各文件/字段的 md5（sig 数组里的 hash）。
// 流程：dev/query 取线上 appName 等信息 → dev/push（multipart：RequestData + SIG + apk + icon）即提交。
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createPublicKey, publicEncrypt, constants, type KeyObject } from 'node:crypto';
import { md5Hex } from '../../../infra/crypto.js';
import { UploadError } from '../../../core/types.js';

const BASE = 'https://api.developer.xiaomi.com/devupload/dev';

// 其 base64url（JWK 的 e 字段）即 "AQAB"。
const RSA_EXPONENT_B64URL = Buffer.from([0x01, 0x00, 0x01]).toString('base64url');

// PKCS#1 v1.5 type2 加密填充开销固定 11 字节；故单块明文上限 = 模数字节数 - 11。
const PKCS1_PADDING_OVERHEAD = 11;

/** 把十六进制模数字符串规整为偶数长度的小写 hex。 */
function normalizeHex(hex: string): string {
  let h = hex.trim().toLowerCase().replace(/^0x/, '');
  if (h.length % 2 !== 0) h = `0${h}`;
  return h;
}

/** 模数 hex → 大端无符号字节（去掉前导 0 字节，作为 JWK n / 计算密钥字节长度）。 */
function modulusBuffer(rsaModulusHex: string): Buffer {
  const buf = Buffer.from(normalizeHex(rsaModulusHex), 'hex');
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return i > 0 ? buf.subarray(i) : buf;
}

/** 用模数 hex + 指数 65537 构造 RSA 公钥（经 JWK 导入）。 */
function buildPublicKey(rsaModulusHex: string): { key: KeyObject; keyBytes: number } {
  const modBuf = modulusBuffer(rsaModulusHex);
  if (modBuf.length === 0) throw new UploadError('rsa', 'rsa_modulus 为空或非法');
  const key = createPublicKey({
    key: { kty: 'RSA', n: modBuf.toString('base64url'), e: RSA_EXPONENT_B64URL },
    format: 'jwk',
  });
  return { key, keyBytes: modBuf.length };
}

/**
 * 各密文块拼接后 hex 编码返回。
 * 注意：PKCS#1 v1.5 type2 填充是随机的（Node 与 PointyCastle 皆然），密文每次不同但
 * 语义等价——服务端解密得到同一明文，这是预期行为，不是 bug。
 */
export function rsaSignature(body: string, rsaModulusHex: string): string {
  const { key, keyBytes } = buildPublicKey(rsaModulusHex);
  const inputBlockSize = keyBytes - PKCS1_PADDING_OVERHEAD;
  if (inputBlockSize <= 0) throw new UploadError('rsa', 'rsa_modulus 过短，无法 PKCS#1 加密');
  const input = Buffer.from(body, 'utf8');
  const blocks: Buffer[] = [];
  for (let off = 0; off < input.length; off += inputBlockSize) {
    const chunk = input.subarray(off, Math.min(off + inputBlockSize, input.length));
    const enc = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, chunk);
    blocks.push(enc);
  }
  return Buffer.concat(blocks).toString('hex');
}

/** 对 UTF-8 字符串计算小写 MD5 hex。 */
function md5OfString(s: string): string {
  return md5Hex(Buffer.from(s, 'utf8'));
}

interface SigEntry {
  name: string;
  hash: string;
}

/** 构造并 RSA 加密 SIG 字段：{password, sig:[{name,hash}...]}。 */
function buildSig(password: string, sig: SigEntry[], rsaModulusHex: string): string {
  const sigBody = JSON.stringify({ password, sig });
  return rsaSignature(sigBody, rsaModulusHex);
}

/** POST multipart，校验 http 状态与业务 result===0，返回解析后的 JSON。 */
async function postMultipart(url: string, form: FormData, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
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
  if (Number(data?.result) !== 0) {
    throw new UploadError(data?.result ?? -1, String(data?.message ?? 'unknown'));
  }
  return data;
}

export interface XiaomiPackageInfo {
  appName: string;
  packageName: string;
  versionCode: number;
  versionName: string;
}

export interface XiaomiAppInfo {
  result: number;
  message: string;
  packageInfo: XiaomiPackageInfo;
}

/** dev/query：查询应用线上信息（appName、线上版本等）。 */
export async function getAppInfo(args: {
  userName: string;
  password: string;
  rsaModulus: string;
  packageName: string;
  timeoutMs: number;
}): Promise<XiaomiAppInfo> {
  // 注意：requestData 必须「序列化一次、字段与哈希共用同一字符串」，
  // 否则 SIG 内的 md5 与实际 RequestData 字段不一致，服务端会校验失败。
  const requestData = JSON.stringify({
    userName: args.userName,
    packageName: args.packageName,
  });
  const sig = buildSig(
    args.password,
    [{ name: 'RequestData', hash: md5OfString(requestData) }],
    args.rsaModulus,
  );
  const form = new FormData();
  form.append('RequestData', requestData);
  form.append('SIG', sig);
  const data = await postMultipart(`${BASE}/query`, form, args.timeoutMs);
  return data as XiaomiAppInfo;
}

/**
 * dev/push：上传 APK + 图标 + 版本信息并提交（小米 push 即提交，无独立提审步骤）。
 */
export async function uploadXiaomi(args: {
  userName: string;
  password: string;
  rsaModulus: string;
  packageName: string;
  versionName: string;
  updateDesc: string;
  privacyUrl: string;
  /** 应用名称：有值则覆盖线上 appName；无值沿用 dev/query 取到的线上 appName。 */
  appName?: string;
  /** 一句话简介 / 推荐语 → appInfo.brief；仅当有值才下发。 */
  brief?: string;
  /** 应用简介 / 长描述 → appInfo.desc；仅当有值才下发。 */
  desc?: string;
  apkPath: string;
  iconBytes: Uint8Array;
  iconFileName: string;
  /**
   * 截图（已按 spec 处理为 png 字节）。非空时作为 multipart 字段 screenshot_1..screenshot_N
   * 追加，并按同名计入 SIG 的 md5 列表（顺序追加在 apk/icon 之后）。
   */
  screenshots?: Uint8Array[];
  /** dev/query 的超时（普通） */
  queryTimeoutMs: number;
  /** dev/push 上传大文件的超时 */
  uploadTimeoutMs: number;
}): Promise<void> {
  const appInfo = await getAppInfo({
    userName: args.userName,
    password: args.password,
    rsaModulus: args.rsaModulus,
    packageName: args.packageName,
    timeoutMs: args.queryTimeoutMs,
  });
  // appName 必传：优先用调用方覆盖值，否则沿用线上值（保持现有行为）。
  const onlineAppName = appInfo.packageInfo.appName;

  // appInfo：brief/desc 按需生效——仅当有值才加入 RequestData，否则保持原字段集不变。
  const appInfoBody: Record<string, unknown> = {
    appName: args.appName ?? onlineAppName,
    packageName: args.packageName,
    updateDesc: args.updateDesc,
    versionName: args.versionName,
    privacyUrl: args.privacyUrl,
  };
  if (args.brief !== undefined) appInfoBody.brief = args.brief;
  if (args.desc !== undefined) appInfoBody.desc = args.desc;

  const body = {
    userName: args.userName,
    synchroType: 1,
    appInfo: appInfoBody,
  };
  const requestData = JSON.stringify(body);

  const apkBytes = await readFile(args.apkPath);
  const apkMd5 = md5Hex(apkBytes);
  const iconMd5 = md5Hex(args.iconBytes);

  // SIG 的 md5 列表与 multipart 文件部分须严格一致：RequestData → apk → icon → screenshot_1..N。
  const sigEntries: SigEntry[] = [
    { name: 'RequestData', hash: md5OfString(requestData) },
    { name: 'apk', hash: apkMd5 },
    { name: 'icon', hash: iconMd5 },
  ];
  const screenshots = args.screenshots ?? [];
  for (let i = 0; i < screenshots.length; i++) {
    sigEntries.push({ name: `screenshot_${i + 1}`, hash: md5Hex(screenshots[i]) });
  }

  const sig = buildSig(args.password, sigEntries, args.rsaModulus);

  const form = new FormData();
  form.append('RequestData', requestData);
  form.append('SIG', sig);
  form.append('apk', new Blob([apkBytes], { type: 'application/octet-stream' }), basename(args.apkPath));
  form.append('icon', new Blob([args.iconBytes], { type: 'image/png' }), args.iconFileName);
  for (let i = 0; i < screenshots.length; i++) {
    const field = `screenshot_${i + 1}`;
    form.append(field, new Blob([screenshots[i]], { type: 'image/png' }), `${field}.png`);
  }

  await postMultipart(`${BASE}/push`, form, args.uploadTimeoutMs);
}
