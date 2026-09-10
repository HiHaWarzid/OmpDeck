import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "./withTimeout";

describe("withTimeout", () => {
	it("透传按时完成的结果", async () => {
		await expect(withTimeout(Promise.resolve("ok"), 1000, "timeout")).resolves.toBe("ok");
	});

	it("超时后 reject 并用调用方消息", async () => {
		vi.useFakeTimers();
		try {
			const { promise } = Promise.withResolvers<never>();
			const assertion = expect(withTimeout(promise, 60_000, "agent-create-timeout")).rejects.toThrow(
				"agent-create-timeout",
			);
			await vi.advanceTimersByTimeAsync(60_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("完成后清理定时器（不再触发 reject）", async () => {
		vi.useFakeTimers();
		try {
			const result = await withTimeout(Promise.resolve(1), 1000, "timeout");
			expect(result).toBe(1);
			// 定时器已清：快进也不应有未处理的 rejection
			await vi.advanceTimersByTimeAsync(5000);
		} finally {
			vi.useRealTimers();
		}
	});
});
