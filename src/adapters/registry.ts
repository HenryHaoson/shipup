// 渠道 → 适配 映射。
import type { ChannelAdapter } from '../core/types.js';
import { UsageError } from '../core/exit.js';
import { ANDROID_CHANNELS } from '../creds/schema.js';
import { HuaweiAdapter } from './android/huawei/index.js';
import { HonorAdapter } from './android/honor/index.js';
import { OppoAdapter } from './android/oppo/index.js';
import { VivoAdapter } from './android/vivo/index.js';
import { XiaomiAdapter } from './android/xiaomi/index.js';
import { SamsungAdapter } from './android/samsung/index.js';
import { QqAdapter } from './android/qq/index.js';
import { MeizuAdapter } from './android/meizu/index.js';
import { IosAppStoreAdapter } from './ios/appstore/index.js';

const ANDROID_FACTORY: Record<string, () => ChannelAdapter> = {
  huawei: () => new HuaweiAdapter(),
  honor: () => new HonorAdapter(),
  oppo: () => new OppoAdapter(),
  vivo: () => new VivoAdapter(),
  xiaomi: () => new XiaomiAdapter(),
  samsung: () => new SamsungAdapter(),
  qq: () => new QqAdapter(),
  meizu: () => new MeizuAdapter(),
};

export function getAndroidAdapter(channel: string): ChannelAdapter {
  if (!ANDROID_CHANNELS.includes(channel)) {
    throw new UsageError(`未知渠道: ${channel}（支持: ${ANDROID_CHANNELS.join(', ')}）`);
  }
  const make = ANDROID_FACTORY[channel];
  if (!make) throw new UsageError(`渠道 ${channel} 未接入`);
  return make();
}

export function getIosAdapter(): IosAppStoreAdapter {
  return new IosAppStoreAdapter();
}
