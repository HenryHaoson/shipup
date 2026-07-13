// App Store Connect（altool 上传 + ASC API v1 提审/状态/放量）。
// 发布链路：
//   upload  = altool 传 ipa（3 次退避重试，容忍「已上传」）+（--submit-review 时走共享提审流程）
//   submit  = 等 build VALID → 建/取 appStoreVersion →（幂等守卫）→ 文案 → 关联 build → reviewSubmissions 三步
//   status  = appStoreState 归一化（+灰度进度）
//   release = phased 开灰度 / complete|pause|resume 改灰度 / 默认手动发布请求
// 鉴权：JWT ES256（dsaEncoding ieee-p1363 直接得 JOSE R||S，无需 DER 转换）。
import { createPrivateKey, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  CliError, ExitCode, log, b64url, fetchJson, sleep, remainingMs, resolveValue, redactText,
} from "./common.mjs";

const execFileAsync = promisify(execFile);
const ASC_BASE = "https://api.appstoreconnect.apple.com";

// appStoreState → 归一化状态
export function mapAppStoreState(state) {
  switch (state) {
    case "WAITING_FOR_REVIEW":
    case "IN_REVIEW":
      return "pending_review";
    case "PENDING_DEVELOPER_RELEASE":
    case "PENDING_APPLE_RELEASE":
      return "approved";
    case "READY_FOR_SALE":
      return "published";
    case "REJECTED":
    case "DEVELOPER_REJECTED":
    case "METADATA_REJECTED":
    case "INVALID_BINARY":
      return "rejected";
    case "DEVELOPER_REMOVED_FROM_SALE":
    case "REMOVED_FROM_SALE":
    case "REPLACED_WITH_NEW_VERSION":
      return "offline";
    case "PREPARE_FOR_SUBMISSION":
    case "READY_FOR_REVIEW":
    case "PROCESSING_FOR_APP_STORE":
      return "uploaded";
    default:
      return "failed";
  }
}

// 已在审核/发布流程中的状态：重跑跳过提审（幂等，重试安全）
const IN_FLIGHT_STATES = new Set([
  "WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE",
  "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE", "READY_FOR_SALE",
]);

function requireCreds(creds) {
  for (const f of ["issuer_id", "key_id", "private_key"]) {
    if (!creds[f]) {
      throw new CliError(ExitCode.CREDS,
        `ios 凭证缺少 ${f}（App Store Connect → 用户和访问 → 集成 → App Store Connect API → 团队密钥）`);
    }
  }
}

// ---------- ASC 客户端 ----------

