// adapter 通用工具：把异常归一化为 ChannelResult。
import type { ChannelAction, ChannelResult, UploadContext } from '../core/types.js';
import { UploadError } from '../core/types.js';

export function toFailed(
  channel: string,
  err: unknown,
  startedAt: number,
  action: ChannelAction,
  ctx?: Partial<Pick<UploadContext, 'packageName' | 'versionName' | 'versionCode'>>,
): ChannelResult {
  // 错误码归一：渠道原始码透传；超时/网络给独立码，便于调用方区分（重试/告警策略不同）。
  let code = 'error';
  if (err instanceof UploadError) {
    code = err.code;
  } else if (err instanceof Error) {
    if (err.name === 'TimeoutError') code = 'timeout';
    else if (err.name === 'TypeError' || /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(err.message))
      code = 'network';
  }
  return {
    channel,
    packageName: ctx?.packageName,
    versionName: ctx?.versionName,
    versionCode: ctx?.versionCode,
    action,
    status: 'failed',
    errorCode: code,
    message: err instanceof Error ? err.message : String(err),
    durationMs: Date.now() - startedAt,
  };
}
