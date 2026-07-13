// shipup 共享基础设施：错误/退出码、凭证加载（YAML 子集 + 三形态值）、
// HTTP（GET 幂等重试）、AGC 鉴权（Service Account PS256 JWT / API 客户端 token）、zip 读取。
import { createSign, constants as cryptoConstants } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export const ExitCode = { OK: 0, FAIL: 2, USAGE: 3, CREDS: 4, MISSING_INPUT: 5, TIMEOUT: 124 };

export class CliError extends Error {
  constructor(exitCode, message, errorCode = "") {
    super(message);
    this.exitCode = exitCode;
    this.errorCode = errorCode;
  }
}

export const log = (...a) => console.error(...a);
export const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Remove credentials and long opaque values before provider output reaches logs. */
export function redactText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "<redacted-private-key>")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,}\]]+/gi, "$1<redacted>")
    .replace(/("?(?:access_token|client_secret|private_key|authCode|token)"?\s*[:=]\s*")([^"]+)(")/gi, "$1<redacted>$3")
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, "<redacted-opaque-value>");
}

/** Provider URLs may contain app identifiers, signed query strings, or upload tokens. */
export function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<redacted-url>";
  }
}

// ---------- 凭证 ----------

// 值三形态：@文件 → 读文件内容；${ENV} → 环境变量；否则字面量
export function resolveValue(raw, baseDir) {
  if (raw == null) return raw;
  if (raw.startsWith("@")) {
    const p = resolve(baseDir, raw.slice(1));
    if (!existsSync(p)) throw new CliError(ExitCode.CREDS, `@文件不存在: ${p}`);
    return readFileSync(p, "utf8").trim();
  }
  const m = raw.match(/^\$\{(\w+)\}$/);
  if (m) {
    const v = process.env[m[1]];
    if (!v) throw new CliError(ExitCode.CREDS, `环境变量未设置: ${m[1]}`);
    return v;
  }
  return raw;
}

// 极简 YAML 子集：两级嵌套（平台段 → key: value）+ 注释。够用即可，不引依赖。
function parseYamlSections(text) {
  const sections = {};
  let current = null;
  for (const line of text.split("\n")) {
    const noComment = line.replace(/(^|\s)#.*$/, "");
    if (!noComment.trim()) continue;
    const indented = /^\s/.test(noComment);
    const m = noComment.trim().match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!indented && !value) {
      current = m[1];
      sections[current] = {};
    } else if (indented && current) {
      if (value) sections[current][m[1]] = value;
    } else if (!indented && value) {
      // 顶层散键：归入 _flat（单平台旧格式兼容）
      (sections._flat ??= {})[m[1]] = value;
    }
  }
  return sections;
}

/** 读 creds YAML 并取指定平台段，值全部按三形态解析。 */
export function loadPlatformCreds(credsPath, platform) {
  if (!existsSync(credsPath)) throw new CliError(ExitCode.CREDS, `凭证文件不存在: ${credsPath}`);
  if (process.platform !== "win32") {
    const mode = statSync(credsPath).mode & 0o777;
    if ((mode & 0o077) !== 0) log(`警告：凭证文件权限为 ${mode.toString(8)}，建议 chmod 600 ${credsPath}`);
  }
  const baseDir = dirname(resolve(credsPath));
  const sections = parseYamlSections(readFileSync(credsPath, "utf8"));
  const section = sections[platform] ?? sections._flat;
  if (!section || Object.keys(section).length === 0) {
    throw new CliError(ExitCode.CREDS, `凭证文件缺少 ${platform}: 段（见 creds.example.yaml）`);
  }
  const creds = { _baseDir: baseDir };
  for (const [k, v] of Object.entries(section)) creds[k] = resolveValue(v, baseDir);
  return creds;
}

/** 解析 AGC Service Account 凭据（支持 JSON 内容或文件路径），校验必要字段。 */
export function loadServiceAccount(creds) {
  let jsonText = creds.service_account;
  if (!jsonText.trimStart().startsWith("{")) {
    const p = resolve(creds._baseDir, jsonText);
    if (!existsSync(p)) throw new CliError(ExitCode.CREDS, `service_account 文件不存在: ${p}`);
    jsonText = readFileSync(p, "utf8");
  }
  let sa;
  try {
    sa = JSON.parse(jsonText);
  } catch {
    throw new CliError(ExitCode.CREDS, "service_account 不是合法 JSON（应为 AGC 下载的 *private.json 凭据文件）");
  }
  for (const field of ["key_id", "private_key", "sub_account"]) {
    if (!sa[field]) throw new CliError(ExitCode.CREDS, `service_account JSON 缺少 ${field}`);
  }
  return sa;
}

