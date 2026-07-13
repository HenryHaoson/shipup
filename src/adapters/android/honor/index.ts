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
import { queryHonorPublishStatus, uploadHonor } from './api.js';

// 荣耀 releaseStatus 映射（参考 status/providers/honor_provider.dart 与 online_version.dart）：
//  1 已发布 → published
//  2 已下架 → offline
//  0 未发布 / 其它 → pending_review（已提交、待审/待发布）
function mapReleaseStatus(status: number | null): NormalizedStatus {
  switch (status) {
    case 1:
      return 'published';
    case 2:
      return 'offline';
    case 0:
    default:
      return 'pending_review';
  }
}

function asMap(raw: any): any | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.find((e) => e && typeof e === 'object') ?? null;
  if (typeof raw === 'object') return raw;
  return null;
}

/** 荣耀应用市场：上传 APK 后直接提交审核，upload 始终为 upload+submit。 */
export class HonorAdapter implements ChannelAdapter {
  readonly channel = 'honor';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const spec = getChannelSpec('honor');

      // 默认不更新图标（沿用商店现有），仅 --update-icon 时更新（荣耀 512²、≤200KB 自动压缩）；
      // 图标来源：优先 --icon，否则 aapt 从 APK 自动提取。
      const iconBytes = ctx.updateIcon
        ? await resolveIconBytes({
            iconPath: ctx.iconPath,
            apkPath: ctx.pkg,
            size: spec.iconSize,
            maxBytes: spec.iconMaxBytes,
          })
        : undefined;

      // 文案按需更新：写前做长度告警（不阻断，以渠道后台校验为准）。
      warnIfTooLong('honor', 'appName', ctx.appName, spec.appNameMax);
      warnIfTooLong('honor', 'summary', ctx.summary, spec.summaryMax);
      warnIfTooLong('honor', 'description', ctx.description, spec.descriptionMax);

      // 截图按需（--screenshot 为全量替换）：传入即视为该语言的完整截图集，会覆盖线上原有截图而非追加
      //（覆盖语义详见 api.ts bindFiles 注释）。纵向 1080×1920、3-5 张、≤5MB（官方 fileType=3），
      // 逐张处理后由 api 层上传+按 order 绑定。
      let screenshotBytesList: Buffer[] | undefined;
      if (ctx.screenshots && ctx.screenshots.length > 0) {
        screenshotBytesList = [];
        for (const p of ctx.screenshots) {
          screenshotBytesList.push(
            await prepareScreenshot(p, spec.screenshotFormat, spec.screenshotMaxBytes),
          );
        }
      }

      await uploadHonor({
        appId: ctx.creds.app_id!,
        clientId: ctx.creds.client_id!,
        clientSecret: ctx.creds.client_secret!,
        apkPath: ctx.pkg,
        releaseNote: ctx.releaseNote,
        privacyUrl: ctx.privacyUrl,
        appName: ctx.appName,
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
      const resp = await queryHonorPublishStatus({
        appId: ctx.creds.app_id!,
        clientId: ctx.creds.client_id!,
        clientSecret: ctx.creds.client_secret!,
        timeoutMs: ctx.timeoutMs,
      });
      const data = resp?.data ?? {};
      const publishInfo = asMap(data?.publishInfo);
      const releaseInfo = asMap(data?.releaseInfo);
      const versionSource = releaseInfo ?? publishInfo;

      const rsRaw = publishInfo?.releaseStatus;
      const releaseStatus =
        rsRaw === undefined || rsRaw === null || rsRaw === '' ? null : Number(rsRaw);
      const marketVersion = versionSource?.versionName?.toString();

      return {
        channel: this.channel,
        packageName: ctx.packageName,
        action: 'status',
        status: mapReleaseStatus(Number.isNaN(releaseStatus as number) ? null : releaseStatus),
        marketVersion,
        errorCode: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }
}
