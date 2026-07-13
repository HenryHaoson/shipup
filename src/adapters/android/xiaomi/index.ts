import type {
  ChannelAdapter,
  ChannelResult,
  StatusContext,
  UploadContext,
  NormalizedStatus,
} from '../../../core/types.js';
import { toFailed } from '../../util.js';
import { prepareScreenshot } from '../../../pkginfo/icon.js';
import { resolveIconBytes } from '../../../pkginfo/apk-icon.js';
import { getChannelSpec, warnIfTooLong } from '../specs.js';
import { getAppInfo, uploadXiaomi } from './api.js';

/**
 * 小米 getAppInfo 返回的是【线上已审核通过】的版本，没有独立的「提交版本审核态」接口。
 * - 目标版本（versionCode 优先，其次 versionName）已是线上版本 → approved；
 * - 指定了目标版本但与线上不一致 → 仍在审核/排队 → pending_review；
 * - 未指定目标版本 → 仅说明存在线上版本 → approved。
 */
function mapXiaomiStatus(
  ctx: StatusContext,
  onlineVersionName: string,
  onlineVersionCode: string,
): NormalizedStatus {
  if (ctx.versionCode && onlineVersionCode === ctx.versionCode) return 'approved';
  if (ctx.versionName && onlineVersionName === ctx.versionName) return 'approved';
  if (ctx.versionCode || ctx.versionName) return 'pending_review';
  return 'approved';
}

/** 小米应用市场：dev/push 即提交（上传 + 提审一步完成），故 upload 始终为 upload+submit。 */
export class XiaomiAdapter implements ChannelAdapter {
  readonly channel = 'xiaomi';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const spec = getChannelSpec('xiaomi');
      // 小米 push 必传图标：优先 --icon，否则用 aapt 从 APK 自动提取（按 spec 缩放 512²、压到 ≤1MB）。
      const iconBytes = await resolveIconBytes({
        iconPath: ctx.iconPath,
        apkPath: ctx.pkg,
        size: spec.iconSize,
        maxBytes: spec.iconMaxBytes,
      });

      // 文案按需更新：写前对一句话简介（brief）做长度告警（小米 ≤17 汉字，仅告警不阻断）。
      warnIfTooLong('xiaomi', 'summary', ctx.summary, spec.summaryMax);

      // 截图按需更新：仅当 ctx.screenshots 非空时，按 spec 处理为 png 并随表单上传；空=沿用线上。
      let screenshots: Uint8Array[] | undefined;
      if (ctx.screenshots && ctx.screenshots.length > 0) {
        screenshots = [];
        for (const p of ctx.screenshots) {
          screenshots.push(await prepareScreenshot(p, spec.screenshotFormat, spec.screenshotMaxBytes));
        }
      }

      await uploadXiaomi({
        userName: ctx.creds.user_name!,
        password: ctx.creds.password!,
        rsaModulus: ctx.creds.rsa_modulus!,
        packageName: ctx.packageName,
        versionName: ctx.versionName,
        updateDesc: ctx.releaseNote ?? '',
        privacyUrl: ctx.privacyUrl ?? '',
        appName: ctx.appName,
        brief: ctx.summary,
        desc: ctx.description,
        apkPath: ctx.pkg,
        iconBytes,
        iconFileName: 'icon.png',
        screenshots,
        queryTimeoutMs: ctx.timeoutMs,
        uploadTimeoutMs: Math.max(ctx.timeoutMs, 900000),
      });
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        versionName: ctx.versionName,
        versionCode: ctx.versionCode,
        action: 'upload+submit',
        status: 'submitted',
        errorCode: null,
        message: '',
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'upload+submit', ctx);
    }
  }

  async queryStatus(ctx: StatusContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const appInfo = await getAppInfo({
        userName: ctx.creds.user_name!,
        password: ctx.creds.password!,
        rsaModulus: ctx.creds.rsa_modulus!,
        packageName: ctx.packageName ?? '',
        timeoutMs: ctx.timeoutMs,
      });
      const onlineVersionName = appInfo.packageInfo.versionName;
      const onlineVersionCode = String(appInfo.packageInfo.versionCode);
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        versionName: ctx.versionName,
        versionCode: ctx.versionCode,
        action: 'status',
        status: mapXiaomiStatus(ctx, onlineVersionName, onlineVersionCode),
        marketVersion: onlineVersionName,
        errorCode: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }
}
