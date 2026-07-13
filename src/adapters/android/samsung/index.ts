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
import { queryOnlineAndLatest, uploadSamsung } from './api.js';

/**
 * - 含 REJECT：驳回
 * - 其余流程态（REGISTERING/UPDATING/READY_* 等）/ 未知：审核中
 */
function mapSamsungStatus(contentStatus?: string): NormalizedStatus {
  if (!contentStatus) return 'pending_review';
  const s = contentStatus.toUpperCase();
  if (s === 'FOR_SALE') return 'published';
  if (s.includes('REJECT')) return 'rejected';
  if (s === 'SUSPENDED' || s === 'TERMINATED') return 'offline';
  return 'pending_review';
}

/** 三星 Galaxy Store：contentUpdate + contentSubmit 即提交审核，故 upload 始终为 upload+submit。 */
export class SamsungAdapter implements ChannelAdapter {
  readonly channel = 'samsung';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const spec = getChannelSpec('samsung');

      // 图标按需：默认不更新（沿用线上），仅 --update-icon 时按渠道规格处理（512²、≤1MB 压缩）；
      // 来源：优先 --icon，否则 aapt 从 APK 自动提取。
      const iconBytes = ctx.updateIcon
        ? await resolveIconBytes({
            iconPath: ctx.iconPath,
            apkPath: ctx.pkg,
            size: spec.iconSize,
            maxBytes: spec.iconMaxBytes,
          })
        : undefined;

      // 文案按需：仅当 ctx 字段有值时下发对应字段，否则保持现有行为（仅 newFeature）。
      // 三星实际按 UTF-8 字节计（汉字 3 字节 / emoji 4 字节），spec 的上限为等效汉字数（shortDescription≈13≈40 字节），写前仅告警不阻断。
      warnIfTooLong('samsung', 'appTitle', ctx.appName, spec.appNameMax);
      warnIfTooLong('samsung', 'shortDescription', ctx.summary, spec.summaryMax);
      warnIfTooLong('samsung', 'longDescription', ctx.description, spec.descriptionMax);

      // 截图按需：官方 contentUpdate.screenshots 结构为对象数组 [{screenshotKey: fileKey, reuseYn: false}]。
      // 非空时逐张按规格处理（JPG/PNG、320–3840px、≤2:1），由 api 层上传得 fileKey 后回填。
      let screenshotBytesList: Buffer[] | undefined;
      if (ctx.screenshots && ctx.screenshots.length > 0) {
        const n = ctx.screenshots.length;
        if (spec.screenshotMin && n < spec.screenshotMin) {
          console.error(
            `[warn] samsung 截图 ${n} 张，少于建议最少 ${spec.screenshotMin} 张（以渠道后台校验为准）`,
          );
        }
        screenshotBytesList = [];
        for (const p of ctx.screenshots) {
          screenshotBytesList.push(
            await prepareScreenshot(p, spec.screenshotFormat, spec.screenshotMaxBytes),
          );
        }
      }

      await uploadSamsung({
        appId: ctx.creds.app_id!,
        serviceAccount: ctx.creds.service_account!,
        privateKey: ctx.creds.private_key!,
        apkPath: ctx.pkg,
        iconBytes,
        screenshotBytesList,
        appTitle: ctx.appName,
        shortDescription: ctx.summary,
        longDescription: ctx.description,
        updateDesc: ctx.releaseNote ?? '',
        privacyUrl: ctx.privacyUrl ?? '',
        timeoutMs: ctx.timeoutMs,
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
      const info = await queryOnlineAndLatest({
        appId: ctx.creds.app_id!,
        serviceAccount: ctx.creds.service_account!,
        privateKey: ctx.creds.private_key!,
        timeoutMs: ctx.timeoutMs,
      });
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        action: 'status',
        status: mapSamsungStatus(info.contentStatus),
        marketVersion: info.onlineVersionName,
        errorCode: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }
}
