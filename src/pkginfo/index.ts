// 包元数据：用 app-info-parser 解析 APK/IPA（含 icon），用 adm-zip 读 ABI 判断 32 位。
// 去掉对 aapt / ANDROID_HOME 的依赖。
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { InputError } from '../core/exit.js';

const require = createRequire(import.meta.url);

export interface PkgMeta {
  packageName: string;
  versionName: string;
  versionCode: string;
  icon?: string; // base64 data uri（魅族等用）
}

export async function parsePackage(path: string): Promise<PkgMeta> {
  if (!existsSync(path)) throw new InputError(`包文件不存在: ${path}`);
  const AppInfoParser = require('app-info-parser');
  const r: any = await new AppInfoParser(path).parse();
  return {
    packageName: String(r.package ?? r.packageName ?? r.CFBundleIdentifier ?? ''),
    versionName: String(r.versionName ?? r.CFBundleShortVersionString ?? ''),
    versionCode: String(r.versionCode ?? r.CFBundleVersion ?? ''),
    icon: typeof r.icon === 'string' ? r.icon : undefined,
  };
}

const ABI_32 = new Set(['armeabi', 'armeabi-v7a', 'x86', 'mips']);

/** apk 内是否含 32 位 so（应用宝 apk32/apk64 槽位判定）。无 native so 时按 64 位。 */
export function detectCompat32(apkPath: string): boolean {
  if (!existsSync(apkPath)) throw new InputError(`包文件不存在: ${apkPath}`);
  const zip = new AdmZip(apkPath);
  for (const e of zip.getEntries()) {
    const m = /^lib\/([^/]+)\//.exec(e.entryName);
    if (m && m[1] && ABI_32.has(m[1])) return true; // 含 32 位 ABI
  }
  return false; // 无 32 位 ABI（含「有 native 但仅 64 位」与「无 native」）→ 按 64 位

}
