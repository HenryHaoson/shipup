// iOS App Store Connect 适配。
//  upload  = altool 上传 ipa + (submitReview ? 等 build VALID → 建/取版本 → 多地区文案 → 关联 build → reviewSubmissions 三步)
//  status  = 查 appStoreVersion.appStoreState 并归一化
//  release = phased(开灰度) / complete|pause|resume(改灰度状态) / 否则手动发布请求
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type {
  ChannelAdapter,
  ChannelResult,
  NormalizedStatus,
  StatusContext,
  UploadContext,
} from '../../../core/types.js';
import { redactSensitive, UploadError } from '../../../core/types.js';
import { toFailed } from '../../util.js';
import { AscClient, type AscCreds, type LocalizationFields } from './asc.js';

const execFileAsync = promisify(execFile);

/** release 子命令上下文（cli 依赖，字段保持不变）。 */
export interface ReleaseContext {
  appId?: string;
  /** 无 appId 时用 bundleId 反查（二选一） */
  bundleId?: string;
  version: string;
  creds: Record<string, string | undefined>;
  phased: boolean;
  complete: boolean;
  pause: boolean;
  resume: boolean;
  timeoutMs: number;
}

/** appStoreState → 归一化状态。 */
function mapAppStoreState(state: string | null | undefined): NormalizedStatus {
  switch (state) {
    case 'WAITING_FOR_REVIEW':
    case 'IN_REVIEW':
      return 'pending_review';
    case 'PENDING_DEVELOPER_RELEASE':
    case 'PENDING_APPLE_RELEASE':
      return 'approved';
    case 'READY_FOR_SALE':
      return 'published';
    case 'REJECTED':
    case 'DEVELOPER_REJECTED':
    case 'METADATA_REJECTED':
    case 'INVALID_BINARY':
      return 'rejected';
    case 'DEVELOPER_REMOVED_FROM_SALE':
    case 'REMOVED_FROM_SALE':
    case 'REPLACED_WITH_NEW_VERSION':
      return 'offline';
    case 'PREPARE_FOR_SUBMISSION':
    case 'READY_FOR_REVIEW':
    case 'PROCESSING_FOR_APP_STORE':
      return 'uploaded';
    default:
      return 'failed';
  }
}

/** 组装各 locale 文案：有 metadata 用 metadata，否则用 whatsNew 作 zh-Hans whatsNew。 */
function buildLocaleMap(
  metadata?: Record<string, Record<string, string>>,
  whatsNew?: string,
): Record<string, LocalizationFields> {
  if (metadata && Object.keys(metadata).length > 0) {
    return metadata as Record<string, LocalizationFields>;
  }
  if (whatsNew) {
    return { 'zh-Hans': { whatsNew } };
  }
  return {};
}

/** App Store 已在审核/发布流程中的状态：此时重跑应跳过提审（幂等，CI 重跑安全）。 */
const IN_FLIGHT_STATES = new Set([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
  'PROCESSING_FOR_APP_STORE',
  'READY_FOR_SALE',
]);

/** submit 子命令上下文（不含 ipa；build 已由上游 altool 传过，只做提审）。 */
export interface SubmitContext {
  appId?: string;
  /** 无 appId 时用 bundleId 反查（二选一） */
  bundleId?: string;
  /** 营销版本号 versionString */
  version: string;
  /** build 号 CFBundleVersion，用于定位已上传的 build */
  buildVersion: string;
  creds: Record<string, string | undefined>;
  metadata?: Record<string, Record<string, string>>;
  whatsNew?: string;
  releaseType?: string;
  timeoutMs: number;
}

/**
 * 共享提审流程（upload --submit-review 与 submit 命令共用）：
 * 等 build VALID → 建/取版本 →（幂等守卫：已在审核流程则跳过）→ 文案 → 关联 build → 提交审核。
 * 不含 altool 上传。返回归一化状态 + 说明。
 */
async function runSubmitFlow(
  client: AscClient,
  opts: {
    appId: string;
    version: string;
    buildVersion: string;
    localeMap: Record<string, LocalizationFields>;
    releaseType?: string;
    deadline: number;
  },
): Promise<{ status: NormalizedStatus; message: string }> {
  const { appId, version, buildVersion, localeMap, releaseType, deadline } = opts;
  // 幂等守卫：版本已在审核/发布流程中则跳过重复提审。
  const existing = await client.getAppStoreVersion(appId, version);
  const state: string | undefined = existing?.attributes?.appStoreState;
  if (existing && state && IN_FLIGHT_STATES.has(state)) {
    return { status: mapAppStoreState(state), message: `版本已处于 ${state}，跳过重复提审` };
  }
  const buildId = await client.waitBuildValid(appId, buildVersion, version, deadline);
  const versionId = await client.ensureAppStoreVersion(appId, version, releaseType);
  await client.writeLocalizations(versionId, localeMap);
  await client.attachBuild(versionId, buildId);
  await client.submitForReview(appId, versionId);
  return { status: 'submitted', message: '' };
}

