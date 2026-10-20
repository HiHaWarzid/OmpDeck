// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererHangWatchdog } from "./rendererHangWatchdog";

/**
 * 看门狗的帧心跳是唯一无法靠单测外验证的部分（真实卡死不可复现），
 * 这里用可控时钟 + 真实 rAF 驱动：确认「出帧停顿」被记录、「窗口不可见」不误报。
 */

interface LogEntry {
	level: string;
	message: string;
	detail?: Record<string, unknown>;
}

function stubClock(start: number) {
	let now = start;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	return {
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function nextFrame(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	window.requestAnimationFrame(() => resolve());
	return promise;
}

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(document, "visibilityState");
});

describe("installRendererHangWatchdog 帧心跳", () => {
	it("帧间隔超过阈值时记录阻塞时长与负载快照", async () => {
		const clock = stubClock(1_000);
		const entries: LogEntry[] = [];
		const dispose = installRendererHangWatchdog((level, message, detail) => {
			entries.push({ level, message, detail });
		});
		await nextFrame();

		clock.advance(5_000);
		await nextFrame();
		dispose();

		const stalled = entries.filter((entry) => entry.message === "Renderer frame stalled");
		expect(stalled).toHaveLength(1);
		expect(stalled[0].level).toBe("warn");
		expect(stalled[0].detail?.blockedMs).toBe(5_000);
		expect(stalled[0].detail?.visibility).toBe("visible");
		expect(stalled[0].detail?.nodes).toBeGreaterThan(0);
	});

	it("窗口不可见时不出帧是浏览器行为，不记为卡死", async () => {
		const clock = stubClock(1_000);
		const entries: LogEntry[] = [];
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "hidden",
		});
		const dispose = installRendererHangWatchdog((level, message, detail) => {
			entries.push({ level, message, detail });
		});
		await nextFrame();

		clock.advance(60_000);
		await nextFrame();
		dispose();

		// 安装日志属于正常输出，这里只关心没有卡死记录。
		expect(entries.filter((entry) => entry.message === "Renderer frame stalled")).toEqual([]);
	});

	it("从隐藏恢复可见时，隐藏期间的间隔不算卡死", async () => {
		const clock = stubClock(1_000);
		const entries: LogEntry[] = [];
		let visibility: DocumentVisibilityState = "visible";
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => visibility,
		});
		const dispose = installRendererHangWatchdog((level, message, detail) => {
			entries.push({ level, message, detail });
		});
		await nextFrame();

		// 窗口被切走/息屏：浏览器停帧，恢复后首帧的间隔等于整段隐藏时长。
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		clock.advance(120_000);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await nextFrame();

		// 恢复后紧接着的一次真实停顿仍然要报告，证明跳过标记只吞掉恢复后的首帧。
		clock.advance(4_000);
		await nextFrame();
		dispose();

		const stalled = entries.filter((entry) => entry.message === "Renderer frame stalled");
		expect(stalled).toHaveLength(1);
		expect(stalled[0].detail?.blockedMs).toBe(4_000);
	});
});
