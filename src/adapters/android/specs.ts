// 各渠道素材/文案规格（来源见 docs/应用市场素材规格与可更新能力.md）。
// 用于：① 图标按渠道尺寸+大小上限处理；② 截图格式/大小处理；③ 文案长度校验（仅告警，不阻断）。
// 标 [官] 的为官方文档核实；其余为官方转述/第三方经验值，集成前建议控制台终核。

export interface ChannelSpec {
  /** 图标边长(px，正方形) */
  iconSize: number;
  /** 图标文件大小上限(字节)，超出则 shipup 自动压缩/降尺寸 */
  iconMaxBytes?: number;
  /** 截图首选格式 */
  screenshotFormat: 'jpg' | 'png';
  /** 单张截图大小上限(字节) */
  screenshotMaxBytes?: number;
  /** 截图最少/最多张数（仅告警提示） */
  screenshotMin?: number;
  screenshotMax?: number;
  /** 文案长度上限（字符数近似；三星实际按 UTF-8 字节，这里给等效汉字数）。仅告警 */
  appNameMax?: number;
  summaryMax?: number;
  descriptionMax?: number;
}

const KB = 1024;
const MB = 1024 * 1024;

export const CHANNEL_SPECS: Record<string, ChannelSpec> = {
  // 华为 [官]：图标 216² PNG≤2MB；截图 3-8 张 ≤2MB；一句话≤80 字符；长描述≤8000；更新说明≤500
  huawei: {
    iconSize: 216,
    iconMaxBytes: 2 * MB,
    screenshotFormat: 'png',
    screenshotMaxBytes: 2 * MB,
    screenshotMin: 3,
    screenshotMax: 8,
    summaryMax: 80,
    descriptionMax: 8000,
  },
  // 荣耀 [官]：图标 512² ≤200KB PNG/JPG；截图(纵)1080×1920 3-5 张 ≤5MB；一句话≤80；介绍≤8000；名称≤15 汉字
  honor: {
    iconSize: 512,
    iconMaxBytes: 200 * KB,
    screenshotFormat: 'png',
    screenshotMaxBytes: 5 * MB,
    screenshotMin: 3,
    screenshotMax: 5,
    appNameMax: 15,
    summaryMax: 80,
    descriptionMax: 8000,
  },
  // OPPO [三]：图标 512² <1MB；截图竖 1080×1920 3-5 张 ≤1MB；一句话≤13 禁标点空格；简介≥20
  oppo: {
    iconSize: 512,
    iconMaxBytes: 1 * MB,
    screenshotFormat: 'png',
    screenshotMaxBytes: 1 * MB,
    screenshotMin: 3,
    screenshotMax: 5,
    appNameMax: 15,
    summaryMax: 13,
  },
  // vivo [转]：图标 512²(或 256²) ≤50KB；截图 3-5 张 ≤2MB 须同方向；一句话 5-16 汉字；简介≥50
  vivo: {
    iconSize: 512,
    iconMaxBytes: 50 * KB,
    screenshotFormat: 'jpg',
    screenshotMaxBytes: 2 * MB,
    screenshotMin: 3,
    screenshotMax: 5,
    appNameMax: 15,
    summaryMax: 16,
  },
  // 小米 [官]：图标 512² <1MB；截图 ≥3 张 ≤5MB；一句话≤17 汉字 句末勿标点
  xiaomi: {
    iconSize: 512,
    iconMaxBytes: 1 * MB,
    screenshotFormat: 'png',
    screenshotMaxBytes: 5 * MB,
    screenshotMin: 3,
    summaryMax: 17,
  },
  // 三星 [官]：图标 512² ≤1MB；截图 ≥4(展示≤8)；一句话 40 字节≈13 汉字；长描述 4000 字节≈1300 汉字
  samsung: {
    iconSize: 512,
    iconMaxBytes: 1 * MB,
    screenshotFormat: 'png',
    screenshotMin: 4,
    screenshotMax: 8,
    appNameMax: 33,
    summaryMax: 13,
    descriptionMax: 1300,
  },
  // 应用宝 [官]：图标 512² ≤200KB 直角；截图 4-5 张 1080×1920 ≤1M；一句话≤15；简介 60-500
  qq: {
    iconSize: 512,
    iconMaxBytes: 200 * KB,
    screenshotFormat: 'png',
    screenshotMaxBytes: 1 * MB,
    screenshotMin: 4,
    screenshotMax: 5,
    summaryMax: 15,
    descriptionMax: 500,
  },
  // 魅族 [三]：图标 512² PNG ≤1MB；截图 JPG ≤5MB；名称≤10 中文；简介 100-1000
  meizu: {
    iconSize: 512,
    iconMaxBytes: 1 * MB,
    screenshotFormat: 'jpg',
    screenshotMaxBytes: 5 * MB,
    appNameMax: 10,
    descriptionMax: 1000,
  },
};

export function getChannelSpec(channel: string): ChannelSpec {
  return CHANNEL_SPECS[channel] ?? { iconSize: 512, screenshotFormat: 'png' };
}

/** 文案长度校验：超限仅打印告警到 stderr（不阻断，规格多为近似值，最终以渠道后台为准）。 */
export function warnIfTooLong(
  channel: string,
  field: string,
  value: string | undefined,
  max: number | undefined,
): void {
  if (!value || !max) return;
  // 汉字按 1 计（与各渠道「字符/汉字数」口径近似）
  const len = [...value].length;
  if (len > max) {
    console.error(
      `[warn] ${channel} ${field} 长度 ${len} 超过建议上限 ${max}，可能被审核打回（以渠道后台校验为准）`,
    );
  }
}
