// 图标处理：把外部提供的图标文件缩放为各市场要求的尺寸（纯 JS，jimp，无原生依赖）。
// 注意：不再从 APK 自动提取图标（app-info-parser 对 adaptive icon/多密度不可靠，会取错图）。
// 图标一律由调用方通过 --icon 显式提供；调用方用 aapt 提取正确图标后传入。
import { readFile } from 'node:fs/promises';
import { Jimp } from 'jimp';

/** 解析 base64 data-uri 图标为字节。取不到返回 undefined。 */
export function decodeIconDataUri(dataUri?: string): Buffer | undefined {
  if (!dataUri) return undefined;
  const comma = dataUri.indexOf(',');
  const b64 = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  if (!b64) return undefined;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return undefined;
  }
}

/** 把图标字节缩放为 width×height（默认正方形）的 PNG 字节。 */
export async function resizeToPng(input: Buffer, width: number, height = width): Promise<Buffer> {
  const img = await Jimp.read(input);
  img.resize({ w: width, h: height });
  return img.getBuffer('image/png');
}

/**
 * 把图标字节缩放为 size×size 的 PNG（图标正方形）。传 maxBytes 时若超限则逐步降尺寸压缩
 * （vivo ≤50KB、应用宝/荣耀 ≤200KB 等较严的渠道用）。供 --icon 文件与 APK 提取的图标共用。
 */
export async function resizeBufferToPng(
  input: Buffer,
  size: number,
  maxBytes?: number,
): Promise<Buffer> {
  const encode = async (d: number): Promise<Buffer> => {
    const img = await Jimp.read(input);
    img.resize({ w: d, h: d });
    return img.getBuffer('image/png');
  };
  let buf = await encode(size);
  if (maxBytes && buf.length > maxBytes) {
    // 图标多为扁平设计，缩小边长后 PNG 体积明显下降；降到 96px 仍超则用最小结果并告警。
    let scale = 0.85;
    while (buf.length > maxBytes && Math.round(size * scale) >= 96) {
      buf = await encode(Math.round(size * scale));
      scale -= 0.15;
    }
    if (buf.length > maxBytes) {
      console.error(
        `[warn] 图标压缩后仍 ${buf.length} 字节，超过上限 ${maxBytes}；建议提供更简单/更小的图标`,
      );
    }
  }
  return buf;
}

/**
 * 读取本地图标文件并缩放为 width×width 的 PNG（图标正方形，height 仅兼容旧签名）。
 * 各市场尺寸：华为 216；荣耀及其余 512。压缩见 resizeBufferToPng。
 */
export async function resizeIconFileToPng(
  path: string,
  width: number,
  _height = width,
  maxBytes?: number,
): Promise<Buffer> {
  const input = await readFile(path);
  return resizeBufferToPng(input, width, maxBytes);
}

/**
 * 读取本地截图文件并按渠道首选格式编码（jpg/png）。
 * 不强制改尺寸（截图比例/内容需保留）；仅在超过 maxBytes 时对 jpg 逐步降质量压缩。
 */
export async function prepareScreenshot(
  path: string,
  format: 'jpg' | 'png',
  maxBytes?: number,
): Promise<Buffer> {
  const img = await Jimp.read(path);
  if (format === 'jpg') {
    let quality = 92;
    let buf = await img.getBuffer('image/jpeg', { quality });
    while (maxBytes && buf.length > maxBytes && quality > 40) {
      quality -= 15;
      buf = await img.getBuffer('image/jpeg', { quality });
    }
    if (maxBytes && buf.length > maxBytes) {
      console.error(`[warn] 截图 ${path} 压缩后仍超过上限 ${maxBytes} 字节`);
    }
    return buf;
  }
  const buf = await img.getBuffer('image/png');
  if (maxBytes && buf.length > maxBytes) {
    console.error(`[warn] 截图 ${path} 为 ${buf.length} 字节，超过 PNG 上限 ${maxBytes}；建议改用 jpg 或压缩`);
  }
  return buf;
}
