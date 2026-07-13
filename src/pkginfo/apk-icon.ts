// 从 APK 提取启动图标（aapt 软依赖）。
// 取 aapt badging 里各密度的 application-icon-<dpi> 中**最高密度的 PNG/WEBP 栅格回退图**，
// 跳过自适应图标 XML（anydpi-v26 的 ic_launcher.xml）——这正是早先用 app-info-parser 取错图(喇叭图)的根因。
// 仅在「需要图标且未提供 --icon」时调用；找不到 aapt 时给出清晰错误，提示改用 --icon。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { InputError } from '../core/exit.js';
import { resizeBufferToPng } from './icon.js';

const execFileP = promisify(execFile);

/** 候选 aapt 可执行：PATH 上的 aapt/aapt2 + ANDROID_HOME/ANDROID_SDK_ROOT 下最新 build-tools。 */
function aaptCandidates(): string[] {
  const list = ['aapt', 'aapt2'];
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  if (home) {
    try {
      const bt = join(home, 'build-tools');
      for (const v of readdirSync(bt).sort().reverse()) {
        for (const name of ['aapt', 'aapt2']) {
          const p = join(bt, v, name);
          if (existsSync(p)) list.push(p);
        }
      }
    } catch {
      /* build-tools 不存在则忽略 */
    }
  }
  return list;
}

async function dumpBadging(apkPath: string): Promise<string> {
  let lastErr: unknown;
  for (const aapt of aaptCandidates()) {
    try {
      const { stdout } = await execFileP(aapt, ['dump', 'badging', apkPath], {
        maxBuffer: 32 * 1024 * 1024,
      });
      if (stdout.includes('application')) return stdout;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('aapt not found');
}

/** aapt 解析 APK 启动图标，返回最高密度 PNG/WEBP 字节。无 aapt 或仅自适应 XML 时抛 InputError。 */
export async function extractApkIconBytes(apkPath: string): Promise<Buffer> {
  let stdout: string;
  try {
    stdout = await dumpBadging(apkPath);
  } catch {
    throw new InputError(
      '未提供 --icon 且未找到 aapt（需 Android SDK build-tools / ANDROID_HOME）：请用 --icon 指定图标，或在含 aapt 的环境运行',
    );
  }
  const entries = [...stdout.matchAll(/application-icon-(\d+):'([^']+)'/g)]
    .map((m) => ({ dpi: Number(m[1]), path: m[2] }))
    .filter((e) => /\.(png|webp)$/i.test(e.path));
  if (entries.length === 0) {
    // 退路：application 行的 icon（部分包仅此处给 PNG）。
    const m = stdout.match(/application:[^\n]*icon='([^']+\.(?:png|webp))'/i);
    if (m) entries.push({ dpi: 0, path: m[1] });
  }
  if (entries.length === 0) {
    throw new InputError('aapt 未从 APK 解析到 PNG/WEBP 图标（可能仅含自适应 XML 图标）：请用 --icon 指定');
  }
  entries.sort((a, b) => b.dpi - a.dpi);
  const zip = new AdmZip(apkPath);
  const entry = zip.getEntry(entries[0].path);
  if (!entry) throw new InputError(`APK 内未找到图标资源 ${entries[0].path}`);
  return entry.getData();
}

/**
 * 解析图标字节：优先 --icon 文件，否则用 aapt 从 APK 提取（最高密度 PNG），
 * 再按渠道尺寸 + 大小上限缩放压缩。两条来源都没有（无 aapt 且无 --icon）则抛 InputError。
 */
export async function resolveIconBytes(opts: {
  iconPath?: string;
  apkPath: string;
  size: number;
  maxBytes?: number;
}): Promise<Buffer> {
  const input = opts.iconPath
    ? await readFile(opts.iconPath)
    : await extractApkIconBytes(opts.apkPath);
  return resizeBufferToPng(input, opts.size, opts.maxBytes);
}
