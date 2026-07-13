// 轻量 HTTP 封装：原生 fetch + 超时（AbortSignal.timeout）+ 瞬时失败重试。
import { UploadError } from '../core/types.js';

/** 是否可重试：5xx / 429 限流 / 网络错误 / 超时（这些通常意味着请求未被服务端处理）。 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof UploadError) {
    const c = Number(e.code);
    return c >= 500 || c === 429;
  }
  if (e instanceof Error) {
    return (
      e.name === 'TimeoutError' ||
      e.name === 'TypeError' ||
      /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(e.message)
    );
  }
  return false;
}

/**
 * 对瞬时失败做有限次指数退避重试（带 jitter）；非可重试错误（4xx/签名/解析等）立即抛。
 * 仅用于幂等或「失败即未生效」的请求；提交审核类非幂等操作慎用（默认 postForm/putBytes 仅在
 * 5xx/429/网络/超时 时重试，这类失败一般未被服务端处理，重试安全）。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { retries?: number; baseMs?: number; label?: string },
): Promise<T> {
  const retries = opts?.retries ?? 2;
  const baseMs = opts?.baseMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !isRetryable(e)) throw e;
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 250);
      console.error(
        `[retry] ${opts?.label ?? 'http'} 第 ${attempt + 1}/${retries} 次失败，${delay}ms 后重试: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * POST application/x-www-form-urlencoded，返回解析后的 JSON。
 * 默认对瞬时失败重试；**非幂等的提交类调用应传 retries=0**（避免重复提交）。
 */
export async function postForm(
  url: string,
  params: Record<string, string>,
  timeoutMs: number,
  retries = 2,
): Promise<any> {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new UploadError(res.status, `http ${res.status}: ${text.slice(0, 500)}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new UploadError('parse', `非 JSON 响应: ${text.slice(0, 500)}`);
      }
    },
    { label: `POST ${hostOf(url)}`, retries },
  );
}

/** PUT 原始字节（如腾讯云 COS 预签名直传）。瞬时失败自动重试（重传整文件，幂等）。 */
export async function putBytes(
  url: string,
  bytes: Buffer | Uint8Array,
  timeoutMs: number,
  contentType = 'application/octet-stream',
): Promise<void> {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: bytes,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new UploadError(res.status, `put 失败 ${res.status}: ${text.slice(0, 300)}`);
      }
    },
    { label: `PUT ${hostOf(url)}` },
  );
}
