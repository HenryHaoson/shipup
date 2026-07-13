// 各渠道 creds 必填字段（与现有 config.dart 对齐），用于上传前校验。
import { CredsError } from '../core/exit.js';
import type { ChannelCreds } from '../core/types.js';

export const ANDROID_REQUIRED: Record<string, string[]> = {
  huawei: ['app_id', 'client_id', 'client_secret'],
  honor: ['app_id', 'client_id', 'client_secret'],
  oppo: ['app_id', 'client_id', 'client_secret'],
  vivo: ['app_id', 'access_key', 'access_secret'],
  xiaomi: ['user_name', 'password', 'rsa_modulus'],
  samsung: ['app_id', 'service_account', 'private_key'],
  qq: ['app_id', 'user_id', 'access_secret'],
  meizu: ['access_key', 'access_secret'],
};

export const ANDROID_CHANNELS = Object.keys(ANDROID_REQUIRED);

export function validateChannelCreds(channel: string, creds: ChannelCreds): void {
  const required = ANDROID_REQUIRED[channel];
  if (!required) throw new CredsError(`未知渠道: ${channel}`);
  const missing = required.filter((k) => !creds[k]);
  if (missing.length) {
    throw new CredsError(`渠道 ${channel} 缺少凭证字段: ${missing.join(', ')}`);
  }
}

export const IOS_REQUIRED = ['key_id', 'issuer_id', 'private_key'];

export function validateIosCreds(creds: ChannelCreds): void {
  const missing = IOS_REQUIRED.filter((k) => !creds[k]);
  if (missing.length) {
    throw new CredsError(`iOS ASC 缺少凭证字段: ${missing.join(', ')}`);
  }
}