// ---------- HTTP ----------

export function remainingMs(deadline) {
  const left = deadline - Date.now();
  if (left <= 0) throw new CliError(ExitCode.TIMEOUT, "总超时（--timeout）已到");
  return left;
}

export function sleep(ms, deadline) {
  return new Promise((r) => setTimeout(r, Math.min(ms, remainingMs(deadline))));
}

export async function fetchJson(url, init, deadline, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remainingMs(deadline), 60_000));
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      if (!res.ok && (res.status >= 500 || res.status === 429) && attempt < retries) {
        await sleep(1000 * (attempt + 1), deadline);
        continue;
      }
      if (!res.ok) {
        throw new CliError(
          ExitCode.FAIL,
          `HTTP ${res.status} ${redactUrl(url)}\n${redactText(text).slice(0, 500)}`,
          String(res.status),
        );
      }
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new CliError(ExitCode.FAIL, `非 JSON 响应 ${redactUrl(url)}: ${redactText(text).slice(0, 300)}`);
      }
    } catch (e) {
      if (e instanceof CliError) throw e;
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1), deadline);
        continue;
      }
      throw new CliError(
        e.name === "AbortError" ? ExitCode.TIMEOUT : ExitCode.FAIL,
        `请求失败 ${redactUrl(url)}: ${redactText(e.message)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------- AGC 鉴权（harmony + huawei 共用）----------

export const AGC_API_BASE = "https://connect-api.cloud.huawei.com/api";
const SA_TOKEN_AUD = "https://oauth-login.cloud.huawei.com/oauth2/v3/token";

// Service Account：PS256 自签 JWT，直接作为 Bearer（无需 token 交换）
export function serviceAccountAuth(sa) {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ kid: sa.key_id, typ: "JWT", alg: "PS256" }));
  const payload = b64url(JSON.stringify({ aud: SA_TOKEN_AUD, iss: sa.sub_account, exp: iat + 3600, iat }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign({
    key: sa.private_key,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  });
  return { Authorization: `Bearer ${header}.${payload}.${b64url(signature)}` };
}

/** 返回 AGC 请求鉴权头：优先 Service Account，回落 API 客户端（48h token + client_id 头）。 */
export async function agcAuth(creds, deadline) {
  if (creds.service_account) return serviceAccountAuth(loadServiceAccount(creds));
  if (creds.client_id && creds.client_secret) {
    const res = await fetchJson(`${AGC_API_BASE}/oauth2/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: creds.client_id, client_secret: creds.client_secret }),
    }, deadline);
    if (!res.access_token) {
      throw new CliError(
        ExitCode.CREDS,
        `获取 token 失败: ${redactText(JSON.stringify(res.ret ?? { error: "missing access_token" }))}`,
        String(res.ret?.code ?? ""),
      );
    }
    return { Authorization: `Bearer ${res.access_token}`, client_id: creds.client_id };
  }
  throw new CliError(ExitCode.CREDS, "凭证需要 service_account（推荐）或 client_id + client_secret 二选一");
}

/** AGC 业务接口：拼 query、校验 ret.code===0；GET 幂等自动重试，写操作不重试。 */
export async function agc(method, path, { auth, query, body }, deadline) {
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const res = await fetchJson(`${AGC_API_BASE}${path}${qs}`, {
    method,
    headers: { ...auth, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, deadline, { retries: method === "GET" ? 2 : 0 });
  if (res.ret && Number(res.ret.code) !== 0) {
    throw new CliError(ExitCode.FAIL, `AGC 接口错误 ${path}: [${res.ret.code}] ${res.ret.msg}`, String(res.ret.code));
  }
  return res;
}

// ---------- zip 读取（.app 的 pack.info 等）----------

/** 从 zip 字节中读取指定 entry 的内容（Buffer），找不到/不支持返回 null。 */
export function readZipEntry(buf, entryName) {
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const total = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    if (off === 0xffffffff) return null; // zip64 不支持，fail-soft
    for (let n = 0; n < total; n++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) return null;
      const method = buf.readUInt16LE(off + 10);
      const compSize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOff = buf.readUInt32LE(off + 42);
      const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
      if (name === entryName) {
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        return method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  }
}
