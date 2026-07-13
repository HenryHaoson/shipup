// 文档：https://wikinew.open.qq.com  能力：更新已上架应用版本（不支持首发）。
// 流程：get_file_upload_info(取腾讯云 COS 预签名) → PUT APK 到 COS → update_app → query 状态。
import { readFile } from 'node:fs/promises';
import { hmacSha256Hex, md5Hex } from '../../../infra/crypto.js';
import { postForm, putBytes } from '../../../infra/http.js';
import { UploadError } from '../../../core/types.js';
import { prepareScreenshot } from '../../../pkginfo/icon.js';
import { resolveIconBytes } from '../../../pkginfo/apk-icon.js';
import { getChannelSpec, warnIfTooLong } from '../specs.js';

const BASE = 'https://p.open.qq.com/open_file/developer_api';

/** 签名：除 sign 外全部参数（非空）按 key 升序拼 k=v&...，HmacSHA256(access_secret) 小写 hex。 */
export function signQq(params: Record<string, string>, accessSecret: string): string {
  const str = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return hmacSha256Hex(accessSecret, str);
}

async function postSigned(
  route: string,
  business: Record<string, string>,
  userId: string,
  accessSecret: string,
  timeoutMs: number,
  retries = 2,
): Promise<any> {
  const params: Record<string, string> = {
    ...business,
    user_id: userId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  params.sign = signQq(params, accessSecret);
  const data = await postForm(`${BASE}${route}`, params, timeoutMs, retries);
  const ret = Number(data?.ret ?? -1);
  if (ret !== 0) throw new UploadError(ret, String(data?.msg ?? 'unknown'));
  return data;
}

export async function getFileUploadInfo(args: {
  userId: string;
  accessSecret: string;
  packageName: string;
  appId: string;
  fileType: string;
  fileName: string;
  timeoutMs: number;
}): Promise<{ preSignUrl: string; serialNumber: string }> {
  const data = await postSigned(
    '/get_file_upload_info',
    { pkg_name: args.packageName, app_id: args.appId, file_type: args.fileType, file_name: args.fileName },
    args.userId,
    args.accessSecret,
    args.timeoutMs,
  );
  return { preSignUrl: String(data.pre_sign_url), serialNumber: String(data.serial_number) };
}

/**
 * 复用「get_file_upload_info 取 COS 预签名 → PUT 直传」机制（与 APK 同一套），
 * 上传任意素材字节并返回「文件流水号」。图标 / 截图均走此路径。
 */
async function uploadFileBuffer(args: {
  userId: string;
  accessSecret: string;
  packageName: string;
  appId: string;
  fileType: string;
  fileName: string;
  bytes: Buffer;
  timeoutMs: number;
}): Promise<string> {
  const info = await getFileUploadInfo({
    userId: args.userId,
    accessSecret: args.accessSecret,
    packageName: args.packageName,
    appId: args.appId,
    fileType: args.fileType,
    fileName: args.fileName,
    timeoutMs: args.timeoutMs,
  });
  await putBytes(info.preSignUrl, args.bytes, Math.max(args.timeoutMs, 900000));
  return info.serialNumber;
}

export async function updateApp(args: {
  userId: string;
  accessSecret: string;
  packageName: string;
  appId: string;
  apkSerialNumber: string;
  apkMd5: string;
  feature: string;
  compat32: boolean;
  timeoutMs: number;
  /** 图标文件流水号（resolveIconBytes 处理后经 get_file_upload_info 上传所得） */
  iconSerialNumber?: string;
  /** 截图文件流水号列表（多张，按 | 竖线分隔填入 snapshots_file_serial_number） */
  snapshotSerialNumbers?: string[];
  /** 应用名称（改名）；带此字段时同时附 modify_app_name_reason */
  appName?: string;
  modifyAppNameReason?: string;
  /** 一句话简介 → one_word_summary（官方字段名） */
  summary?: string;
  /** 应用简介/长描述 → introduce（官方字段名） */
  description?: string;
}): Promise<void> {
  const business: Record<string, string> = {
    pkg_name: args.packageName,
    app_id: args.appId,
    deploy_type: '1', // 审核通过后立即发布
    feature: args.feature,
  };
  // compat32: 含 32 位 so 走 apk32 槽位，否则 apk64
  if (args.compat32) {
    business.apk32_flag = '1';
    business.apk32_file_serial_number = args.apkSerialNumber;
    business.apk32_file_md5 = args.apkMd5;
  } else {
    business.apk64_flag = '1';
    business.apk64_file_serial_number = args.apkSerialNumber;
    business.apk64_file_md5 = args.apkMd5;
  }
  // 以下均「按需生效」：仅当对应素材/文案有值时才带，避免覆盖线上既有内容。
  if (args.iconSerialNumber) {
    business.icon_file_serial_number = args.iconSerialNumber;
  }
  if (args.snapshotSerialNumbers && args.snapshotSerialNumbers.length > 0) {
    business.snapshots_file_serial_number = args.snapshotSerialNumbers.join('|');
  }
  if (args.appName) {
    business.app_name = args.appName;
    // 应用宝改名需同时给出原因（1 年限改 2 次）；无业务侧原因时用固定值兜底。
    business.modify_app_name_reason = args.modifyAppNameReason ?? '版本更新';
  }
  if (args.summary) business.one_word_summary = args.summary;
  if (args.description) business.introduce = args.description;
  // update_app 即提交审核（非幂等）→ retries=0，不自动重试，避免重复提交。
  await postSigned('/update_app', business, args.userId, args.accessSecret, args.timeoutMs, 0);
}

/** 返回 audit_status：1 审核中 / 2 驳回 / 3 通过 / 8 撤销。 */
export async function queryAppUpdateStatus(args: {
  userId: string;
  accessSecret: string;
  packageName: string;
  appId: string;
  timeoutMs: number;
}): Promise<number> {
  const data = await postSigned(
    '/query_app_update_status',
    { pkg_name: args.packageName, app_id: args.appId },
    args.userId,
    args.accessSecret,
    args.timeoutMs,
  );
  return Number(data?.audit_status ?? -1);
}

/**
 * 完整传报：上传 APK（+按需上传图标 / 截图）→ 提交更新（即提交审核）。
 * 图标 / 截图 / 文案全部「按需生效」：仅当对应字段有值才带；apk + feature 行为不变。
 */
export async function uploadQq(args: {
  userId: string;
  accessSecret: string;
  packageName: string;
  appId: string;
  apkPath: string;
  feature: string;
  compat32: boolean;
  timeoutMs: number;
  /** 是否更新图标（--update-icon）；为真时取图标（--icon 或 aapt 从 APK 提取）填 icon_file_serial_number */
  updateIcon?: boolean;
  /** 图标文件路径（--icon，可选；不传则 aapt 从 APK 自动提取） */
  iconPath?: string;
  /** 截图路径列表；非空时逐张处理上传，4-5 张以 | 分隔填 snapshots_file_serial_number */
  screenshots?: string[];
  /** 应用名称（改名时传） */
  appName?: string;
  /** 一句话简介 / 推荐语 → one_word_summary */
  summary?: string;
  /** 应用简介 / 长描述 → introduce */
  description?: string;
}): Promise<void> {
  const spec = getChannelSpec('qq');
  const apkBytes = await readFile(args.apkPath);
  const md5sum = md5Hex(apkBytes);

  const info = await getFileUploadInfo({
    userId: args.userId,
    accessSecret: args.accessSecret,
    packageName: args.packageName,
    appId: args.appId,
    fileType: 'apk',
    fileName: `${args.packageName}_${md5sum}.apk`,
    timeoutMs: args.timeoutMs,
  });

  await putBytes(info.preSignUrl, apkBytes, Math.max(args.timeoutMs, 900000));

  // 图标：按需更新（--update-icon），来源优先 --icon、否则 aapt 从 APK 提取；512² PNG ≤200KB，再走 COS 直传得流水号。
  let iconSerialNumber: string | undefined;
  if (args.updateIcon) {
    const iconBytes = await resolveIconBytes({
      iconPath: args.iconPath,
      apkPath: args.apkPath,
      size: spec.iconSize,
      maxBytes: spec.iconMaxBytes,
    });
    iconSerialNumber = await uploadFileBuffer({
      userId: args.userId,
      accessSecret: args.accessSecret,
      packageName: args.packageName,
      appId: args.appId,
      // 图标走图片类型上传（官方 file_type 合法值：img/apk/pdf/video/txt）。
      fileType: 'img',
      fileName: `${args.packageName}_icon_${md5Hex(iconBytes)}.png`,
      bytes: iconBytes,
      timeoutMs: args.timeoutMs,
    });
  }

  // 截图：逐张按 qq 规格（PNG ≤1MB）处理后直传，多张流水号以 | 分隔。
  let snapshotSerialNumbers: string[] | undefined;
  if (args.screenshots && args.screenshots.length > 0) {
    const n = args.screenshots.length;
    if (n < (spec.screenshotMin ?? 0) || n > (spec.screenshotMax ?? Number.MAX_SAFE_INTEGER)) {
      console.error(
        `[warn] qq 截图 ${n} 张，建议 ${spec.screenshotMin}-${spec.screenshotMax} 张（以渠道后台校验为准）`,
      );
    }
    snapshotSerialNumbers = [];
    for (let i = 0; i < args.screenshots.length; i++) {
      const p = args.screenshots[i];
      const shotBytes = await prepareScreenshot(p, spec.screenshotFormat, spec.screenshotMaxBytes);
      const sn = await uploadFileBuffer({
        userId: args.userId,
        accessSecret: args.accessSecret,
        packageName: args.packageName,
        appId: args.appId,
        // 截图走图片类型上传（file_type=img）。
        fileType: 'img',
        fileName: `${args.packageName}_snapshot_${i}_${md5Hex(shotBytes)}.png`,
        bytes: shotBytes,
        timeoutMs: args.timeoutMs,
      });
      snapshotSerialNumbers.push(sn);
    }
  }

  // 文案：app_name / 一句话简介(one_word_summary) / 应用简介(introduce) 字段名均已官方文档确认，按需带。
  if (args.appName) warnIfTooLong('qq', 'app_name', args.appName, spec.appNameMax);
  if (args.summary) warnIfTooLong('qq', 'summary', args.summary, spec.summaryMax);
  if (args.description) warnIfTooLong('qq', 'description', args.description, spec.descriptionMax);

  await updateApp({
    userId: args.userId,
    accessSecret: args.accessSecret,
    packageName: args.packageName,
    appId: args.appId,
    apkSerialNumber: info.serialNumber,
    apkMd5: md5sum,
    feature: args.feature,
    compat32: args.compat32,
    timeoutMs: args.timeoutMs,
    iconSerialNumber,
    snapshotSerialNumbers,
    appName: args.appName,
    summary: args.summary,
    description: args.description,
  });
}
