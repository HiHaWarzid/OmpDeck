import type { AppLogLevel } from "../../../shared/types";

/**
 * 渲染进程卡死看门狗：只观测、不干预，把「卡住多久 + 卡住时的负载快照」写进应用日志。
 *
 * 为什么必须常驻：10-16 的卡死复盘靠临时 [PERF] 探针（每 1s 打 App 渲染次数、长任务、
 * rAF 帧间隔、DOM 节点数）才定位到「提交阶段被结构化克隆打断」；探针撤掉后再复发，
 * 日志里就只剩「窗口卡住、没有报错、重启才好」这类无法归因的描述。卡死属于事后不可还原
 * 的故障，唯一能靠的就是事发时自动落盘的证据，因此这里常驻两个廉价信号：
 *
 * - longtask：≥1s 的同步任务（React 提交流程、布局、解析、结构化克隆都算在里面）；
 * - rAF 心跳：相邻帧间隔 ≥3s，说明主线程连帧都出不来，点击事件同样排在它后面
 *   （用户感知就是「什么按钮也点不动」）。窗口不可见时浏览器本就会停帧，故只在 visible 下判定。
 *
 * 另外订阅 event 计时：≥1s 的输入事件（click/keydown 处理器）单独记一条，用于区分
 * 「主线程整体饱和」与「某个交互处理器自己卡死」。
 *
 * 开销：一次 rAF 回调 + 观察者回调；未命中阈值时不产生任何日志。写日志走
 * app.rendererLog（渲染层无法自己写文件），并做窗口内条数上限，避免长任务级联时刷爆日志。
 */

/** 同步任务超过该时长即记录：低于 1s 的卡顿用户通常无感，记了只会淹没真实故障。 */
const LONG_TASK_MS = 1_000;
/** 相邻帧间隔超过该时长即记录：正常帧 16.7ms，3s 已是「界面完全冻结」的级别。 */
const FRAME_STALL_MS = 3_000;
/** 输入事件处理器超过该时长即记录。 */
const SLOW_EVENT_MS = 1_000;
/**
 * 主线程「持续饱和」采样窗口与判定阈值。
 * 单条长任务日志抓不到最常见的故障形态：不是某一个巨型任务，而是每个 50ms 都排着一批
 * 100ms 级任务、队列永远追不上流式推送（历史故障实测 1161 条长任务 / 16.6s ≈ 70/s）。
 * 那种情况下帧还在出（所以帧间隔不报警），但界面已经点不动：用「窗口内长任务总时长 / 窗口时长」
 * 表示主线程占用率，超过阈值即判定饱和。用占用率而不是 fps，是因为窗口被遮挡/最小化时
 * 浏览器会自行停帧，用 fps 会误报，而遮挡时主线程本来就不忙。
 */
const SATURATION_WINDOW_MS = 10_000;
const SATURATION_BUSY_RATIO = 0.8;
/** 饱和判定还需足够多的任务数（启动等一次性重活也会拉高占用率，但任务稀疏）。 */
const SATURATION_MIN_TASKS = 20;
/** 日志节流窗口与条数上限：故障级联时（每个 50ms 一个长任务）不至于把日志文件写爆。 */
const LOG_WINDOW_MS = 60_000;
const LOG_MAX_PER_WINDOW = 20;

export interface RendererHangLoggerSink {
  (level: AppLogLevel, message: string, detail?: Record<string, unknown>): void;
}

/**
 * 固定窗口节流：窗口内最多放行 maxPerWindow 条，窗口过期后重新计数。
 * 抽成纯函数便于单测（节流失效会写爆日志，过严又会丢掉故障首条，两者都是用户可见问题）。
 */
export function createWindowRateLimiter(
  windowMs: number,
  maxPerWindow: number,
  now: () => number = () => Date.now(),
): () => boolean {
  let windowStart = Number.NEGATIVE_INFINITY;
  let used = 0;
  return () => {
    const current = now();
    if (current - windowStart >= windowMs) {
      windowStart = current;
      used = 0;
    }
    if (used >= maxPerWindow) return false;
    used += 1;
    return true;
  };
}

/** 渲染层可读的堆信息（Chromium 专有；打包环境默认开启 precise memory info 之外也能读到近似值）。 */
interface HeapSnapshot {
  heapMB?: number;
  heapLimitMB?: number;
}

function readHeap(): HeapSnapshot {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (!memory) return {};
  return {
    heapMB: Math.round(memory.usedJSHeapSize / (1024 * 1024)),
    heapLimitMB: Math.round(memory.jsHeapSizeLimit / (1024 * 1024)),
  };
}

/**
 * 卡死现场的负载快照：DOM 节点数是「渲染规模失控」最直接的指标（历史故障出现过 4 万+ 节点），
 * 堆占用用于区分「内存压力导致 GC 抖动」与「纯纯的长任务」。
 */
function snapshot(): Record<string, unknown> {
  let nodes = -1;
  try {
    // 只在命中阈值时统计：一次 O(节点数) 遍历，平摊到故障时刻可以接受。
    nodes = document.getElementsByTagName("*").length;
  } catch {
    // document 不可用（极端早期/测试环境），保留 -1 表示未取到。
  }
  return {
    nodes,
    ...readHeap(),
    visibility: document.visibilityState,
  };
}

