/**
 * 开发模式下摘掉 React「组件性能轨道」的 props 明细。
 *
 * 背景（实测证据，React 19.2 开发构建）：
 * commit 阶段 React 会对每个重渲染的组件调用 logComponentRender，用
 * addObjectDiffToProperties(prevProps, nextProps) 把**变化过的 props 逐项 JSON.stringify**，
 * 塞进 performance.measure 的 detail。浏览器会对 detail 做结构化克隆，而且条目常驻
 * user-timing 缓冲（只有 clearMeasures 才释放），于是：
 *  - 时间线组件会拿到大 prop（消息正文 ~20KB、工具 result/details/detailText 数十 KB，
 *    运行结束时还有整份 transcript 重推），克隆量级与 prop 同阶，流式 20Hz 下持续累积；
 *  - 实测（探针页，单个 20KB 字符串 prop 重渲染 30 次）：detail 常驻 933KB，单条最大 40KB；
 *  - 堆耗尽时 performance.measure 直接抛
 *    "DataCloneError: Failed to execute 'measure' on 'Performance': Data cannot be cloned, out of memory."，
 *    栈顶是 logComponentRender。它抛在 commit 阶段，会打断 React 的提交流程并留下
 *    "flushSync was called from inside a lifecycle method"，此后渲染进程不再接受任何更新——
 *    用户看到的现象就是「任务已经跑完，但整个窗口卡死、点不动也没反应」，
 *    随后堆耗尽 → render-process-gone reason=oom。
 * 生产构建没有这段代码（react-dom-client.production.js 中不存在 logComponentRender /
 * addObjectDiffToProperties），因此只在 dev 下打这层补丁：保留 name/start/end，
 * DevTools Performance 面板的组件轨道时长照旧，只丢掉 detail 明细。
 */

/** user-timing 条目上限：detail 摘掉后条目本身很小，这里只做「长时间运行不无限增长」的兜底。 */
const MAX_USER_TIMING_ENTRIES = 4000;
const SWEEP_INTERVAL_MS = 10_000;

export function installDevPerformanceTrackGuard(): void {
  if (!import.meta.env.DEV) return;
  if (typeof performance === "undefined" || typeof window === "undefined") return;

  // measure 定义在 Performance 原型上，这里只遮蔽本实例，不影响其他 Performance 对象；
  // DOM 类型不允许给实例方法赋值，故此处用一次带说明的断言。
  const target = performance as unknown as { measure: Performance["measure"] };
  // 归一成单一签名，避免 measure 的四组重载与 options 形式互相干扰。
  const nativeMeasure = target.measure.bind(performance) as (
    name: string,
    startOrOptions?: string | number | PerformanceMeasureOptions,
    end?: string | number,
  ) => PerformanceMeasure;

  target.measure = ((name: string, startOrOptions?: string | number | PerformanceMeasureOptions, end?: string | number) => {
    if (startOrOptions !== null && typeof startOrOptions === "object") {
      // React 走 options 形式（{ start, end, detail }）：重建 options 丢掉 detail，
      // 目标只是不复刻 props 明细，时间区间语义保持不变。
      return nativeMeasure(name, {
        start: startOrOptions.start,
        duration: startOrOptions.duration,
        end: startOrOptions.end,
      });
    }
    return nativeMeasure(name, startOrOptions, end);
  }) as Performance["measure"];

  window.setInterval(() => {
    try {
      if (performance.getEntriesByType("measure").length > MAX_USER_TIMING_ENTRIES) {
        performance.clearMeasures();
      }
      if (performance.getEntriesByType("mark").length > MAX_USER_TIMING_ENTRIES) {
        performance.clearMarks();
      }
    } catch {
      // performance 计时 API 在极少数环境不可用；本守卫只是内存兜底，静默跳过即可。
    }
  }, SWEEP_INTERVAL_MS);
}
