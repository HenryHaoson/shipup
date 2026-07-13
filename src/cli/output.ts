// 结果聚合 + json/text 输出 + 退出码判定。
import type { ChannelResult, NormalizedStatus } from '../core/types.js';
import { ExitCode, type ExitCodeValue } from '../core/exit.js';

export interface RunOutput {
  tool: 'shipup';
  platform: 'android' | 'ios';
  command: string;
  ok: boolean;
  summary: { total: number; succeeded: number; failed: number; skipped: number };
  results: ChannelResult[];
}

// 只有「操作失败」才算 failed；rejected/offline 是查询到的**业务状态**，操作本身成功
// （status 命令查到应用被驳回/下架不应判为「失败」，否则调用方会误判查询出错）。
const OP_FAILED: ReadonlySet<NormalizedStatus> = new Set<NormalizedStatus>([
  'failed',
  'not_implemented',
]);

function classify(results: ChannelResult[]) {
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'skipped') skipped++;
    else if (OP_FAILED.has(r.status)) failed++;
    else succeeded++; // 操作成功（含 uploaded/submitted/.../rejected/offline 等业务态）
  }
  return { succeeded, skipped, failed };
}

export function buildOutput(
  platform: 'android' | 'ios',
  command: string,
  results: ChannelResult[],
): RunOutput {
  const c = classify(results);
  return {
    tool: 'shipup',
    platform,
    command,
    ok: c.failed === 0,
    summary: { total: results.length, succeeded: c.succeeded, failed: c.failed, skipped: c.skipped },
    results,
  };
}

export function exitCodeFor(out: RunOutput): ExitCodeValue {
  if (out.summary.total === 0) return ExitCode.USAGE;
  if (out.summary.failed === 0) return ExitCode.OK;
  if (out.summary.succeeded === 0 && out.summary.skipped === 0) {
    // 全部失败：若失败全是超时则用 124，便于调用方据退出码识别超时。
    const opFailed = out.results.filter((r) => r.status === 'failed' || r.status === 'not_implemented');
    if (opFailed.length > 0 && opFailed.every((r) => r.errorCode === 'timeout')) return ExitCode.TIMEOUT;
    return ExitCode.ALL_FAILED;
  }
  return ExitCode.PARTIAL;
}

export function printOutput(out: RunOutput, format: string): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const { summary } = out;
  process.stdout.write(`shipup ${out.platform} ${out.command} — ${out.ok ? 'OK' : 'FAILED'}\n`);
  process.stdout.write(
    `  total=${summary.total} ok=${summary.succeeded} failed=${summary.failed} skipped=${summary.skipped}\n`,
  );
  for (const r of out.results) {
    const ver = r.versionName ? ` ${r.versionName}` : '';
    const extra =
      r.status === 'failed' || r.status === 'not_implemented'
        ? `  [${r.errorCode ?? '-'}] ${r.message ?? ''}`
        : r.marketVersion
          ? `  (线上 ${r.marketVersion})`
          : '';
    process.stdout.write(`  - ${r.channel}${ver}: ${r.status}${extra}\n`);
  }
}
