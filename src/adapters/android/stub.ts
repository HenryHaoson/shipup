// 未移植渠道的桩：返回 not_implemented，保证 CLI 可运行、registry 完整。
import type { ChannelAdapter, ChannelResult, StatusContext, UploadContext } from '../../core/types.js';

export function makeStub(channel: string): ChannelAdapter {
  return {
    channel,
    async upload(ctx: UploadContext): Promise<ChannelResult> {
      return {
        channel,
        packageName: ctx.packageName,
        versionName: ctx.versionName,
        versionCode: ctx.versionCode,
        action: 'upload',
        status: 'not_implemented',
        errorCode: null,
        message: `${channel} 适配未实现（暂不可用）`,
      };
    },
    async queryStatus(_ctx: StatusContext): Promise<ChannelResult> {
      return {
        channel,
        action: 'status',
        status: 'not_implemented',
        errorCode: null,
        message: `${channel} status 未实现`,
      };
    },
  };
}
