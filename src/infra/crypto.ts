// 各市场签名所需的原生加密原语（Node crypto）。
import { createHmac, createHash } from 'node:crypto';

export function hmacSha256Hex(key: string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function md5Hex(data: Buffer | Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}
