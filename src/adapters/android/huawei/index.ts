import type {
  ChannelAdapter,
  ChannelResult,
  StatusContext,
  UploadContext,
  NormalizedStatus,
} from '../../../core/types.js';
import { toFailed } from '../../util.js';
import { prepareScreenshot } from '../../../pkginfo/icon.js';
import { resolveIconBytes } from '../../../pkginfo/apk-icon.js';
import { getChannelSpec, warnIfTooLong } from '../specs.js';
import { queryHuaweiAppInfo, uploadHuawei } from './api.js';

// 华为 releaseState 映射（参考 status/providers/huawei_provider.dart 的官方语义）：
//  0  已上架            → published
//  1/8/9/13 审核不通过  → rejected
//  3/4/5/12 审核/预审中 → pending_review
//  2/6/10/11 下架/撤销  → offline
//  7  草稿              → uploaded
//  其它/缺失           → submitted（刚提交，暂无更细状态）
function mapReleaseState(state: number | null): NormalizedStatus {
  switch (state) {
    case 0:
      return 'published';
    case 1:
    case 8:
    case 9:
    case 13:
      return 'rejected';
    case 3:
    case 4:
    case 5:
    case 12:
      return 'pending_review';
    case 2:
    case 6:
    case 10:
    case 11:
      return 'offline';
    case 7:
      return 'uploaded';
    default:
      return 'submitted';
  }
}

/** 华为应用市场：上传 APK 后直接提交审核，upload 始终为 upload+submit。 */
export class HuaweiAdapter implements ChannelAdapter {
  readonly channel = 'huawei';

  async upload(ctx: UploadContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const spec = getChannelSpec(this.channel);
      // 图标按需更新：--update-icon 时取图标——优先 --icon，否则 aapt 从 APK 自动提取（最高密度 PNG）；
      // 不更新则 undefined，uploadHuawei 跳过图标步骤沿用线上。
      const iconBytes = ctx.updateIcon
        ? await resolveIconBytes({
            iconPath: ctx.iconPath,
            apkPath: ctx.pkg,
            size: spec.iconSize,
            maxBytes: spec.iconMaxBytes,
          })
        : undefined;
      // 截图按需（--screenshot 为全量替换）：传入即视为该语言的完整截图集，会覆盖线上原有截图，
      // 而非在原有截图上追加（覆盖语义详见 api.ts updateScreenshots 注释）。
      // 每张先按渠道格式（华为 png）+ 大小上限编码。
      const screenshots =
        ctx.screenshots && ctx.screenshots.length > 0
          ? await Promise.all(
              ctx.screenshots.map((p) => prepareScreenshot(p, 'png', spec.screenshotMaxBytes)),
            )
          : undefined;
      // 文案写前长度告警（仅提示，不阻断；huawei spec 无 appNameMax 时 warnIfTooLong 自动跳过）。
      warnIfTooLong(this.channel, 'appName', ctx.appName, spec.appNameMax);
      warnIfTooLong(this.channel, 'summary', ctx.summary, spec.summaryMax);
      warnIfTooLong(this.channel, 'description', ctx.description, spec.descriptionMax);
      await uploadHuawei({
        appId: ctx.creds.app_id!,
        clientId: ctx.creds.client_id!,
        clientSecret: ctx.creds.client_secret!,
        apkPath: ctx.pkg,
        packageName: ctx.packageName,
        iconBytes,
        releaseNote: ctx.releaseNote,
        appName: ctx.appName,
        summary: ctx.summary,
        description: ctx.description,
        screenshots,
        privacyUrl: ctx.privacyUrl,
        greenVerifyFileUrl: ctx.creds.green_verify_file_url,
        registeredIdType: ctx.creds.registered_id_type,
        registeredIdNumber: ctx.creds.registered_id_number,
        callbackAddr: ctx.creds.callback_addr,
        releaseOptions: ctx.releaseOptions?.huawei,
        timeoutMs: ctx.timeoutMs,
      });
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        versionName: ctx.versionName,
        versionCode: ctx.versionCode,
        action: 'upload+submit',
        status: 'submitted',
        errorCode: null,
        message: '',
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'upload+submit', ctx);
    }
  }

  async queryStatus(ctx: StatusContext): Promise<ChannelResult> {
    const start = Date.now();
    try {
      const data = await queryHuaweiAppInfo({
        appId: ctx.creds.app_id!,
        clientId: ctx.creds.client_id!,
        clientSecret: ctx.creds.client_secret!,
        timeoutMs: ctx.timeoutMs,
      });
      const appInfo = data?.appInfo ?? data ?? {};
      const stateRaw = appInfo?.releaseState;
      const state =
        stateRaw === undefined || stateRaw === null || stateRaw === ''
          ? null
          : Number(stateRaw);
      const marketVersion =
        appInfo?.onShelfVersionNumber?.toString() ?? appInfo?.versionNumber?.toString();
      return {
        channel: this.channel,
        packageName: ctx.packageName,
        action: 'status',
        status: mapReleaseState(Number.isNaN(state as number) ? null : state),
        marketVersion,
        errorCode: null,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return toFailed(this.channel, e, start, 'status');
    }
  }
}
