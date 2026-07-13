// upload 即「上传 + 发布新版本（提交审核）」，无「只传不提审」模式 → action 恒为 upload+submit。
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  ChannelAdapter,
  ChannelResult,
  NormalizedStatus,
  StatusContext,
  UploadContext,
} from '../../../core/types.js';
import { toFailed } from '../../util.js';
import { prepareScreenshot } from '../../../pkginfo/icon.js';
import { resolveIconBytes } from '../../../pkginfo/apk-icon.js';
import { getChannelSpec, warnIfTooLong } from '../specs.js';
import { findAppByPackage, getToken, meizuStatusText, uploadMeizu, type MeizuAuth } from './api.js';

/** 大文件上传超时下限 15min。 */
const MIN_UPLOAD_TIMEOUT_MS = 900_000;

/** 魅族应用状态码（/app/list 的 status）→ 归一化状态。 */
function mapStatus(status: unknown): NormalizedStatus {
  switch (Number(status)) {
    case 20: // 待审核
      return 'submitted';
    case 30: // 审核不通过
      return 'rejected';
    case 50: // 上架
      return 'published';
    case 70: // 下架
      return 'offline';
    case 100: // 审核中
      return 'pending_review';
    default:
      return 'pending_review';
  }
}

export class MeizuAdapter implements ChannelAdapter {
  readonly channel = 'meizu';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const spec = getChannelSpec('meizu');

      // 魅族 publish 必须带图标：优先 --icon，否则用 aapt 从 APK 自动提取（缩放 spec.iconSize²，≤spec.iconMaxBytes）。
      const iconBytes = await resolveIconBytes({
        iconPath: ctx.iconPath,
        apkPath: ctx.pkg,
        size: spec.iconSize,
        maxBytes: spec.iconMaxBytes,
      });

      // 文案：按需覆盖线上回填值，写前做长度告警（不阻断，最终以渠道后台为准）。
      warnIfTooLong('meizu', 'appName', ctx.appName, spec.appNameMax);
      warnIfTooLong('meizu', 'summary', ctx.summary, spec.summaryMax);
      warnIfTooLong('meizu', 'description', ctx.description, spec.descriptionMax);

      // 截图：仅当 --screenshots 非空时编码为 jpg 后逐张上传覆盖；空则复用线上/历史。
      let screenshotImages:
        | Array<{ bytes: Buffer; filename: string; contentType: string }>
        | undefined;
      if (ctx.screenshots && ctx.screenshots.length > 0) {
        screenshotImages = [];
        for (let i = 0; i < ctx.screenshots.length; i++) {
          const p = ctx.screenshots[i];
          const bytes = await prepareScreenshot(p, 'jpg', spec.screenshotMaxBytes);
          screenshotImages.push({
            bytes,
            filename: `screenshot_${i + 1}.jpg`,
            contentType: 'image/jpeg',
          });
        }
      }

      const apkBytes = await readFile(ctx.pkg);

      await uploadMeizu({
        clientId: ctx.creds.access_key!,
        clientSecret: ctx.creds.access_secret!,
        packageName: ctx.packageName,
        apkBytes,
        apkFilename: basename(ctx.pkg),
        iconBytes,
        iconFilename: 'icon.png',
        iconContentType: 'image/png',
        versionName: ctx.versionName,
        verDesc: ctx.releaseNote ?? '',
        privacyUrl: ctx.privacyUrl,
        appName: ctx.appName,
        summary: ctx.summary,
        description: ctx.description,
        screenshotImages,
        timeoutMs: ctx.timeoutMs,
        uploadTimeoutMs: Math.max(ctx.timeoutMs, MIN_UPLOAD_TIMEOUT_MS),
      });

      return {
        channel: this.channel,
        packageName: ctx.packageName,
        versionName: ctx.versionName,
        versionCode: ctx.versionCode,
        action: 'upload+submit',
        status: 'submitted',
        errorCode: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'upload+submit', ctx);
    }
  }

  async queryStatus(ctx: StatusContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const accessToken = await getToken({
        clientId: ctx.creds.access_key!,
        clientSecret: ctx.creds.access_secret!,
        timeoutMs: ctx.timeoutMs,
      });
      const auth: MeizuAuth = {
        clientId: ctx.creds.access_key!,
        clientSecret: ctx.creds.access_secret!,
        accessToken,
      };
      const app = await findAppByPackage({
        auth,
        packageName: ctx.packageName ?? '',
        timeoutMs: ctx.timeoutMs,
      });
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        versionName: app?.versionName != null ? String(app.versionName) : undefined,
        action: 'status',
        status: mapStatus(app?.status),
        marketVersion: app?.versionName != null ? String(app.versionName) : undefined,
        errorCode: null,
        message: meizuStatusText(app?.status),
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }
}
