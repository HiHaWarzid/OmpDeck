import { describe, expect, it } from "vitest";
import { createRepoCommandQueue } from "./repoCommandQueue";

/** 手动放行的闸门：用于把任务精确停在"在途"窗口内。 */
function gate() {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, release: resolve };
}

describe("createRepoCommandQueue", () => {
	it("同一 cwd（含路径写法差异）严格串行，后到者等前序 settle 后才开始", async () => {
		const queue = createRepoCommandQueue();
		const first = gate();
		const events: string[] = [];
		const a = queue.run("/repo", async () => {
			events.push("a:start");
			await first.promise;
			events.push("a:end");
		});
		// "/repo/" 与 "/repo" 归一化到同一把锁：写法差异不能绕过串行。
		const b = queue.run("/repo/", async () => {
			events.push("b:start");
		});

		await Promise.resolve();
		expect(events).toEqual(["a:start"]);
		expect(queue.size()).toBe(1);

		first.release();
		await Promise.all([a, b]);
		expect(events).toEqual(["a:start", "a:end", "b:start"]);
		// 队列排空后清理键，避免按仓库路径无限累积
		expect(queue.size()).toBe(0);
	});

	it("不同 cwd 并行：两条任务同时在途", async () => {
		const queue = createRepoCommandQueue();
		const gateA = gate();
		const gateB = gate();
		const started: string[] = [];

		const a = queue.run("/repo-a", async () => {
			started.push("a");
			await gateA.promise;
		});
		const b = queue.run("/repo-b", async () => {
			started.push("b");
			await gateB.promise;
		});

		await Promise.resolve();
		expect(started).toEqual(["a", "b"]);
		expect(queue.size()).toBe(2);

		gateA.release();
		gateB.release();
		await Promise.all([a, b]);
		expect(queue.size()).toBe(0);
	});

	it("前序失败不阻塞后继，错误只抛给自己的调用方", async () => {
		const queue = createRepoCommandQueue();
		const order: string[] = [];
		const failed = queue.run("/repo", async () => {
			order.push("first");
			throw new Error("index.lock 争用");
		});
		const next = queue.run("/repo", async () => {
			order.push("second");
			return "ok";
		});

		await expect(failed).rejects.toThrow("index.lock 争用");
		await expect(next).resolves.toBe("ok");
		expect(order).toEqual(["first", "second"]);
		expect(queue.size()).toBe(0);
	});
});
