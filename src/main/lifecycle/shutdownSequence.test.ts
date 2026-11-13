import { describe, expect, test, vi } from "vitest";
import { ShutdownSequence, type ShutdownPorts } from "./shutdownSequence";

function makePorts(overrides: Partial<ShutdownPorts> = {}) {
	const calls: string[] = [];
	const track = (name: string) => () => {
		calls.push(name);
	};
	const ports: ShutdownPorts = {
		flushSettings: track("flush-settings"),
		flushSummaryCache: track("flush-summary"),
		markCleanExit: track("mark-clean-exit"),
		stopRemoteAccess: track("stop-remote"),
		stopWebService: track("stop-web"),
		closeSessionScanner: track("close-scanner"),
		closeTerminals: track("close-terminals"),
		stopAgents: track("stop-agents"),
		stopPet: track("stop-pet"),
		stopQuickGen: track("stop-quick-gen"),
		dumpPerf: track("dump-perf"),
		warn: vi.fn(),
		...overrides,
	};
	return { ports, calls };
}

describe("ShutdownSequence", () => {
	test("before-quit 同步路径：stop 在本函数返回前已按顺序执行", () => {
		const { ports, calls } = makePorts();
		new ShutdownSequence(ports).run({ awaitFlush: false });

		// flush 推到 microtask，但 stop 必须已完成（进程随时可能被收走）。
		expect(calls).toEqual([
			"mark-clean-exit",
			"stop-remote",
			"stop-web",
			"close-scanner",
			"close-terminals",
			"stop-agents",
			"stop-pet",
			"stop-quick-gen",
			"dump-perf",
		]);
	});

	test("restart 路径：等两路刷盘完成才 stop", async () => {
		let finishSummary!: () => void;
		const { ports, calls } = makePorts({
			flushSummaryCache: () => new Promise<void>((resolve) => (finishSummary = resolve)),
		});
		const sequence = new ShutdownSequence(ports);
		const pending = sequence.run({ awaitFlush: true }) as Promise<void>;

		await Promise.resolve();
		expect(calls).toContain("flush-settings");
		expect(calls).not.toContain("mark-clean-exit");

		finishSummary();
		await pending;
		expect(calls).toContain("mark-clean-exit");
	});

	test("重复调用（restart 后 before-quit）不再执行第二遍停机", async () => {
		const { ports, calls } = makePorts();
		const sequence = new ShutdownSequence(ports);
		await sequence.run({ awaitFlush: true });
		const afterFirst = calls.length;

		await sequence.run({ awaitFlush: false });
		expect(calls.length).toBe(afterFirst);
		expect(sequence.started).toBe(true);
	});

	test("刷盘失败只告警，不阻塞停机", async () => {
		const error = new Error("disk full");
		const { ports, calls } = makePorts({
			flushSettings: () => Promise.reject(error),
		});
		const sequence = new ShutdownSequence(ports);
		await sequence.run({ awaitFlush: true });
		expect(ports.warn).toHaveBeenCalledWith("Failed to flush settings on shutdown", error);
		expect(calls).toContain("stop-agents");
	});
});
