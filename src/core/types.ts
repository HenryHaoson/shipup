// 通用类型：渠道适配统一接口 + 归一化状态。两端（android/ios）共用。

/** 工具对外暴露的归一化状态（各市场原始状态由 adapter 映射到这里） */
export type NormalizedStatus =
  | 'uploaded' // 已上传，未提审
  | 'submitted' // 已提交审核
  | 'pending_review' // 排队 / 审核中
  | 'approved' // 审核通过
  | 'published' // 已上架
  | 'rejected' // 驳回
  | 'offline' // 已下架 / 撤销
  | 'failed' // 操作失败
  | 'skipped' // 该渠道未配置 / 不适用
  | 'not_implemented'; // 适配未实现（桩）

export type ChannelAction = 'upload' | 'upload+submit' | 'submit' | 'status' | 'release';

/** 单渠道（iOS 为单条 appstore/testflight）结果 */
export interface ChannelResult {
  channel: string;
  packageName?: string;
  versionName?: string;
  versionCode?: string;
  action: ChannelAction;
  status: NormalizedStatus;
  /** 该市场当前已知线上版本（可选） */
  marketVersion?: string;
  /** 失败时为各市场原始错误码；成功为 null */
  errorCode?: string | null;
  message?: string;
  durationMs?: number;
}

/** 已解析为明文的某渠道凭证（字段随渠道而异） */
export type ChannelCreds = Record<string, string | undefined>;

/** 华为 Android 发布通道。auto 会在存在上架中的分阶段版本时继续走分阶段升级。 */
export type HuaweiReleaseMode = 'auto' | 'full' | 'phased';

export interface HuaweiReleaseOptions {
  mode?: HuaweiReleaseMode;
  /** 显式创建分阶段版本时可覆盖当前分阶段配置；auto 默认继承在架版本。 */
  phased?: {
    startTime?: string;
    endTime?: string;
    percent?: string;
    description?: string;
  };
}

/** 渠道特有的发布参数集中放置，避免继续向 UploadContext 增加扁平字段。 */
export interface ChannelReleaseOptions {
  huawei?: HuaweiReleaseOptions;
}

export interface UploadContext {
  /** 本地包路径（android: apk；ios: ipa） */
  pkg: string;
  packageName: string;
  versionName: string;
  versionCode: string;
  releaseNote?: string;
  privacyUrl?: string;
  /** 是否在上传后提交审核（部分渠道 upload 即 submit，由 adapter 决定语义） */
  submitReview: boolean;
  /** android：apk 是否含 32 位 so（应用宝 apk32/apk64 槽位判定等用） */
  compat32?: boolean;
  /** 图标文件路径（外部提供，shipup 按渠道尺寸缩放）。小米/魅族必需；其余仅 updateIcon 时用 */
  iconPath?: string;
  /** 是否更新「可选图标」渠道（华为/荣耀/OPPO/vivo/三星）的图标；默认 false=沿用商店现有图标 */
  updateIcon?: boolean;
  /** 截图/介绍图文件路径列表（外部提供）。非空时更新该渠道截图；空=沿用线上 */
  screenshots?: string[];
  /** 应用名称（更新则传） */
  appName?: string;
  /** 一句话简介 / 推荐语（更新则传） */
  summary?: string;
  /** 应用简介 / 长描述（更新则传） */
  description?: string;
  /** iOS：多地区文案 locale -> {whatsNew,description,promotionalText,keywords} */
  metadata?: Record<string, Record<string, string>>;
  /** iOS：发布策略 MANUAL | AFTER_APPROVAL */
  releaseType?: string;
  /** iOS：开启 7 天灰度 */
  phased?: boolean;
  /** Android 各渠道的发布通道策略。 */
  releaseOptions?: ChannelReleaseOptions;
  creds: ChannelCreds;
  timeoutMs: number;
}

export interface StatusContext {
  packageName?: string;
  versionName?: string;
  versionCode?: string;
  /** iOS：无 app_id 时用 bundleId 反查 app 的数字 Apple ID */
  bundleId?: string;
  creds: ChannelCreds;
  timeoutMs: number;
}

/** 渠道适配统一接口 */
export interface ChannelAdapter {
  readonly channel: string;
  upload(ctx: UploadContext): Promise<ChannelResult>;
  queryStatus(ctx: StatusContext): Promise<ChannelResult>;
}

/** Remove credentials, signed query values, private keys, and long opaque tokens from diagnostics. */
export function redactSensitive(value: unknown): string {
  return String(value ?? '')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '<redacted-private-key>')
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,}\]]+/gi, '$1<redacted>')
    .replace(
      /(["']?(?:access_?token|refresh_?token|client_?secret|access_?secret|private_?key|password|authCode|token|registered_?id_?number)["']?\s*[:=]\s*["']?)([^"'\s,&}\]]+)/gi,
      '$1<redacted>',
    )
    .replace(/([?&](?:access_?token|client_?secret|access_?secret|password|authCode|signature|sign)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, '<redacted-opaque-value>');
}

/** 各市场抛出的业务错误：携带原始码 */
export class UploadError extends Error {
  readonly code: string;
  constructor(code: string | number, message: string) {
    super(redactSensitive(message));
    this.name = 'UploadError';
    this.code = String(code);
  }
}
