// 多渠道并发编排：p-limit 控并发，单渠道失败隔离，聚合结果。
import pLimit from 'p-limit';
import type { ChannelAdapter, ChannelResult, UploadContext } from './types.js';
import { toFailed } from '../adapters/util.js';

export interface UploadTask {
  adapter: ChannelAdapter;
  ctx: UploadContext;
}

export async function runUploads(
  tasks: UploadTask[],
  concurrency: number,
): Promise<ChannelResult[]> {
  const limit = pLimit(Math.max(1, concurrency));
  return Promise.all(
    tasks.map((t) =>
      limit(async () => {
        const start = Date.now();
        const ch = t.adapter.channel;
        // 进度走 stderr（不污染 stdout 的 JSON），便于调用方/人看出跑到哪个渠道。
        console.error(`[shipup] ${ch} 开始上传…`);
        try {
          const r = await t.adapter.upload(t.ctx);
          console.error(`[shipup] ${ch} 结束: ${r.status} (${Date.now() - start}ms)`);
          return r;
        } catch (e) {
          // adapter 内部一般已自捕获；此处兜底
          const r = toFailed(ch, e, start, 'upload', t.ctx);
          console.error(`[shipup] ${ch} 失败: [${r.errorCode}] ${r.message} (${Date.now() - start}ms)`);
          return r;
        }
      }),
    ),
  );
}
