// 读取 creds 文件并解析每个值：字面量 / ${ENV_VAR} / @path。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CredsError, InputError } from '../core/exit.js';

function resolveValue(value: unknown, baseDir: string): unknown {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  const env = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
  if (env) {
    const name = env[1]!;
    const got = process.env[name];
    if (got === undefined || got === '') {
      throw new CredsError(`环境变量未设置: ${name}`);
    }
    return got;
  }
  if (v.startsWith('@')) {
    const p = resolvePath(baseDir, v.slice(1));
    if (!existsSync(p)) throw new CredsError(`creds 引用的文件不存在: ${p}`);
    return readFileSync(p, 'utf8').replace(/\n+$/, '');
  }
  return value;
}

function resolveDeep(obj: unknown, baseDir: string): any {
  if (Array.isArray(obj)) return obj.map((x) => resolveDeep(x, baseDir));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) out[k] = resolveDeep(val, baseDir);
    return out;
  }
  return resolveValue(obj, baseDir);
}

// Earlier shipup credential files allowed `key: @./file` even though `@` must
// be quoted in standard YAML. Normalize that legacy block-scalar form before
// parsing so existing signing setups continue to work unchanged.
function normalizeLegacyFileReferences(text: string): string {
  return text.replace(
    /^(\s*[\w.-]+\s*:\s*)(@[^#\r\n]*?)(\s*(?:#.*)?)$/gm,
    (_match, prefix: string, reference: string, suffix: string) =>
      `${prefix}${JSON.stringify(reference.trim())}${suffix}`,
  );
}

/** 读取并解析 creds 文件，返回值已解析为明文。 */
export function loadCreds(path: string, section?: string): any {
  if (!existsSync(path)) throw new InputError(`creds 文件不存在: ${path}`);
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(`[shipup] 警告：凭证文件权限为 ${mode.toString(8)}，建议 chmod 600 ${path}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(normalizeLegacyFileReferences(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new CredsError(`creds 文件解析失败: ${(e as Error).message}`);
  }
  const selected = section && (parsed as any)?.[section] ? (parsed as any)[section] : parsed;
  return resolveDeep(selected, dirname(resolvePath(path)));
}

/** 取某渠道的凭证（android creds 的 channels.<channel>）。 */
export function getChannelCreds(creds: any, channel: string): Record<string, string> {
  return (creds?.channels?.[channel] ?? {}) as Record<string, string>;
}
