/**
 * 带尾随重跑的单飞执行器。
 *
 * 场景：某个 key 上的昂贵异步操作（如失同步时拉取全量 transcript）可能被高频事件
 * 反复触发。若不去重，每个事件都发起一次 IPC，n 个事件 → n 次请求；若简单丢弃
 * 重复触发，又可能丢掉「在途期间新出现的请求」，收敛不到最终状态。
 *
 * 语义：
 * - 首次 run(key, fn) 立即执行；
 * - 在途期间再次 run(key, fn) 只登记**最后一次**的 fn（多次触发合并为一次尾随执行）；
 * - 在途结束后若有登记，立即用最后登记的 fn 再执行一次。
 */
export function createSingleFlight(): (key: string, fn: () => Promise<void>) => void {
	const inFlight = new Set<string>();
	const pending = new Map<string, () => Promise<void>>();

	const run = (key: string, fn: () => Promise<void>): void => {
		if (inFlight.has(key)) {
			// 覆盖为最新意图：尾随执行应反映最后一次触发，而不是最早的调用。
			pending.set(key, fn);
			return;
		}
		inFlight.add(key);
		void fn()
			.catch(() => undefined)
			.finally(() => {
				inFlight.delete(key);
				const next = pending.get(key);
				if (!next) return;
				pending.delete(key);
				run(key, next);
			});
	};

	return run;
}
