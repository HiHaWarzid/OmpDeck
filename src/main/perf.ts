/**
 * PIDECK_PERF=1 时的关键路径耗时诊断。
 *
 * 设计约束：
 * - 默认零开销：未开启时 perfStart/perfEnd 都是常数级空操作，不分配、不计数。
 * - 开启时按 key 聚合样本（count/sum/max + 最近 2000 条用于 P50/P95），
 *   每次调用打印一行 [perf] 便于实时观察，退出前由 perfDump 输出汇总。
 * - 不引入 profiling 基建：无文件输出、无 IPC 通道，纯 console 诊断。
 */
const ENABLED = process.env.PIDECK_PERF === "1";

interface PerfStats {
  count: number;
  sum: number;
  max: number;
  /** 环形缓冲最近 N 条耗时，用于退出时算 P50/P95 */
  recent: number[];
}

const stats = new Map<string, PerfStats>();
const RECENT_LIMIT = 2000;

export function perfStart(key: string): number {
  return ENABLED ? Date.now() : 0;
}

export function perfEnd(key: string, startedAt: number, extra?: Record<string, unknown>): void {
  if (!ENABLED) return;
  const ms = Date.now() - startedAt;
  let entry = stats.get(key);
  if (!entry) {
    entry = { count: 0, sum: 0, max: 0, recent: [] };
    stats.set(key, entry);
  }
  entry.count += 1;
  entry.sum += ms;
  if (ms > entry.max) entry.max = ms;
  if (entry.recent.length >= RECENT_LIMIT) entry.recent.shift();
  entry.recent.push(ms);
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[perf] ${key} ${ms}ms${suffix}`);
}

/** 输出聚合汇总（应用退出前调用）。 */
export function perfDump(): void {
  if (!ENABLED || stats.size === 0) return;
  console.log("[perf] ===== PIDECK_PERF summary =====");
  for (const [key, entry] of stats) {
    const sorted = [...entry.recent].sort((a, b) => a - b);
    const p50 = sorted.length > 0
      ? sorted[Math.min(sorted.length - 1, Math.floor(0.5 * sorted.length))]
      : 0;
    const p95 = sorted.length > 0
      ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]
      : 0;
    console.log(
      `[perf] ${key}: n=${entry.count} avg=${(entry.sum / entry.count).toFixed(1)}ms ` +
        `p50=${p50}ms p95=${p95}ms max=${entry.max}ms`,
    );
  }
  console.log("[perf] ===== end =====");
}
