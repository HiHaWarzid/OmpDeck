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

/**
 * 采样上限：一次长流式可跑几十分钟（60fps → 十万级采样），
 * 既有无谓的内存占用，也让 `Math.max(...frameTimes)` 触到 V8 的参数上限而抛 RangeError。
 * 帧率是「当下流畅度」指标，保留最近若干帧即可；超限后丢弃前一半（均摊 O(1)）。
 */
const MAX_SAMPLES = 20_000;

let rafId = 0;
let lastFrame = 0;
let frameTimes: number[] = [];
let active = false;

export function isPerfEnabled(): boolean {
	return ENABLED;
}

/**
 * 组件渲染普查（与帧率采样同源开关）：卡死现场只有「帧率掉了」这种结果指标，
 * 无法回答「是谁在每 50ms 重渲染、花了多少毫秒」，只能靠临时插桩复现。
 *
 * React dev 构建对每一次渲染（含 props 未变的 memo 未命中）都会写一条以
 * U+200B 开头的 performance.measure，因此这里只读性能条目、不改组件即可拿到
 * 「组件 → 渲染次数 / 累计耗时 / 单次最大耗时」。总耗时占比即渲染层主线程占用率，
 * 是判断热路径是否被压满、以及验证优化是否生效的直接证据（零侵入，不需改组件）。
 */
const CENSUS_WINDOW_MS = 5_000;
const CENSUS_TOP = 8;
const CENSUS_SLOW_MS = 16;

/**
 * 提交级统计：React 只对挂载了 `<Profiler>` 的子树写组件级 user-timing，
 * 且根组件自身可能不带条目（实测 App 不在条目里），因此子树的总渲染耗时
 * 只能靠 Profiler.onRender 的回调累计。commit 次数 = 整棵会话树的渲染频率
 * （流式期间每 50ms 一批 delta 就会推一次），treeMs 占比即渲染占用率。
 */
let commitCount = 0;
let commitMs = 0;

export function recordCommitRender(durationMs: number): void {
	commitCount += 1;
	commitMs += durationMs;
}

/** 汇总一次窗口：返回停止函数（幂等；调用后不再写日志）。 */
export function startRenderCensus(
	log: (message: string, detail: unknown) => void,
): () => void {
	type Stat = { count: number; total: number; max: number; slow: number };
	let stopped = false;
	let lastFlush = performance.now();
	const acc = new Map<string, Stat>();

	const flush = () => {
		const now = performance.now();
		const windowMs = now - lastFlush;
		lastFlush = now;
		// React 的组件条目名 = U+200B + 组件名；其他 measure（含我们自己的探针）不统计。
		for (const entry of performance.getEntriesByType("measure")) {
			if (entry.name.charCodeAt(0) !== 0x200b) continue;
			const name = entry.name.slice(1);
			const stat = acc.get(name) ?? { count: 0, total: 0, max: 0, slow: 0 };
			stat.count += 1;
			stat.total += entry.duration;
			if (entry.duration > stat.max) stat.max = entry.duration;
			if (entry.duration >= CENSUS_SLOW_MS) stat.slow += 1;
			acc.set(name, stat);
		}
		// 已汇总的条目全部丢弃，避免长会话把 performance 环形缓冲写满。
		performance.clearMeasures();
		if (acc.size === 0) return;
		const stats = [...acc.entries()];
		acc.clear();
		let renders = 0;
		let busyMs = 0;
		let slow = 0;
		for (const [, s] of stats) {
			renders += s.count;
			busyMs += s.total;
			slow += s.slow;
		}
		const round = (n: number) => Math.round(n * 10) / 10;
		const top = (list: typeof stats) =>
			list.slice(0, CENSUS_TOP).map(([name, s]) => ({
				name,
				count: s.count,
				totalMs: round(s.total),
				maxMs: round(s.max),
				slow: s.slow,
			}));
		log("render census", {
			windowMs: Math.round(windowMs),
			renders,
			commits: commitCount,
			treeMs: round(commitMs),
			treeBusyRatio: Math.round((commitMs / windowMs) * 100) / 100,
			busyRatio: Math.round((busyMs / windowMs) * 100) / 100,
			slowRenders: slow,
			byCost: top([...stats].sort((a, b) => b[1].total - a[1].total)),
			byCount: top([...stats].sort((a, b) => b[1].count - a[1].count)),
		});
		commitCount = 0;
		commitMs = 0;
	};

	const timer = setInterval(() => {
		if (stopped) return;
		flush();
	}, CENSUS_WINDOW_MS);

	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		flush();
	};
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
		if (frameTimes.length >= MAX_SAMPLES) frameTimes = frameTimes.slice(MAX_SAMPLES / 2);
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
	let dropped = 0;
	let max = 0;
	for (const t of frameTimes) {
		if (t > max) max = t;
		if (t > 50) dropped += 1;
	}
	const fps = Math.round(1000 / p95);
	console.log(
		`[perf] renderer frames: n=${frameTimes.length} p50=${p50.toFixed(1)}ms ` +
			`p95=${p95.toFixed(1)}ms (≈${fps}fps) max=${max.toFixed(1)}ms dropped>50ms=${dropped}`,
	);
}