export function installRendererHangWatchdog(sink: RendererHangLoggerSink): () => void {
  if (typeof window === "undefined") return () => undefined;
  const allowLog = createWindowRateLimiter(LOG_WINDOW_MS, LOG_MAX_PER_WINDOW);
  const log = (level: AppLogLevel, message: string, detail: Record<string, unknown>) => {
    if (!allowLog()) return;
    sink(level, message, detail);
  };

  const supported = typeof PerformanceObserver === "undefined" ? [] : PerformanceObserver.supportedEntryTypes ?? [];
  const observesLongTask = supported.includes("longtask");
  const observesEvent = supported.includes("event");
  // 安装即记一条：故障复盘时先要能确认「看门狗当时在不在、能力是否被内核裁掉」。
  sink("info", "Renderer hang watchdog installed", {
    observesLongTask,
    observesEvent,
    frameHeartbeat: true,
    ...readHeap(),
  });

  const disposers: Array<() => void> = [];

  // 1) 长任务（同时累计主线程占用率，用于饱和判定）
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      let sampleStart = performance.now();
      let busyMs = 0;
      let taskCount = 0;
      let maxTaskMs = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          busyMs += entry.duration;
          taskCount += 1;
          maxTaskMs = Math.max(maxTaskMs, entry.duration);
          if (entry.duration < LONG_TASK_MS) continue;
          // attribution 是 Chromium 的 longtask 扩展字段，TS 的 PerformanceEntry 未声明。
          const attribution = (
            entry as PerformanceEntry & {
              attribution?: Array<{ containerType?: string; containerName?: string }>;
            }
          ).attribution?.[0];
          log("warn", "Renderer long task", {
            durationMs: Math.round(entry.duration),
            containerType: attribution?.containerType,
            containerName: attribution?.containerName,
            ...snapshot(),
          });
        }
        // 采样窗口到期才评估一次：饱和是「持续」现象，逐条判定会把正常的一次性重活也算进去。
        const elapsed = performance.now() - sampleStart;
        if (elapsed < SATURATION_WINDOW_MS) return;
        if (taskCount >= SATURATION_MIN_TASKS && busyMs / elapsed >= SATURATION_BUSY_RATIO) {
          log("warn", "Renderer saturated", {
            windowMs: Math.round(elapsed),
            busyMs: Math.round(busyMs),
            busyRatio: Number((busyMs / elapsed).toFixed(2)),
            taskCount,
            maxTaskMs: Math.round(maxTaskMs),
            ...snapshot(),
          });
        }
        sampleStart = performance.now();
        busyMs = 0;
        taskCount = 0;
        maxTaskMs = 0;
      });
      // buffered: 覆盖看门狗安装之前已经发生、但仍在缓冲里的长任务（启动慢时有用）。
      observer.observe({ type: "longtask", buffered: true });
      disposers.push(() => observer.disconnect());
    }
  } catch {
    // 不支持 longtask（老内核/测试环境）时降级为只有 rAF 心跳。
  }

  // 2) 输入事件处理器
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("event")) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < SLOW_EVENT_MS) continue;
          log("warn", "Renderer slow input handler", {
            eventType: entry.name,
            durationMs: Math.round(entry.duration),
            ...snapshot(),
          });
        }
      });
      // durationThreshold 下限是 16ms；只关心秒级，过滤放在回调里。
      // Chromium 扩展字段，TS 的 PerformanceObserverInit 未声明。
      observer.observe({ type: "event", durationThreshold: 100, buffered: false } as PerformanceObserverInit & {
        durationThreshold?: number;
      });
      disposers.push(() => observer.disconnect());
    }
  } catch {
    // 同上：event 计时不可用时跳过。
  }

  // 3) rAF 心跳：观察「帧间隔」，也就是主线程连续阻塞的时长。
  let disposed = false;
  let lastFrameAt = performance.now();
  /**
   * 隐藏 → 可见的跳变会制造一个等于「整段隐藏时长」的帧间隔：窗口被切走、锁屏、
   * 息屏时浏览器停帧，恢复后第一帧算出的 now - lastFrameAt 就是隐藏时长，而这一刻
   * visibilityState 已经回到 visible。只按「出帧时刻是否可见」判定会把这整段误报成
   * 主线程卡死（10-20 日志里 5s~253s 的 frame stalled 全是这种假阳性：同时间段
   * longtask 一条没有、RPC 一直在流、窗口回来立刻恢复响应）。
   * 因此可见性恢复时重置计时起点，并吞掉恢复后的首个间隔；真正的阻塞开始于可见期间，
   * 不受影响。
   */
  let resumedFromHidden = false;
  const handleVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    resumedFromHidden = true;
    lastFrameAt = performance.now();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  disposers.push(() => document.removeEventListener("visibilitychange", handleVisibilityChange));

  const tick = () => {
    if (disposed) return;
    const now = performance.now();
    const gap = now - lastFrameAt;
    lastFrameAt = now;
    const afterHidden = resumedFromHidden;
    resumedFromHidden = false;
    // 隐藏/最小化窗口时浏览器本来就不出帧，此时的大间隔不代表卡死。
    if (gap >= FRAME_STALL_MS && document.visibilityState === "visible" && !afterHidden) {
      log("warn", "Renderer frame stalled", {
        blockedMs: Math.round(gap),
        ...snapshot(),
      });
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  disposers.push(() => {
    disposed = true;
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}
