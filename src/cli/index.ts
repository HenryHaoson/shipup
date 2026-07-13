#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { ExitCode, UsageError, CredsError, InputError } from '../core/exit.js';
import type { UploadContext, ChannelResult } from '../core/types.js';
import { loadCreds, getChannelCreds } from '../creds/load.js';
import { validateChannelCreds, validateIosCreds } from '../creds/schema.js';
import { parsePackage, detectCompat32 } from '../pkginfo/index.js';
import { getAndroidAdapter, getIosAdapter } from '../adapters/registry.js';
import { runUploads, type UploadTask } from '../core/orchestrator.js';
import { buildOutput, exitCodeFor, printOutput } from './output.js';

// 版本号从 package.json 读取，避免与 .version() 字面量不一致。
const VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

const DEFAULT_CREDS = join(homedir(), '.config', 'shipup', 'credentials.yaml');

function resolveCredsPath(value?: string): string {
  const path = value || process.env.SHIPUP_CREDS || DEFAULT_CREDS;
  if (!existsSync(path)) {
    throw new CredsError(
      '未找到凭证：请传 --creds、设置 SHIPUP_CREDS，或创建 ~/.config/shipup/credentials.yaml',
    );
  }
  return path;
}

function readText(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (v.startsWith('@')) {
    const p = resolve(v.slice(1));
    if (!existsSync(p)) throw new InputError(`文件不存在: ${p}`);
    return readFileSync(p, 'utf8');
  }
  return v;
}

function parseUploads(items: string[] | undefined): Array<{ channel: string; path: string }> {
  if (!items || items.length === 0) throw new UsageError('至少需要一个 --upload 渠道=包路径');
  return items.map((s) => {
    const i = s.indexOf('=');
    if (i <= 0) throw new UsageError(`--upload 格式应为 渠道=路径: ${s}`);
    return { channel: s.slice(0, i).trim(), path: s.slice(i + 1).trim() };
  });
}

function parseTimeoutMs(opts: any): number {
  if (!['json', 'text'].includes(opts.output)) {
    throw new UsageError('--output 只能是 json 或 text');
  }
  const seconds = Number(opts.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError('--timeout 必须是正数（秒）');
  }
  return seconds * 1000;
}

function parseConcurrency(value: unknown): number {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new UsageError('--concurrency 必须是正整数');
  }
  return concurrency;
}

// ---------- android upload ----------
async function androidUpload(opts: any): Promise<void> {
  const creds = loadCreds(resolveCredsPath(opts.creds), 'android');
  const uploads = parseUploads(opts.upload);
  const timeoutMs = parseTimeoutMs(opts);
  const concurrency = parseConcurrency(opts.concurrency);
  const releaseNote = readText(opts.releaseNote);
  const iconPath: string | undefined = opts.icon;
  if (iconPath && !existsSync(iconPath)) throw new InputError(`图标文件不存在: ${iconPath}`);
  const screenshots: string[] = opts.screenshot ?? [];
  for (const s of screenshots) {
    if (!existsSync(s)) throw new InputError(`截图文件不存在: ${s}`);
  }
  const appName: string | undefined = opts.appName;
  const summary: string | undefined = opts.summary;
  const description = readText(opts.description);

  if (!opts.submitReview) {
    console.error(
      '[shipup] 注意：Android 各渠道 upload 即提交审核/发布，无法只传不提审；--submit-review 仅作显式声明。',
    );
  }

  // 单渠道预检失败（凭证缺字段 / 包文件缺失 / 渠道名错）降级为该渠道 failed 结果，不中断整批。
  const tasks: UploadTask[] = [];
  const preFailed: ChannelResult[] = [];
  for (const u of uploads) {
    try {
      const adapter = getAndroidAdapter(u.channel);
      const chCreds = getChannelCreds(creds, u.channel);
      validateChannelCreds(u.channel, chCreds);
      if (!existsSync(u.path)) throw new InputError(`包文件不存在: ${u.path}`);

      let packageName = creds.package_name ?? '';
      let versionName = opts.versionName ?? '';
      let versionCode = opts.versionCode ?? '';
      if (!packageName || !versionName || !versionCode) {
        const meta = await parsePackage(u.path);
        packageName ||= meta.packageName;
        versionName ||= meta.versionName;
        versionCode ||= meta.versionCode;
      }
      const compat32 = detectCompat32(u.path);

      const ctx: UploadContext = {
        pkg: u.path,
        packageName,
        versionName,
        versionCode,
        releaseNote,
        submitReview: !!opts.submitReview,
        compat32,
        iconPath,
        updateIcon: !!opts.updateIcon,
        screenshots,
        appName,
        summary,
        description,
        creds: chCreds,
        timeoutMs,
      };
      tasks.push({ adapter, ctx });
    } catch (e) {
      const code =
        e instanceof CredsError
          ? 'creds'
          : e instanceof InputError
            ? 'input'
            : e instanceof UsageError
              ? 'usage'
              : 'error';
      preFailed.push({
        channel: u.channel,
        action: 'upload',
        status: 'failed',
        errorCode: code,
        message: e instanceof Error ? e.message : String(e),
      });
      console.error(`[shipup] ${u.channel} 预检失败: [${code}] ${e instanceof Error ? e.message : e}`);
    }
  }

  if (opts.dryRun) {
    const dryResults: ChannelResult[] = tasks.map((task) => ({
      channel: task.adapter.channel,
      packageName: task.ctx.packageName,
      versionName: task.ctx.versionName,
      versionCode: task.ctx.versionCode,
      action: task.ctx.submitReview ? 'upload+submit' : 'upload',
      status: 'skipped',
      message: 'dry-run',
    }));
    const out = buildOutput('android', 'upload', [...dryResults, ...preFailed]);
    printOutput(out, opts.output);
    process.exit(exitCodeFor(out));
  }

  const results = [...(await runUploads(tasks, concurrency)), ...preFailed];
  const out = buildOutput('android', 'upload', results);
  printOutput(out, opts.output);
  process.exit(exitCodeFor(out));
}