/** 把 p8 私钥落盘到 ~/.appstoreconnect/private_keys/AuthKey_<key_id>.p8（0600）供 altool 读取。 */
async function writeAuthKey(keyId: string, privateKey: string): Promise<string> {
  const dir = join(homedir(), '.appstoreconnect', 'private_keys');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `AuthKey_${keyId}.p8`);
  await writeFile(file, privateKey, { mode: 0o600 });
  return file;
}

/** xcrun altool 上传 ipa；瞬时失败有限次退避重试。失败 throw UploadError。 */
async function uploadViaAltool(ctx: UploadContext, keyId: string, issuerId: string): Promise<void> {
  await writeAuthKey(keyId, ctx.creds.private_key!);
  const args = [
    'altool',
    '--upload-app',
    '--type',
    'ios',
    '--file',
    ctx.pkg,
    '--apiKey',
    keyId,
    '--apiIssuer',
    issuerId,
  ];
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await execFileAsync('xcrun', args, { timeout: ctx.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      return;
    } catch (e: any) {
      const detail = redactSensitive(e?.stderr || e?.stdout || e?.message || e).slice(0, 1000);
      // 重试时若提示「已上传 / 冗余二进制」，说明上一次其实已成功，按成功处理（避免误判失败）。
      if (attempt > 1 && /already been uploaded|redundant binary|same version|already exists/i.test(detail)) {
        console.error('[shipup] altool: 检测到二进制已上传，按成功处理');
        return;
      }
      if (attempt === maxAttempts) throw new UploadError('altool', `altool 上传失败: ${detail}`);
      console.error(
        `[retry] altool 第 ${attempt}/${maxAttempts} 次失败，${2000 * attempt}ms 后重试: ${detail.slice(0, 200)}`,
      );
      await sleep(2000 * attempt);
    }
  }
}

