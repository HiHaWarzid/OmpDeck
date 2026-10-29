import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { SessionScanner } from "./SessionScanner";
import type { SessionSummary } from "../../shared/types";

vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
}));
vi.mock("chokidar", () => ({ watch: () => ({ on: () => undefined, close: async () => undefined }) }));

function summary(id: string, updatedAt: number): SessionSummary {
	return {
		id,
		filePath: `C:/sessions/${id}.jsonl`,
		title: id,
		updatedAt,
		createdAt: updatedAt,
		projectPath: "D:/projects/demo",
		messageCount: 1,
		preview: "",
	} as unknown as SessionSummary;
}

/**
 * watchdog 超时不应升级成「加载会话失败」：已经解析出的摘要继续返回，
 * 只把超时记进诊断日志。否则用户看到的是整个侧栏报错、一条会话都没有。
 */
test("扫描超时但有部分结果时返回部分列表并记录诊断", async () => {
	const timeouts: Array<{ stage: string; partialCount: number; error: string }> = [];
	const settled = vi.fn();
	const scanner = new SessionScanner({
		partialWaitMs: 5,
		onScanSettled: settled,
		logScanDegraded: (detail) => timeouts.push(detail),
	});
	const internals = scanner as unknown as {
		scanTimeoutMs: number;
		resolveScanRoots: () => Promise<string[]>;
		scanOnce: (
			roots: string[],
			signal: AbortSignal,
			onResult?: (summary: SessionSummary | null) => void,
		) => Promise<SessionSummary[]>;
	};
	internals.scanTimeoutMs = 20;
	internals.resolveScanRoots = async () => ["C:/sessions"];
	let runs = 0;
	internals.scanOnce = async (_roots, _signal, onResult) => {
		runs += 1;
		const parsed = summary("parsed", 2);
		onResult?.(parsed);
		await new Promise((resolve) => setTimeout(resolve, 120));
		return [parsed, summary("later", 1)];
	};

	const first = await scanner.list();
	assert.deepEqual(first.map((item) => item.id), ["parsed"]);

	// 首屏部分结果先返回（不阻塞 UI），watchdog 超时随后才落日志；
	// 超时降级也不能通知刷新：否则 18s 超时 → 通知 → 立刻再扫 → 再超时会自激成死循环。
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(settled.mock.calls.length, 0);
	assert.equal(timeouts.length, 1);
	assert.equal(timeouts[0].stage, "scan");
	assert.equal(timeouts[0].partialCount, 1);
	assert.match(timeouts[0].error, /timed out/);

	// 被放弃的扫描结束后必须清掉共享 job，下一次 list 才能重新扫（拿到完整结果）。
	// 放宽等待窗口，让第二轮按「完整扫描」路径返回。
	internals.scanTimeoutMs = 2_000;
	(scanner as unknown as { options: { partialWaitMs?: number } }).options.partialWaitMs = 2_000;
	const second = await scanner.list();
	assert.equal(runs, 2);
	assert.deepEqual(second.map((item) => item.id).sort(), ["later", "parsed"]);
});

/**
 * 项目过滤同样有 18s watchdog（父目录会话要整读文件做内容校验）。
 * 超时时若 reject，侧栏会整体报错；此时同步判定已经足够确定归属，
 * 因此降级为「只保留路径/cwd 命中的会话」，至少不会把项目下的会话全吞掉。
 */
test("项目过滤超时降级为同步路径判定", async () => {
	const degraded: Array<{ stage: string; partialCount: number }> = [];
	const scanner = new SessionScanner({
		partialWaitMs: 5_000,
		logScanDegraded: (detail) => degraded.push(detail),
	});
	const internals = scanner as unknown as {
		scanTimeoutMs: number;
		resolveScanRoots: () => Promise<string[]>;
		scanOnce: () => Promise<SessionSummary[]>;
		isSameProject: (summary: SessionSummary, projectPath: string, signal?: AbortSignal) => Promise<boolean>;
	};
	internals.scanTimeoutMs = 30;
	internals.resolveScanRoots = async () => ["C:/sessions"];
	const matching = summary("matching", 2);
	const other = { ...summary("other", 1), projectPath: "D:/projects/other" };
	internals.scanOnce = async () => [matching, other];
	// 模拟内容校验卡住：只有 abort 才会结束，让过滤阶段稳定超时。
	internals.isSameProject = async (_summary, _projectPath, signal) => new Promise<boolean>((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason));
	});

	const result = await scanner.list("D:/projects/demo");

	assert.deepEqual(result.map((item) => item.id), ["matching"]);
	assert.equal(degraded.length, 1);
	assert.equal(degraded[0].stage, "filter");
	assert.equal(degraded[0].partialCount, 2);
});