// ---------- android status ----------
async function androidStatus(opts: any): Promise<void> {
  const timeoutMs = parseTimeoutMs(opts);
  const creds = loadCreds(resolveCredsPath(opts.creds), 'android');
  const adapter = getAndroidAdapter(opts.channel);
  const chCreds = getChannelCreds(creds, opts.channel);
  validateChannelCreds(opts.channel, chCreds);
  if (opts.dryRun) {
    const out = buildOutput('android', 'status', [{
      channel: opts.channel,
      packageName: opts.packageName ?? creds.package_name,
      versionName: opts.versionName,
      versionCode: opts.versionCode,
      action: 'status',
      status: 'skipped',
      message: 'dry-run',
    }]);
    printOutput(out, opts.output);
    process.exit(ExitCode.OK);
  }
  const res = await adapter.queryStatus({
    packageName: opts.packageName ?? creds.package_name,
    versionName: opts.versionName,
    versionCode: opts.versionCode,
    creds: chCreds,
    timeoutMs,
  });
  const out = buildOutput('android', 'status', [res]);
  printOutput(out, opts.output);
  process.exit(exitCodeFor(out));
}

// 发布策略校验：仅 MANUAL / AFTER_APPROVAL。SCHEDULED（定时发布）需要 earliestReleaseDate，
// 全链路未实现日期参数，故主动拒绝，避免设置了 releaseType 却无日期的无效版本。
function assertReleaseType(rt?: string): void {
  if (rt && rt !== 'MANUAL' && rt !== 'AFTER_APPROVAL') {
    throw new UsageError(
      `--release-type 仅支持 MANUAL | AFTER_APPROVAL（收到 "${rt}"）。SCHEDULED 定时发布暂不支持（需发布日期参数，未实现）。`,
    );
  }
}