export class IosAppStoreAdapter implements ChannelAdapter {
  readonly channel = 'appstore';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    const action = ctx.submitReview ? 'upload+submit' : 'upload';
    try {
      const keyId = ctx.creds.key_id!;
      const issuerId = ctx.creds.issuer_id!;
      const appId = ctx.creds.app_id!;

      // 1) altool 上传
      await uploadViaAltool(ctx, keyId, issuerId);

      // 2) 提审（复用 runSubmitFlow，含幂等守卫）
      if (ctx.submitReview) {
        const client = new AscClient({ keyId, issuerId, privateKey: ctx.creds.private_key! });
        const { status, message } = await runSubmitFlow(client, {
          appId,
          version: ctx.versionName,
          buildVersion: ctx.versionCode,
          localeMap: buildLocaleMap(ctx.metadata, ctx.releaseNote),
          releaseType: ctx.releaseType,
          deadline: Date.now() + ctx.timeoutMs,
        });
        return {
          channel: this.channel,
          packageName: appId,
          versionName: ctx.versionName,
          versionCode: ctx.versionCode,
          action: 'upload+submit',
          status,
          errorCode: null,
          message,
          durationMs: Date.now() - start,
        };
      }

      return {
        channel: this.channel,
        packageName: appId,
        versionName: ctx.versionName,
        versionCode: ctx.versionCode,
        action: 'upload',
        status: 'uploaded',
        errorCode: null,
        message: '',
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, action, ctx);
    }
  }

  /**
   * 出口合规由 app 工程 Info.plist 的 ITSAppUsesNonExemptEncryption 声明（不在本工具处理）。
   */
  async submit(ctx: SubmitContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const client = new AscClient({
        keyId: ctx.creds.key_id!,
        issuerId: ctx.creds.issuer_id!,
        privateKey: ctx.creds.private_key!,
      });
      const appId = await client.resolveAppId(ctx.appId ?? ctx.creds.app_id, ctx.bundleId);
      const { status, message } = await runSubmitFlow(client, {
        appId,
        version: ctx.version,
        buildVersion: ctx.buildVersion,
        localeMap: buildLocaleMap(ctx.metadata, ctx.whatsNew),
        releaseType: ctx.releaseType,
        deadline: Date.now() + ctx.timeoutMs,
      });
      return {
        channel: this.channel,
        packageName: appId,
        versionName: ctx.version,
        versionCode: ctx.buildVersion,
        action: 'submit',
        status,
        errorCode: null,
        message,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'submit', {
        packageName: ctx.appId ?? ctx.bundleId,
        versionName: ctx.version,
        versionCode: ctx.buildVersion,
      });
    }
  }

  async queryStatus(ctx: StatusContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const creds: AscCreds = {
        keyId: ctx.creds.key_id!,
        issuerId: ctx.creds.issuer_id!,
        privateKey: ctx.creds.private_key!,
      };
      const client = new AscClient(creds);
      const appId = await client.resolveAppId(ctx.creds.app_id, ctx.bundleId);
      const version = ctx.versionName ?? '';
      const v = await client.getAppStoreVersion(appId, version);
      const state: string | null = v?.attributes?.appStoreState ?? null;
      let message = state ?? 'version not found';
      // 已发布/待发布时附带灰度进度（若开启灰度），便于调用方判断阶段。
      if (v && (state === 'READY_FOR_SALE' || state === 'PENDING_DEVELOPER_RELEASE')) {
        try {
          const phased = await client.getPhasedRelease(v.id as string);
          const ps = phased?.attributes?.phasedReleaseState;
          if (ps) message += ` | phased=${ps} day=${phased.attributes.currentDayNumber ?? '-'}`;
        } catch {
          /* 灰度查询失败不影响主状态 */
        }
      }
      return {
        channel: this.channel,
        packageName: appId,
        versionName: version,
        action: 'status',
        status: mapAppStoreState(state),
        marketVersion: v?.attributes?.versionString,
        errorCode: null,
        message,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }

  async release(ctx: ReleaseContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const creds: AscCreds = {
        keyId: ctx.creds.key_id!,
        issuerId: ctx.creds.issuer_id!,
        privateKey: ctx.creds.private_key!,
      };
      const client = new AscClient(creds);
      const appId = await client.resolveAppId(ctx.appId ?? ctx.creds.app_id, ctx.bundleId);
      const v = await client.getAppStoreVersion(appId, ctx.version);
      if (!v) throw new UploadError('not_found', `未找到 appStoreVersion: ${ctx.version}`);
      const versionId = v.id as string;

      let status: NormalizedStatus = 'published';
      let message: string;

      if (ctx.complete || ctx.pause || ctx.resume) {
        const phased = await client.getPhasedRelease(versionId);
        if (!phased) throw new UploadError('no_phased', '当前版本未开启灰度发布');
        const state = ctx.complete ? 'COMPLETE' : ctx.pause ? 'PAUSED' : 'ACTIVE';
        await client.setPhasedReleaseState(phased.id as string, state);
        message = `phasedReleaseState=${state}`;
        status = ctx.complete ? 'published' : 'approved';
      } else if (ctx.phased) {
        // 1) 确保灰度资源存在（幂等）。Apple 一个版本只允许一个灰度，重复 POST 会 409 DUPLICATE；
        //    灰度也可能是手动提交时在 ASC 勾选「分阶段发布」而先创建的，这里都视为已就绪。
        const existing = await client.getPhasedRelease(versionId);
        if (!existing) await client.startPhasedRelease(versionId);
        const phasedNote = existing ? '灰度已存在' : '已开启灰度';

        // 2) 灰度只是「发布方式」，真正上架还需触发发布：
        //    MANUAL 版本过审后停在 PENDING_DEVELOPER_RELEASE，需 requestRelease 才会上架并按灰度放量；
        //    AFTER_APPROVAL 过审自动发、审核中的版本不能发，都不触发（仅预置灰度）。
        const appStoreState = v.attributes?.appStoreState as string | undefined;
        if (appStoreState === 'PENDING_DEVELOPER_RELEASE') {
          await client.requestRelease(versionId);
          status = 'published';
          message = `${phasedNote}，已触发发布（按 7 天灰度放量）`;
        } else {
          status = 'approved';
          message = `${phasedNote}（当前状态 ${appStoreState ?? '未知'}，未触发发布）`;
        }
      } else {
        await client.requestRelease(versionId);
        message = 'release requested';
      }

      return {
        channel: this.channel,
        packageName: appId,
        versionName: ctx.version,
        action: 'release',
        status,
        errorCode: null,
        message,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'release');
    }
  }
}
