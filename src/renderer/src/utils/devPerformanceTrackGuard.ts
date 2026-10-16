/**
 * 开发模式下给 "User Timing" 条目加上限。
 *
 * 背景：React 19.2 的开发构建在每次组件渲染时都会调用 performance.measure（带 detail 的结构化克隆，
 * 见 react-dom-client.development.js 里的 supportsUserTiming / logComponentRender），供 DevTools
 * Performance 面板的 "Scheduler ⚛" 轨道展示。这些条目只有 clearMeasures() 才会释放，而应用从不清理：
 * 实测活跃渲染时约 500 条/秒，长时间运行（日活场景）会持续占用内存并最终把渲染进程推到 OOM
 * （崩溃日志里的 DataCloneError: Failed to execute 'measure' ... out of memory 就是同一处抛出的）。
 * 生产构建没有这段代码，因此只在 dev 下做兜底回收，保留最近一段窗口供临时录制查看。
 */
const MAX_USER_TIMING_ENTRIES = 4000;
const SWEEP_INTERVAL_MS = 10_000;

export function installDevPerformanceTrackGuard(): void {
  if (!import.meta.env.DEV) return;
  if (typeof performance === "undefined" || !window) return;

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