// ---------- ios upload ----------
async function iosUpload(opts: any): Promise<void> {
  const timeoutMs = parseTimeoutMs(opts);
  const creds = loadCreds(resolveCredsPath(opts.creds), 'ios');
  validateIosCreds(creds);
  assertReleaseType(opts.releaseType);
  if (!existsSync(opts.package)) throw new InputError(`ipa 不存在: ${opts.package}`);
  if (opts.submitReview && !(opts.appId ?? creds.app_id)) {
    throw new UsageError('iOS 提审需要 app Apple ID：请传 --app-id 或在 creds 配 app_id');
  }

  let versionName = opts.versionName ?? '';
  let versionCode = opts.buildVersion ?? '';
  if (!versionName || !versionCode) {
    const meta = await parsePackage(opts.package).catch(() => null);
    if (meta) {
      versionName ||= meta.versionName;
      versionCode ||= meta.versionCode;
    }
  }

  let metadata: Record<string, Record<string, string>> | undefined;
  if (opts.metadata) {
    if (!existsSync(opts.metadata)) throw new InputError(`metadata 文件不存在: ${opts.metadata}`);
    metadata = parseYaml(readFileSync(opts.metadata, 'utf8')) as Record<string, Record<string, string>>;
  }

  const adapter = getIosAdapter();
  const ctx: UploadContext = {
    pkg: opts.package,
    packageName: opts.appId ?? '',
    versionName,
    versionCode,
    releaseNote: readText(opts.whatsNew),
    submitReview: !!opts.submitReview,
    metadata,
    releaseType: opts.releaseType,
    creds: { ...creds, team_id: opts.teamId ?? creds.team_id, app_id: opts.appId ?? creds.app_id },
    timeoutMs,
  };

  if (opts.dryRun) {
    const out = buildOutput('ios', 'upload', [{
      channel: 'appstore',
      packageName: ctx.packageName,
      versionName: ctx.versionName,
      versionCode: ctx.versionCode,
      action: ctx.submitReview ? 'upload+submit' : 'upload',
      status: 'skipped',
      message: 'dry-run',
    }]);
    printOutput(out, opts.output);
    process.exit(ExitCode.OK);
  }

  const res = await adapter.upload(ctx);
  const out = buildOutput('ios', 'upload', [res]);
  printOutput(out, opts.output);
  process.exit(exitCodeFor(out));
}

// ---------- ios status ----------
async function iosStatus(opts: any): Promise<void> {
  const timeoutMs = parseTimeoutMs(opts);
  const creds = loadCreds(resolveCredsPath(opts.creds), 'ios');
  validateIosCreds(creds);
  if (!opts.appId && !creds.app_id && !opts.bundleId)
    throw new UsageError('iOS 查状态需要 app 标识：请传 --app-id 或 --bundle-id（或在 creds 配 app_id）');
  if (opts.dryRun) {
    const out = buildOutput('ios', 'status', [{
      channel: 'appstore', action: 'status', status: 'skipped',
      versionName: opts.appVersion, message: 'dry-run',
    }]);
    printOutput(out, opts.output);
    process.exit(ExitCode.OK);
  }
  const adapter = getIosAdapter();
  const res = await adapter.queryStatus({
    versionName: opts.appVersion,
    bundleId: opts.bundleId,
    creds: { ...creds, app_id: opts.appId ?? creds.app_id },
    timeoutMs,
  });
  const out = buildOutput('ios', 'status', [res]);
  printOutput(out, opts.output);
  process.exit(exitCodeFor(out));
}

// ---------- ios release ----------
async function iosRelease(opts: any): Promise<void> {
  const timeoutMs = parseTimeoutMs(opts);
  const creds = loadCreds(resolveCredsPath(opts.creds), 'ios');
  validateIosCreds(creds);
  if (!opts.appId && !creds.app_id && !opts.bundleId)
    throw new UsageError('iOS 发布需要 app 标识：请传 --app-id 或 --bundle-id（或在 creds 配 app_id）');
  if (opts.dryRun) {
    const out = buildOutput('ios', 'release', [{
      channel: 'appstore', action: 'release', status: 'skipped',
      versionName: opts.appVersion, message: 'dry-run',
    }]);
    printOutput(out, opts.output);
    process.exit(ExitCode.OK);
  }
  const adapter = getIosAdapter();
  const res: ChannelResult = await adapter.release({
    appId: opts.appId ?? creds.app_id,
    bundleId: opts.bundleId,
    version: opts.appVersion,
    creds,
    phased: !!opts.phased,
    complete: !!opts.complete,
    pause: !!opts.pause,
    resume: !!opts.resume,
    timeoutMs,
  });
  const out = buildOutput('ios', 'release', [res]);
  printOutput(out, opts.output);
  process.exit(exitCodeFor(out));
}

// ---------- ios submit ----------
async function iosSubmit(opts: any): Promise<void> {
  const timeoutMs = parseTimeoutMs(opts);
  const creds = loadCreds(resolveCredsPath(opts.creds), 'ios');
  validateIosCreds(creds);
  assertReleaseType(opts.releaseType);
  const appId = opts.appId ?? creds.app_id;
  if (!appId && !opts.bundleId)
    throw new UsageError('iOS 提审需要 app 标识：请传 --app-id 或 --bundle-id（或在 creds 配 app_id）');
  let metadata: Record<string, Record<string, string>> | undefined;
  if (opts.metadata) {
    if (!existsSync(opts.metadata)) throw new InputError(`metadata 文件不存在: ${opts.metadata}`);
    metadata = parseYaml(readFileSync(opts.metadata, 'utf8')) as Record<string, Record<string, string>>;
  }
  if (opts.dryRun) {
    const out = buildOutput('ios', 'submit', [{
      channel: 'appstore', action: 'submit', status: 'skipped',
      versionName: opts.appVersion, versionCode: opts.buildVersion, message: 'dry-run',
    }]);
    printOutput(out, opts.output);
    process.exit(ExitCode.OK);
  }
  const adapter = getIosAdapter();
  const res = await adapter.submit({
    appId,
    bundleId: opts.bundleId,
    version: opts.appVersion,
    buildVersion: opts.buildVersion,
    creds,
    metadata,
    whatsNew: readText(opts.whatsNew),
    releaseType: opts.releaseType,
    timeoutMs,
  });
  const out = buildOutput('ios', 'submit', [res]);
  printOutput(out, opts.output);
  process.exit(exitCodeFor(out));
}

