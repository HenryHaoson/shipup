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
import { queryAppDetails, uploadVivo } from './api.js';

/**
 * vivo 审核/在售状态映射（参考 vivo_provider.dart 的 _mapVivoStatus）。
 * saleStatus=1 在售优先 → published；否则按 status：
 * 1 草稿 / 2 待审核 / 3 通过 / 4 不通过 / 5 撤销。
 */
function mapVivoStatus(status: number | null, saleStatus: number | null): NormalizedStatus {
  if (saleStatus === 1) return 'published';
  switch (status) {
    case 3:
      return 'approved';
    case 4:
      return 'rejected';
    case 2:
      return 'pending_review';
    case 1:
      return 'uploaded'; // 草稿：已上传未提审
    case 5:
      return 'offline'; // 撤销
    default:
      return 'pending_review';
  }
}

/**
 * vivo 应用市场：app.sync.update.app 即提交审核，无「只上传不提审」模式，
 * 故 upload 始终为 upload+submit。app_id 仅用于公开 H5 线上版本查询，
 * 本流程（上传/提审/查状态）按 packageName 进行，不依赖 app_id。
 */
export class VivoAdapter implements ChannelAdapter {
  readonly channel = 'vivo';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const spec = getChannelSpec(this.channel);

      // 默认不更新图标（沿用商店现有），仅 --update-icon 时更新 512×512（≤50KB 自动压缩）；
      // 来源：优先 --icon，否则 aapt 从 APK 自动提取。
      let iconBytes: Uint8Array | undefined;
      if (ctx.updateIcon) {
        iconBytes = await resolveIconBytes({
          iconPath: ctx.iconPath,
          apkPath: ctx.pkg,
          size: spec.iconSize,
          maxBytes: spec.iconMaxBytes,
        });
      }

      // 截图：仅当显式提供时更新，按渠道首选格式(jpg)与大小上限处理；失败不阻断主流程。
      let screenshotBytesList: Uint8Array[] | undefined;
      if (ctx.screenshots && ctx.screenshots.length > 0) {
        try {
          screenshotBytesList = await Promise.all(
            ctx.screenshots.map((p) =>
              prepareScreenshot(p, spec.screenshotFormat, spec.screenshotMaxBytes),
            ),
          );
        } catch (e) {
          screenshotBytesList = undefined; // 截图处理失败不阻断主流程
          console.error(
            `[warn] vivo 截图处理失败，已跳过截图更新: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // 文案：仅当提供时更新，写前做长度告警（不阻断，最终以渠道后台为准）。
      warnIfTooLong(this.channel, 'appName', ctx.appName, spec.appNameMax);
      warnIfTooLong(this.channel, 'summary', ctx.summary, spec.summaryMax);
      warnIfTooLong(this.channel, 'description', ctx.description, spec.descriptionMax);

      await uploadVivo({
        accessKey: ctx.creds.access_key!,
        accessSecret: ctx.creds.access_secret!,
        packageName: ctx.packageName,
        versionCode: ctx.versionCode,
        apkPath: ctx.pkg,
        updateDesc: ctx.releaseNote ?? '',
        privacyUrl: ctx.privacyUrl,
        appName: ctx.appName, // 仅当用户显式提供时下发，避免覆盖线上应用名
        summary: ctx.summary,
        description: ctx.description,
        iconBytes,
        screenshotBytesList,
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
      const { status, saleStatus, marketVersion } = await queryAppDetails({
        accessKey: ctx.creds.access_key!,
        accessSecret: ctx.creds.access_secret!,
        packageName: ctx.packageName ?? '',
        timeoutMs: ctx.timeoutMs,
      });
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        action: 'status',
        status: mapVivoStatus(status, saleStatus),
        marketVersion,
        errorCode: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }
}
