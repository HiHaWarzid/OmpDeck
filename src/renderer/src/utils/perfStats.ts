/**
 * 渲染层帧间隔诊断（PIDECK_PERF=1 时开启，经 preload 暴露开关）。
 *
 * 流式期间用 requestAnimationFrame 采样帧间隔，停止采样时输出 P50/P95 与
 * 卡顿帧（>50ms，约低于 20fps）统计，用于验证「前端更流畅」的验收指标。
 * 默认零开销：未开启时所有函数为空操作，不启动 rAF 循环。
 */
const ENABLED =
	typeof window !== "undefined" &&
	window.piDesktop?.perf?.enabled === true;

let rafId = 0;
let lastFrame = 0;
let frameTimes: number[] = [];
let active = false;

export function isPerfEnabled(): boolean {
	return ENABLED;
}

/** 开始采样：流式开始时调用（幂等，重复调用无副作用）。 */
export function startFrameSampling(): void {
	if (!ENABLED || active) return;
	active = true;
	frameTimes = [];
	lastFrame = performance.now();
	const tick = (now: number) => {
		if (!active) return;
		frameTimes.push(now - lastFrame);
		lastFrame = now;
		rafId = requestAnimationFrame(tick);
	};
	rafId = requestAnimationFrame(tick);
}

/** 停止采样并输出统计：流式结束时调用。 */
export function stopFrameSampling(): void {
	if (!ENABLED || !active) return;
	active = false;
	cancelAnimationFrame(rafId);
	if (frameTimes.length === 0) return;
	const sorted = [...frameTimes].sort((a, b) => a - b);
	const p50 = sorted[Math.min(sorted.length - 1, Math.floor(0.5 * sorted.length))];
	const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
	const dropped = frameTimes.filter((t) => t > 50).length;
	const fps = Math.round(1000 / p95);
	console.log(
		`[perf] renderer frames: n=${frameTimes.length} p50=${p50.toFixed(1)}ms ` +
			`p95=${p95.toFixed(1)}ms (≈${fps}fps) max=${Math.max(...frameTimes).toFixed(1)}ms dropped>50ms=${dropped}`,
	);
}