export function makeAscToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: creds.key_id, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: creds.issuer_id, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }));
  const key = createPrivateKey(creds.private_key);
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64url(signature)}`;
}

const enc = encodeURIComponent;

class Asc {
  constructor(creds, deadline) {
    this.creds = creds;
    this.deadline = deadline;
    this.tokenExp = 0;
  }

  auth() {
    const now = Math.floor(Date.now() / 1000);
    if (!this.token || now >= this.tokenExp - 60) {
      this.token = makeAscToken(this.creds);
      this.tokenExp = now + 1200;
    }
    return this.token;
  }

  /** 通用请求；非 2xx 合并 ASC errors 抛出。仅 GET 幂等重试。 */
  async fetch(method, path, body) {
    const url = path.startsWith("http") ? path : `${ASC_BASE}${path}`;
    try {
      return await fetchJson(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.auth()}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }, this.deadline, { retries: method === "GET" ? 3 : 0 });
    } catch (e) {
      // 提审失败常一次返回多条（缺截图/缺合规/缺 whatsNew），全部拼出便于诊断
      if (e instanceof CliError && e.message.includes('"errors"')) {
        try {
          const errs = JSON.parse(e.message.slice(e.message.indexOf("\n") + 1))?.errors;
          if (Array.isArray(errs) && errs.length) {
            const msg = errs.map((x) => [x.title, x.detail].filter(Boolean).join(" — ")).join(" | ");
            throw new CliError(e.exitCode, `ASC ${method} ${path}: ${msg}`, String(errs[0].code ?? e.errorCode));
          }
        } catch (inner) {
          if (inner instanceof CliError) throw inner;
        }
      }
      throw e;
    }
  }

  async getAppStoreVersion(appId, versionString) {
    const data = await this.fetch("GET",
      `/v1/apps/${enc(appId)}/appStoreVersions?filter[versionString]=${enc(versionString)}&filter[platform]=IOS&limit=1`);
    return data?.data?.[0] ?? null;
  }

  /** app_id 优先；否则用 bundleId 反查数字 Apple ID。 */
  async resolveAppId(appId, bundleId) {
    if (appId) return appId;
    if (bundleId) {
      const data = await this.fetch("GET", `/v1/apps?filter[bundleId]=${enc(bundleId)}&limit=1`);
      const id = data?.data?.[0]?.id;
      if (!id) throw new CliError(ExitCode.FAIL, `ASC 未找到 bundleId=${bundleId} 对应的 app（确认 API key 有此 app 权限）`);
      return String(id);
    }
    throw new CliError(ExitCode.CREDS, "需要 creds.app_id（App Store 数字 ID）或 bundle_id 之一");
  }

  /**
   * 轮询 build 直到 processingState=VALID。空结果只容忍 5 分钟（通常是上游上传失败），
   * 见过 build 后正常等到总超时。CFBundleVersion+营销版本双过滤，取最新上传。
   */
  async waitBuildValid(appId, buildVersion, versionString) {
    const train = versionString ? `&filter[preReleaseVersion.version]=${enc(versionString)}` : "";
    const query = `/v1/builds?filter[app]=${enc(appId)}&filter[version]=${enc(buildVersion)}${train}&sort=-uploadedDate&limit=1`;
    const notFoundDeadline = Math.min(Date.now() + 300_000, this.deadline);
    let seen = false;
    for (let attempt = 1; ; attempt++) {
      const data = await this.fetch("GET", query);
      const build = data?.data?.[0];
      const state = build?.attributes?.processingState;
      if (state === "VALID") return build.id;
      if (state === "FAILED" || state === "INVALID") {
        throw new CliError(ExitCode.FAIL, `build ${buildVersion} 处理失败: ${state}`, state);
      }
      if (build) seen = true;
      log(`[asc] 等待 build ${buildVersion}(${versionString}) 就绪… 第 ${attempt} 次，state=${state ?? "未出现"}`);
      if (!seen && Date.now() > notFoundDeadline) {
        throw new CliError(ExitCode.FAIL,
          `ASC 上找不到 build ${buildVersion}（5 分钟内未出现）。通常是上传失败/未完成——确认 ipa 已成功传到 ASC 再提审。`,
          "build_not_found");
      }
      await sleep(15_000, this.deadline);
    }
  }

  async ensureAppStoreVersion(appId, versionString, releaseType) {
    const existing = await this.getAppStoreVersion(appId, versionString);
    if (existing) {
      if (releaseType && existing.attributes?.releaseType !== releaseType) {
        await this.fetch("PATCH", `/v1/appStoreVersions/${enc(existing.id)}`, {
          data: { type: "appStoreVersions", id: existing.id, attributes: { releaseType } },
        });
      }
      return existing.id;
    }
    const attributes = { platform: "IOS", versionString };
    if (releaseType) attributes.releaseType = releaseType;
    const res = await this.fetch("POST", "/v1/appStoreVersions", {
      data: { type: "appStoreVersions", attributes, relationships: { app: { data: { type: "apps", id: appId } } } },
    });
    return res.data.id;
  }

  /** 写多 locale 文案：已存在 PATCH，否则 POST（仅写非空字段）。 */
  async writeLocalizations(versionId, byLocale) {
    const locales = Object.keys(byLocale);
    if (!locales.length) return;
    const list = await this.fetch("GET", `/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations?limit=50`);
    const existing = list?.data ?? [];
    for (const locale of locales) {
      const attrs = {};
      for (const [k, v] of Object.entries(byLocale[locale])) if (v != null && v !== "") attrs[k] = v;
      if (!Object.keys(attrs).length) continue;
      const found = existing.find((l) => l.attributes?.locale === locale);
      if (found) {
        await this.fetch("PATCH", `/v1/appStoreVersionLocalizations/${enc(found.id)}`, {
          data: { type: "appStoreVersionLocalizations", id: found.id, attributes: attrs },
        });
      } else {
        await this.fetch("POST", "/v1/appStoreVersionLocalizations", {
          data: {
            type: "appStoreVersionLocalizations",
            attributes: { locale, ...attrs },
            relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
          },
        });
      }
      log(`✓ 文案已写入 ${locale}（${Object.keys(attrs).join(", ")}）`);
    }
  }

  async attachBuild(versionId, buildId) {
    await this.fetch("PATCH", `/v1/appStoreVersions/${enc(versionId)}/relationships/build`, {
      data: { type: "builds", id: buildId },
    });
  }

  /** reviewSubmissions 三步：创建 → 加 item → submitted=true。 */
  async submitForReview(appId, versionId) {
    const sub = await this.fetch("POST", "/v1/reviewSubmissions", {
      data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: appId } } } },
    });
    await this.fetch("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: sub.data.id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    });
    await this.fetch("PATCH", `/v1/reviewSubmissions/${enc(sub.data.id)}`, {
      data: { type: "reviewSubmissions", id: sub.data.id, attributes: { submitted: true } },
    });
  }

  async getPhasedRelease(versionId) {
    const data = await this.fetch("GET", `/v1/appStoreVersions/${enc(versionId)}/appStoreVersionPhasedRelease`);
    return data?.data ?? null;
  }

  async startPhasedRelease(versionId) {
    await this.fetch("POST", "/v1/appStoreVersionPhasedReleases", {
      data: { type: "appStoreVersionPhasedReleases", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } },
    });
  }

  async setPhasedReleaseState(phasedId, state) {
    await this.fetch("PATCH", `/v1/appStoreVersionPhasedReleases/${enc(phasedId)}`, {
      data: { type: "appStoreVersionPhasedReleases", id: phasedId, attributes: { phasedReleaseState: state } },
    });
  }

  async requestRelease(versionId) {
    await this.fetch("POST", "/v1/appStoreVersionReleaseRequests", {
      data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } } },
    });
  }
}

// ---------- ipa 版本解析（macOS 原生 unzip + plutil，fail-soft）----------

async function readIpaVersion(ipaPath) {
  const tmp = join(tmpdir(), `shipup-info-${process.pid}-${Date.now()}.plist`);
  try {
    const { stdout: listing } = await execFileAsync("unzip", ["-Z1", ipaPath], { maxBuffer: 16 * 1024 * 1024 });
    const entry = listing.split("\n").find((l) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(l.trim()));
    if (!entry) return null;
    await execFileAsync("unzip", ["-p", ipaPath, entry.trim()], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })
      .then(({ stdout }) => writeFileSync(tmp, stdout));
    const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", tmp]);
    const plist = JSON.parse(stdout);
    return {
      bundleId: plist.CFBundleIdentifier,
      versionName: plist.CFBundleShortVersionString,
      versionCode: plist.CFBundleVersion,
    };
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ---------- altool ----------

/** p8 落盘到 ~/.appstoreconnect/private_keys/AuthKey_<key_id>.p8（0600）供 altool 读取。 */
function writeAuthKey(keyId, privateKey) {
  const dir = join(homedir(), ".appstoreconnect", "private_keys");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `AuthKey_${keyId}.p8`);
  writeFileSync(file, privateKey, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

async function uploadViaAltool(ipaPath, creds, deadline) {
  writeAuthKey(creds.key_id, creds.private_key);
  const args = ["altool", "--upload-app", "--type", "ios", "--file", ipaPath, "--apiKey", creds.key_id, "--apiIssuer", creds.issuer_id];
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await execFileAsync("xcrun", args, { timeout: remainingMs(deadline), maxBuffer: 16 * 1024 * 1024 });
      return;
    } catch (e) {
      const detail = redactText(String(e?.stderr || e?.stdout || e?.message || e)).slice(0, 1000);
      // 重试时若提示「已上传/冗余二进制」，说明上一次其实已成功，按成功处理
      if (attempt > 1 && /already been uploaded|redundant binary|same version|already exists/i.test(detail)) {
        log("[altool] 检测到二进制已上传，按成功处理");
        return;
      }
      if (attempt === maxAttempts) throw new CliError(ExitCode.FAIL, `altool 上传失败: ${detail}`, "altool");
      log(`[retry] altool 第 ${attempt}/${maxAttempts} 次失败，${2000 * attempt}ms 后重试: ${detail.slice(0, 200)}`);
      await sleep(2000 * attempt, deadline);
    }
  }
}

// ---------- 共享提审流程 ----------

export function buildLocaleMap(opts, credsBaseDir) {
  if (opts.metadata) {
    const p = resolve(opts.metadata);
    if (!existsSync(p)) throw new CliError(ExitCode.MISSING_INPUT, `metadata 文件不存在: ${p}`);
    // 简易两级 YAML：locale → {whatsNew/description/promotionalText/keywords}
    const map = {};
    let cur = null;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const noComment = line.replace(/(^|\s)#.*$/, "");
      if (!noComment.trim()) continue;
      const m = noComment.trim().match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim().replace(/^["']|["']$/g, "");
      if (!/^\s/.test(noComment) && !value) { cur = m[1]; map[cur] = {}; }
      else if (cur && value) map[cur][m[1]] = resolveValue(value, credsBaseDir);
    }
    return map;
  }
  if (opts.whatsNew) return { "zh-Hans": { whatsNew: resolveValue(opts.whatsNew, process.cwd()) } };
  return {};
}

async function runSubmitFlow(client, { appId, version, buildVersion, localeMap, releaseType }) {
  // 幂等守卫：版本已在审核/发布流程中则跳过重复提审
  const existing = await client.getAppStoreVersion(appId, version);
  const state = existing?.attributes?.appStoreState;
  if (existing && state && IN_FLIGHT_STATES.has(state)) {
    return { status: mapAppStoreState(state), message: `版本已处于 ${state}，跳过重复提审` };
  }
  const buildId = await client.waitBuildValid(appId, buildVersion, version);
  log(`✓ build 就绪 (${buildId})`);
  const versionId = await client.ensureAppStoreVersion(appId, version, releaseType);
  await client.writeLocalizations(versionId, localeMap);
  await client.attachBuild(versionId, buildId);
  await client.submitForReview(appId, versionId);
  log("✓ 已提交审核");
  return { status: "submitted", message: "" };
}

// ---------- 命令 ----------

export async function upload(creds, opts, deadline) {
  requireCreds(creds);
  const ipaPath = resolve(opts.package);
  if (!existsSync(ipaPath)) throw new CliError(ExitCode.MISSING_INPUT, `ipa 不存在: ${ipaPath}`);

  const info = await readIpaVersion(ipaPath);
  if (info) {
    log(`ipa: bundleId=${info.bundleId} version=${info.versionName}(${info.versionCode})`);
    if (creds.bundle_id && info.bundleId !== creds.bundle_id) {
      throw new CliError(ExitCode.MISSING_INPUT,
        `bundleId 不匹配: ipa 是 ${info.bundleId}，凭证 bundle_id 是 ${creds.bundle_id}（防止传错 app）`);
    }
  }
  const version = opts.version || info?.versionName;
  const buildVersion = opts.build || info?.versionCode;
  if (opts.submitReview && (!version || !buildVersion)) {
    throw new CliError(ExitCode.USAGE, "--submit-review 需要版本号：ipa 解析失败时请传 --version 与 --build");
  }

  if (opts.dryRun) {
    log(`[dry-run] 将 altool 上传${opts.submitReview ? " 并提审" : ""}，不执行`);
    return { status: "skipped", message: "dry-run", ...info };
  }

  log("altool 上传 ipa …");
  await uploadViaAltool(ipaPath, creds, deadline);
  log("✓ 上传完成（ASC 处理需数分钟）");

  if (opts.submitReview) {
    const client = new Asc(creds, deadline);
    const appId = await client.resolveAppId(creds.app_id, creds.bundle_id);
    const flow = await runSubmitFlow(client, {
      appId, version, buildVersion,
      localeMap: buildLocaleMap(opts, creds._baseDir),
      releaseType: opts.releaseType,
    });
    return { ...flow, versionName: version, versionCode: buildVersion };
  }
  return { status: "uploaded", versionName: version, versionCode: buildVersion };
}

export async function submit(creds, opts, deadline) {
  requireCreds(creds);
  if (!opts.version || !opts.build) {
    throw new CliError(ExitCode.USAGE, "ios submit 需要 --version（营销版本）与 --build（CFBundleVersion）");
  }
  if (opts.releaseType && !["MANUAL", "AFTER_APPROVAL"].includes(opts.releaseType)) {
    throw new CliError(ExitCode.USAGE, `--release-type 仅支持 MANUAL | AFTER_APPROVAL（收到 ${opts.releaseType}）`);
  }
  if (opts.dryRun) {
    log(`[dry-run] 将提审 version=${opts.version} build=${opts.build}`);
    return { status: "skipped", message: "dry-run" };
  }
  const client = new Asc(creds, deadline);
  const appId = await client.resolveAppId(creds.app_id, creds.bundle_id);
  const flow = await runSubmitFlow(client, {
    appId,
    version: opts.version,
    buildVersion: opts.build,
    localeMap: buildLocaleMap(opts, creds._baseDir),
    releaseType: opts.releaseType,
  });
  return { ...flow, versionName: opts.version, versionCode: opts.build };
}

export async function status(creds, opts, deadline) {
  requireCreds(creds);
  if (!opts.version) throw new CliError(ExitCode.USAGE, "ios status 需要 --version");
  if (opts.dryRun) return { status: "skipped", message: "dry-run" };
  const client = new Asc(creds, deadline);
  const appId = await client.resolveAppId(creds.app_id, creds.bundle_id);
  const v = await client.getAppStoreVersion(appId, opts.version);
  const state = v?.attributes?.appStoreState ?? null;
  let message = state ?? "version not found";
  if (v && (state === "READY_FOR_SALE" || state === "PENDING_DEVELOPER_RELEASE")) {
    try {
      const phased = await client.getPhasedRelease(v.id);
      const ps = phased?.attributes?.phasedReleaseState;
      if (ps) message += ` | phased=${ps} day=${phased.attributes.currentDayNumber ?? "-"}`;
    } catch { /* 灰度查询失败不影响主状态 */ }
  }
  log(`appStoreState=${state ?? "未找到该版本"}`);
  return { status: mapAppStoreState(state), message, versionName: v?.attributes?.versionString };
}

export async function release(creds, opts, deadline) {
  requireCreds(creds);
  if (!opts.version) throw new CliError(ExitCode.USAGE, "ios release 需要 --version");
  if (opts.dryRun) return { status: "skipped", message: "dry-run" };
  const client = new Asc(creds, deadline);
  const appId = await client.resolveAppId(creds.app_id, creds.bundle_id);
  const v = await client.getAppStoreVersion(appId, opts.version);
  if (!v) throw new CliError(ExitCode.FAIL, `未找到 appStoreVersion: ${opts.version}`, "not_found");

  let status = "published";
  let message;
  if (opts.complete || opts.pause || opts.resume) {
    const phased = await client.getPhasedRelease(v.id);
    if (!phased) throw new CliError(ExitCode.FAIL, "当前版本未开启灰度发布", "no_phased");
    const state = opts.complete ? "COMPLETE" : opts.pause ? "PAUSED" : "ACTIVE";
    await client.setPhasedReleaseState(phased.id, state);
    message = `phasedReleaseState=${state}`;
    status = opts.complete ? "published" : "approved";
  } else if (opts.phased) {
    await client.startPhasedRelease(v.id);
    message = "phased release started";
  } else {
    await client.requestRelease(v.id);
    message = "release requested";
  }
  log(`✓ ${message}`);
  return { status, message, versionName: opts.version };
}