function mapError(e: unknown): number {
  if (e instanceof UsageError) return ExitCode.USAGE;
  if (e instanceof CredsError) return ExitCode.CREDS;
  if (e instanceof InputError) return ExitCode.INPUT;
  if (e instanceof Error && e.name === 'TimeoutError') return ExitCode.TIMEOUT;
  return ExitCode.ALL_FAILED;
}

function build(): Command {
  const program = new Command();
  program
    .name('shipup')
    .description('跨平台应用商店上传、提审、状态查询与发布 CLI')
    .version(VERSION);

  const android = program.command('android').description('Android 多渠道传包/提审/状态');

  android
    .command('upload')
    .description('上传（并按需提审）一个或多个单渠道包')
    .option('--upload <map...>', '渠道=包路径，可重复，如 huawei=./app-huawei.apk')
    .option('--creds <file>', '凭证 YAML；默认 SHIPUP_CREDS 或 ~/.config/shipup/credentials.yaml')
    .option('--submit-review', '上传后提交审核（部分渠道 upload 即 submit）', false)
    .option('--version-name <v>', '缺省从 APK 读取')
    .option('--version-code <v>', '缺省从 APK 读取')
    .option('--release-note <v>', '更新说明，支持 @file')
    .option('--icon <path>', '图标文件（小米/魅族必需；其余渠道需配合 --update-icon）')
    .option('--update-icon', '同时更新华为/荣耀/OPPO/vivo/三星的图标（默认沿用商店现有图标）', false)
    .option('--screenshot <path...>', '截图/介绍图文件，可多次/多值；非空时更新该渠道截图')
    .option('--app-name <v>', '更新应用名称（注意各渠道限改频率与禁特殊符号）')
    .option('--summary <v>', '更新一句话简介 / 推荐语')
    .option('--description <v>', '更新应用简介 / 长描述，支持 @file')
    .option('--concurrency <n>', '渠道并发数', '3')
    .option('--timeout <s>', '单渠道超时（秒）', '900')
    .option('--output <fmt>', 'json | text', 'text')
    .option('--dry-run', '只校验参数与凭证，不真正上传', false)
    .action(androidUpload);

  android
    .command('status')
    .description('查询某渠道审核/上架状态')
    .requiredOption('--channel <channel>', '单个渠道（huawei|honor|oppo|vivo|xiaomi|samsung|qq|meizu）')
    .option('--creds <file>', '凭证 YAML；默认 SHIPUP_CREDS 或 ~/.config/shipup/credentials.yaml')
    .option('--package-name <v>', '应用包名（缺省用 creds.package_name）')
    .option('--version-name <v>', '版本名，用于定位具体版本')
    .option('--version-code <v>', '版本号，用于定位具体版本（优先于 version-name）')
    .option('--timeout <s>', '查询超时（秒）', '900')
    .option('--output <fmt>', '输出格式 json | text', 'text')
    .option('--dry-run', '只校验参数与凭证，不查询', false)
    .action(androidStatus);

  const ios = program.command('ios').description('iOS App Store Connect 传包/提审/发布');

  ios
    .command('upload')
    .description('altool 上传 + 建版本 + 文案 + 合规 + 关联 build +（可选）提交审核')
    .requiredOption('--package <ipa>', '已签名 ipa 路径')
    .option('--creds <file>', '凭证 YAML；默认 SHIPUP_CREDS 或 ~/.config/shipup/credentials.yaml')
    .option('--team-id <v>', '开发者 Team ID（缺省用 creds.team_id）')
    .option('--app-id <v>', 'ASC 上的 app Apple ID（提审必填，缺省用 creds.app_id）')
    .option('--metadata <file>', '多地区文案 YAML（locale → whatsNew/description/promotionalText/keywords）')
    .option('--whats-new <v>', '单一 locale 的 whatsNew，支持 @file（无 metadata 时作 zh-Hans）')
    .option('--submit-review', '上传后走 ASC API 提交 App Store 审核', false)
    .option('--release-type <v>', '发布策略 MANUAL | AFTER_APPROVAL')
    .option('--version-name <v>', '营销版本号，缺省从 ipa 读取')
    .option('--build-version <v>', 'build 号（CFBundleVersion），缺省从 ipa 读取')
    .option('--timeout <s>', 'altool 上传 + 提审超时（秒）', '1800')
    .option('--output <fmt>', '输出格式 json | text', 'text')
    .option('--dry-run', '只校验参数与凭证，不上传', false)
    .action(iosUpload);

  ios
    .command('status')
    .description('查询 App Store 审核/版本/灰度状态')
    .option('--creds <file>', '凭证 YAML；默认 SHIPUP_CREDS 或 ~/.config/shipup/credentials.yaml')
    .option('--app-id <v>', 'ASC 上的 app Apple ID（与 --bundle-id 二选一，缺省用 creds.app_id）')
    .option('--bundle-id <v>', 'app bundle id，自动反查 Apple ID（与 --app-id 二选一）')
    .requiredOption('--app-version <v>', '要查询的版本号')
    .option('--timeout <s>', '查询超时（秒）', '900')
    .option('--output <fmt>', '输出格式 json | text', 'text')
    .option('--dry-run', '只校验参数与凭证，不查询', false)
    .action(iosStatus);

  ios
    .command('release')
    .description('审核通过后发布（手动 release / 灰度）')
    .option('--creds <file>', '凭证 YAML；默认 SHIPUP_CREDS 或 ~/.config/shipup/credentials.yaml')
    .option('--app-id <v>', 'ASC 上的 app Apple ID（与 --bundle-id 二选一，缺省用 creds.app_id）')
    .option('--bundle-id <v>', 'app bundle id，自动反查 Apple ID（与 --app-id 二选一）')
    .requiredOption('--app-version <v>', '要发布的版本号')
    .option('--phased', '以灰度方式开始发布（不向所有用户全量）', false)
    .option('--complete', '把进行中的灰度立即转为全量', false)
    .option('--pause', '暂停进行中的灰度', false)
    .option('--resume', '恢复已暂停的灰度', false)
    .option('--timeout <s>', '操作超时（秒）', '900')
    .option('--output <fmt>', '输出格式 json | text', 'text')
    .option('--dry-run', '只校验参数与凭证，不发布', false)
    .action(iosRelease);

  ios
    .command('submit')
    .description('提审已上传的 build（不重传；build 由上游 altool 上传）')
    .option('--creds <file>', '凭证 YAML；默认 SHIPUP_CREDS 或 ~/.config/shipup/credentials.yaml')
    .option('--app-id <v>', 'ASC 上的 app Apple ID（与 --bundle-id 二选一，缺省用 creds.app_id）')
    .option('--bundle-id <v>', 'app bundle id，自动反查 Apple ID（与 --app-id 二选一）')
    .requiredOption('--app-version <v>', '营销版本号 versionString')
    .requiredOption('--build-version <v>', 'build 号 CFBundleVersion（用于定位已上传的 build）')
    .option('--metadata <file>', '多地区文案 YAML（locale → whatsNew/description/...）')
    .option('--whats-new <v>', '单一 locale 的 whatsNew，支持 @file（无 metadata 时作 zh-Hans）')
    .option('--release-type <v>', '发布策略 MANUAL | AFTER_APPROVAL')
    .option('--timeout <s>', '等 build 就绪 + 提审超时（秒）', '1800')
    .option('--output <fmt>', '输出格式 json | text', 'text')
    .option('--dry-run', '只校验参数与凭证，不调用 ASC', false)
    .action(iosSubmit);

  return program;
}

const normalizedArgv = [...process.argv];
if (normalizedArgv[2] === 'ios') {
  const command = normalizedArgv[3];
  for (let i = 4; i < normalizedArgv.length; i++) {
    if (normalizedArgv[i] === '--version') {
      normalizedArgv[i] = command === 'upload' ? '--version-name' : '--app-version';
    } else if (normalizedArgv[i] === '--build') {
      normalizedArgv[i] = '--build-version';
    }
  }
}

build()
  .parseAsync(normalizedArgv)
  .catch((e) => {
    process.stderr.write(`shipup: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(mapError(e));
  });
