import type {
  ChannelAdapter,
  ChannelResult,
  StatusContext,
  UploadContext,
  NormalizedStatus,
} from '../../../core/types.js';
import { toFailed } from '../../util.js';
import { queryAppUpdateStatus, uploadQq } from './api.js';

function mapAudit(audit: number): NormalizedStatus {
  switch (audit) {
    case 1:
      return 'submitted';
    case 2:
      return 'rejected';
    case 3:
      return 'approved';
    case 8:
      return 'offline';
    default:
      return 'pending_review';
  }
}

/** 应用宝：update_app 即提交审核，无「只上传不提审」模式，故 upload 始终为 upload+submit。 */
export class QqAdapter implements ChannelAdapter {
  readonly channel = 'qq';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      await uploadQq({
        userId: ctx.creds.user_id!,
        accessSecret: ctx.creds.access_secret!,
        packageName: ctx.packageName,
        appId: ctx.creds.app_id!,
        apkPath: ctx.pkg,
        feature: ctx.releaseNote ?? '',
        compat32: !!ctx.compat32,
        timeoutMs: ctx.timeoutMs,
        // 市场元数据更新：全部按需生效（仅当对应 ctx 字段有值才带）。
        updateIcon: ctx.updateIcon,
        iconPath: ctx.iconPath,
        screenshots: ctx.screenshots,
        appName: ctx.appName,
        summary: ctx.summary,
        description: ctx.description,
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
      const audit = await queryAppUpdateStatus({
        userId: ctx.creds.user_id!,
        accessSecret: ctx.creds.access_secret!,
        packageName: ctx.packageName ?? '',
        appId: ctx.creds.app_id!,
        timeoutMs: ctx.timeoutMs,
      });
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        action: 'status',
        status: mapAudit(audit),
        errorCode: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }
}
