import { describe, expect, it } from "vitest";
import { createWindowRateLimiter } from "./rendererHangWatchdog";

describe("createWindowRateLimiter", () => {
	it("窗口内放行到上限后丢弃，窗口到期后重新计数", () => {
		let now = 1_000;
		const allow = createWindowRateLimiter(60_000, 3, () => now);
		expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
		// 窗口没到期（差 1ms）仍然丢弃，避免故障级联时刷爆日志
		now += 59_999;
		expect(allow()).toBe(false);
		// 到期即重新放行：不能因为一次故障就永久静默
		now += 1;
		expect(allow()).toBe(true);
	});
});
