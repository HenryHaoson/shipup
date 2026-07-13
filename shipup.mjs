#!/usr/bin/env node
// shipup — mobile application release CLI
//
//   shipup harmony upload|submit|status   AppGallery（HarmonyOS .app，Publishing API v3）
//   shipup huawei  upload|status          华为应用市场（安卓 APK，Publish API v2）
//   shipup ios     upload|submit|status|release   App Store（altool + ASC API）
//
// 设计不变量：无业务逻辑，appId/密钥全由凭证文件注入；JSON→stdout、
// 诊断→stderr；GET 才自动重试；统一退出码 0/2/3/4/5/124；--dry-run 不发请求。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, ExitCode, log, loadPlatformCreds } from "./lib/common.mjs";
import * as harmony from "./lib/harmony.mjs";
import * as huawei from "./lib/huawei.mjs";
import * as ios from "./lib/ios.mjs";

const PLATFORMS = {
  harmony: { module: harmony, commands: ["upload", "submit", "status"], channel: "appgallery" },
  huawei: { module: huawei, commands: ["upload", "status"], channel: "huawei" },
  ios: { module: ios, commands: ["upload", "submit", "status", "release"], channel: "appstore" },
};

const VERSION = "0.1.0";
const DEFAULT_CREDS = join(homedir(), ".config", "shipup", "credentials.yaml");

const USAGE = `shipup — 三端发布 CLI（AppGallery HarmonyOS / 华为应用市场 / App Store）

用法:
  shipup harmony upload --package <path.app> [--creds <file>] [--release-note <t|@f>] [--lang] [--no-wait]
  shipup harmony submit [--creds <file>] [--release-note] [--remark <10-300字>] [--release-time <t>] [--phased --phased-desc <t>]
  shipup harmony status [--creds <file>]

  shipup huawei  upload --package <path.apk> [--creds <file>] [--release-note <t|@f>] [--submit-review]
  shipup huawei  status [--creds <file>]

  shipup ios     upload --package <path.ipa> [--creds <file>] [--submit-review] [--whats-new <t|@f>] [--metadata <yaml>] [--release-type MANUAL|AFTER_APPROVAL]
  shipup ios     submit --version <1.0.0> --build <1> [--creds <file>] [--whats-new] [--metadata] [--release-type]
  shipup ios     status --version <1.0.0> [--creds <file>]
  shipup ios     release --version <1.0.0> [--creds <file>] [--phased | --complete | --pause | --resume]

通用选项:
  --creds <file>     凭证 YAML；默认读取 SHIPUP_CREDS 或 ~/.config/shipup/credentials.yaml
  --output json|text 输出格式（默认 text；json 时 stdout 只有结果 JSON）
  --timeout <s>      总超时秒数（默认 900）
  --dry-run          只校验参数、凭证与软件包，不发任何请求

退出码: 0 成功 / 2 失败 / 3 用法错误 / 4 凭证错误 / 5 输入缺失 / 124 超时`;

const FLAG_KEYS = new Set(["--dry-run", "--no-wait", "--phased", "--submit-review", "--complete", "--pause", "--resume"]);

function parseArgs(argv) {
  const [platform, command, ...rest] = argv;
  if (["-v", "--version", "version"].includes(platform)) {
    console.log(VERSION);
    process.exit(ExitCode.OK);
  }
  if (!platform || ["-h", "--help", "help"].includes(platform)) {
    console.log(USAGE);
    process.exit(ExitCode.OK);
  }
  const p = PLATFORMS[platform];
  if (!p) throw new CliError(ExitCode.USAGE, `未知平台: ${platform}（支持 harmony | huawei | ios）\n\n${USAGE}`);
  if (!command || !p.commands.includes(command)) {
    throw new CliError(ExitCode.USAGE, `${platform} 支持的命令: ${p.commands.join(" | ")}（收到 ${command ?? "无"}）`);
  }
  const opts = { platform, command, output: "text", timeout: 900 };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith("--")) throw new CliError(ExitCode.USAGE, `意外的参数: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (FLAG_KEYS.has(key)) {
      opts[name] = true;
    } else {
      const val = rest[++i];
      if (val === undefined) throw new CliError(ExitCode.USAGE, `${key} 缺少值`);
      opts[name] = val;
    }
  }
  opts.timeout = Number(opts.timeout);
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new CliError(ExitCode.USAGE, "--timeout 必须是正数（秒）");
  if (!["json", "text"].includes(opts.output)) throw new CliError(ExitCode.USAGE, "--output 只能是 json 或 text");
  opts.creds = opts.creds || process.env.SHIPUP_CREDS || (existsSync(DEFAULT_CREDS) ? DEFAULT_CREDS : "");
  if (!opts.creds) {
    throw new CliError(
      ExitCode.CREDS,
      "未找到凭证：请传 --creds、设置 SHIPUP_CREDS，或创建 ~/.config/shipup/credentials.yaml",
    );
  }
  if (command === "upload" && !opts.package) throw new CliError(ExitCode.USAGE, "upload 需要 --package");
  if (platform === "harmony") {
    if (opts.phased && command === "submit" && !opts.phasedDesc) {
      throw new CliError(ExitCode.USAGE, "--phased 时必须提供 --phased-desc（官方要求 phasedReleaseDescription 必填）");
    }
    if (opts.remark && (opts.remark.length < 10 || opts.remark.length > 300)) {
      throw new CliError(ExitCode.USAGE, "--remark 长度必须在 10-300 之间");
    }
    if (opts.releaseTime && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/.test(opts.releaseTime)) {
      throw new CliError(ExitCode.USAGE, "--release-time 格式须为 yyyy-MM-ddTHH:mm:ss+0800");
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { module, channel } = PLATFORMS[opts.platform];
  const creds = loadPlatformCreds(opts.creds, opts.platform);
  const deadline = Date.now() + opts.timeout * 1000;
  const started = Date.now();

  let result, ok = true, errorCode = "", message = "";
  try {
    result = await module[opts.command](creds, opts, deadline);
    message = result.message ?? "";
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    ok = false;
    errorCode = e.errorCode || String(e.exitCode);
    message = e.message;
    result = { status: "failed" };
    if (opts.output !== "json") log(`✗ ${message}`);
    process.exitCode = e.exitCode;
  }

  const payload = {
    tool: "shipup",
    platform: opts.platform,
    command: opts.command,
    ok,
    appId: creds.app_id ?? "",
    packageName: creds.package_name ?? creds.bundle_id ?? "",
    summary: { total: 1, succeeded: ok ? 1 : 0, failed: ok ? 0 : 1, skipped: result.status === "skipped" ? 1 : 0 },
    results: [{ channel, ...result, errorCode, message, durationMs: Date.now() - started }],
  };
  if (opts.output === "json") {
    console.log(JSON.stringify(payload, null, 2));
  } else if (ok) {
    console.log(`${opts.platform} ${opts.command} ${result.status}${message ? `: ${message}` : ""}`);
  }
}

main().catch((e) => {
  if (e instanceof CliError) {
    console.error(e.message);
    process.exit(e.exitCode);
  }
  console.error(e.stack || String(e));
  process.exit(ExitCode.FAIL);
});
