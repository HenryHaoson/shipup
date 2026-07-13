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
import { queryOppoStatus, uploadOppo } from './api.js';

/** 把 OPPO audit_status_name 按关键字映射到归一化状态。 */
function mapAudit(auditName: string): NormalizedStatus {
  const name = auditName ?? '';
  const lower = name.toLowerCase();
  if (name.includes('上线') || lower.includes('online') || lower.includes('pass')) return 'approved';
  if (name.includes('审核') || lower.includes('review')) return 'pending_review';
  if (name.includes('拒') || lower.includes('reject') || name.includes('失败')) return 'rejected';
  return 'pending_review';
}

/**
 * OPPO 应用市场：app/upd 即提交审核，无「只上传不提审」模式，故 upload 始终为 upload+submit。
 * creds：client_id / client_secret（取 token、签名）；app_id 为必填但 OPPO 上传 API 不使用。
 * 可选 creds.other_certificate_url（软著证书）：缺失则跳过证书上传，沿用线上已有证书。
 */
export class OppoAdapter implements ChannelAdapter {
  readonly channel = 'oppo';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const spec = getChannelSpec('oppo');

      // 默认不更新图标（沿用线上），仅 --update-icon 时更新 512²（按大小上限压缩）；
      // 来源：优先 --icon，否则 aapt 从 APK 自动提取。
      const iconBytes = ctx.updateIcon
        ? await resolveIconBytes({
            iconPath: ctx.iconPath,
            apkPath: ctx.pkg,
            size: spec.iconSize,
            maxBytes: spec.iconMaxBytes,
          })
        : undefined;

      // 文案：仅当 ctx 字段有值时才会下传覆盖；写前做长度（及 summary 标点/空格）告警，不阻断。
      warnIfTooLong('oppo', 'appName', ctx.appName, spec.appNameMax);
      warnIfTooLong('oppo', 'summary', ctx.summary, spec.summaryMax);
      warnIfTooLong('oppo', 'description', ctx.description, spec.descriptionMax);
      if (ctx.summary && /[\s\p{P}\p{S}]/u.test(ctx.summary)) {
        console.error('[warn] oppo summary 含标点/空格/符号，OPPO 要求 summary 禁标点空格，可能被打回');
      }

      // 截图：仅当 ctx.screenshots 非空时处理为竖版字节（每张按渠道格式/大小上限编码），否则沿用线上。
      let screenshotBytes: Buffer[] | undefined;
      if (ctx.screenshots && ctx.screenshots.length > 0) {
        screenshotBytes = [];
        for (const p of ctx.screenshots) {
          screenshotBytes.push(
            await prepareScreenshot(p, spec.screenshotFormat, spec.screenshotMaxBytes),
          );
        }
        const n = screenshotBytes.length;
        if (
          (spec.screenshotMin && n < spec.screenshotMin) ||
          (spec.screenshotMax && n > spec.screenshotMax)
        ) {
          console.error(
            `[warn] oppo 截图 ${n} 张，建议 ${spec.screenshotMin}-${spec.screenshotMax} 张（以渠道后台为准）`,
          );
        }
      }

      await uploadOppo({
        clientId: ctx.creds.client_id!,
        clientSecret: ctx.creds.client_secret!,
        packageName: ctx.packageName,
        versionCode: ctx.versionCode,
        apkPath: ctx.pkg,
        updateDesc: ctx.releaseNote ?? '',
        privacyUrl: ctx.privacyUrl,
        iconBytes,
        otherCertificateUrl: ctx.creds.other_certificate_url,
        appName: ctx.appName,
        summary: ctx.summary,
        description: ctx.description,
        screenshotBytes,
        timeoutMs: ctx.timeoutMs,
      });

      // 观察用：拼出本次实际下传的元数据项（仅当有值才更新，缺省沿用线上）。
      const updated: string[] = [];
      if (iconBytes) updated.push('icon');
      if (ctx.appName) updated.push('appName');
      if (ctx.summary) updated.push('summary');
      if (ctx.description) updated.push('description');
      if (screenshotBytes?.length) updated.push(`screenshots×${screenshotBytes.length}`);
      const message = [
        ctx.creds.other_certificate_url ? '已传入 creds.other_certificate_url（软著证书）' : '',
        updated.length ? `已更新元数据: ${updated.join(',')}` : '',
      ]
        .filter(Boolean)
        .join('; ');

      return {
        channel: this.channel,
        packageName: ctx.packageName,
        versionName: ctx.versionName,
        versionCode: ctx.versionCode,
        action: 'upload+submit',
        status: 'submitted',
        errorCode: null,
        message,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'upload+submit', ctx);
    }
  }

  async queryStatus(ctx: StatusContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const s = await queryOppoStatus({
        clientId: ctx.creds.client_id!,
        clientSecret: ctx.creds.client_secret!,
        packageName: ctx.packageName ?? '',
        timeoutMs: ctx.timeoutMs,
      });
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        versionName: s.versionName,
        versionCode: s.versionCode,
        action: 'status',
        status: mapAudit(s.auditName),
        marketVersion: s.versionName,
        errorCode: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }
}
