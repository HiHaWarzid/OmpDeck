import { describe, expect, it, vi } from "vitest";
import {
	runProcessReplacement,
	shouldAutoReattach,
	type ReplacementEffects,
	type ReplacementTarget,
} from "./agentProcessReplacement";

/**
 * 进程替换编排的契约测试。
 *
 * 这里断言的是四条重连入口共享的那段**顺序与收口**，而不是某个调用方的实现细节：
 * starting 先行、替换先于恢复选择、成功清 lastError、失败落非 idle 且写 lastError，
 * 以及 finally 里必须广播终态（调用方的锁由调用方 try/finally 收尾，本模块不碰）。
 * 顺序错了会静默失效（把 set_model 发给即将退役的 child），所以用调用记录断言，
 * 而不是只看最终状态。
 */

type Harness = {
	target: ReplacementTarget;
	statusAtReplace: string[];
	statusAtRestore: string[];
	effects: ReplacementEffects<ReplacementTarget>;
	messages: Array<{ role: string; text: string }>;
	emitStateCalls: number;
	replace: ReturnType<typeof vi.fn>;
	replacePaths: string[];
	restore: ReturnType<typeof vi.fn>;
};

function createHarness(overrides: {
	replaceFails?: boolean;
	restoreFails?: boolean;
	statusOnFailure?: "error" | "closed";
} = {}): Harness {
	const statusAtReplace: string[] = [];
	const replacePaths: string[] = [];
	const statusAtRestore: string[] = [];
	const messages: Array<{ role: string; text: string }> = [];
	let status: ReplacementTarget["status"] = "idle";
	const target: ReplacementTarget = {
		agentId: "agent-1",
		sessionPath: "C:/tmp/session.jsonl",
		get status() {
			return status;
		},
		set status(next) {
			status = next;
		},
		lastError: "stale error from previous run",
	};

	const replace = vi.fn(async (_target: ReplacementTarget, sessionPath: string) => {
		replacePaths.push(sessionPath);
		statusAtReplace.push(target.status);
		if (overrides.replaceFails) throw new Error("child spawn failed");
	});
	const restore = vi.fn(async () => {
		statusAtRestore.push(target.status);
		if (overrides.restoreFails) throw new Error("set_model rejected");
	});

	const harness: Harness = {
		target,
		statusAtReplace,
		statusAtRestore,
		messages,
		emitStateCalls: 0,
		replace,
		replacePaths,
		restore,
		effects: {
			replaceProcess: replace,
			restoreSelection: restore,
			addMessage: (_target, role, text) => {
				messages.push({ role, text });
			},
			emitState: () => {
				harness.emitStateCalls += 1;
			},
			emitRuntimeState: () => {},
		},
	};
	return harness;
}

const copy = {
	success: "已重连",
	failure: (message: string) => `重连失败（${message}）`,
	logScope: "Test reattach",
};

describe("runProcessReplacement", () => {
	it("先置 starting，再替换，最后恢复选择", async () => {
		const calls: string[] = [];
		const harness = createHarness();
		harness.replace.mockImplementation(async (_target: ReplacementTarget, sessionPath: string) => {
			calls.push("replace");
			harness.replacePaths.push(sessionPath);
			harness.statusAtReplace.push(harness.target.status);
		});
		harness.restore.mockImplementation(async () => {
			calls.push("restore");
			harness.statusAtRestore.push(harness.target.status);
		});

		const outcome = await runProcessReplacement(
			harness.target,
			{ provider: "anthropic", modelId: "claude-sonnet-4" },
			harness.effects,
			copy,
		);

		expect(outcome).toEqual({ ok: true });
		// 替换期间必须是 starting：此刻新 prompt 不应投给即将退役的 child。
		expect(harness.statusAtReplace).toEqual(["starting"]);
		// 校验过的会话路径一路传到替换动作：调用方不必再判空，也就不会有第二份报错措辞。
		expect(harness.replacePaths).toEqual(["C:/tmp/session.jsonl"]);
		expect(harness.statusAtRestore).toEqual(["starting"]);
		// 顺序是硬约束：set_model 若先于替换，只会写进被丢弃的旧 child。
		expect(calls).toEqual(["replace", "restore"]);
		expect(harness.target.status).toBe("idle");
	});

	it("成功后清掉上一次的 lastError 并追加系统卡片", async () => {
		const harness = createHarness();
		await runProcessReplacement(harness.target, {}, harness.effects, copy);

		expect(harness.target.lastError).toBeUndefined();
		expect(harness.messages).toEqual([{ role: "system", text: "已重连" }]);
	});

	it("替换失败落 error 并写 lastError，错误卡片带干净信息", async () => {
		const harness = createHarness({ replaceFails: true });
		const outcome = await runProcessReplacement(harness.target, {}, harness.effects, copy);

		expect(outcome).toEqual({ ok: false, errorMessage: "child spawn failed" });
		expect(harness.target.status).toBe("error");
		expect(harness.target.lastError).toBe("child spawn failed");
		expect(harness.messages).toEqual([
			{ role: "error", text: "重连失败（child spawn failed）" },
		]);
		// 替换失败不应继续恢复选择：新 child 根本没起来。
		expect(harness.restore).not.toHaveBeenCalled();
	});

	it("statusOnFailure=closed 时把失败收敛成 closed（进程已退出的场景）", async () => {
		const harness = createHarness({ replaceFails: true });
		await runProcessReplacement(harness.target, {}, harness.effects, {
			...copy,
			statusOnFailure: "closed",
		});

		expect(harness.target.status).toBe("closed");
		expect(harness.target.lastError).toBe("child spawn failed");
	});

	it("恢复选择失败也算替换失败，不能留下 idle 的假象", async () => {
		const harness = createHarness({ restoreFails: true });
		const outcome = await runProcessReplacement(harness.target, {}, harness.effects, copy);

		expect(outcome.ok).toBe(false);
		expect(harness.target.status).toBe("error");
		expect(harness.target.lastError).toBe("set_model rejected");
	});

	it("无论成败都把终态广播出去，不把 starting 留在 UI 上", async () => {
		const failed = createHarness({ replaceFails: true });
		await runProcessReplacement(failed.target, {}, failed.effects, copy);
		// starting 一次 + finally 收口一次，失败也必须收口。
		expect(failed.emitStateCalls).toBe(2);

		const ok = createHarness();
		await runProcessReplacement(ok.target, {}, ok.effects, copy);
		expect(ok.emitStateCalls).toBe(2);
	});

	it("没有会话文件时拒绝替换，绝不把空路径交给 start（那会静默新建会话）", async () => {
		const harness = createHarness();
		const target: ReplacementTarget = {
			...harness.target,
			sessionPath: undefined,
			get status() {
				return harness.target.status;
			},
			set status(next) {
				harness.target.status = next;
			},
			get lastError() {
				return harness.target.lastError;
			},
			set lastError(next) {
				harness.target.lastError = next;
			},
		};
		const outcome = await runProcessReplacement(target, {}, harness.effects, copy);

		expect(outcome.ok).toBe(false);
		// 关键：坏掉的是前置条件，不是 spawn —— 根本不许碰替换动作。
		expect(harness.replace).not.toHaveBeenCalled();
		expect(target.status).toBe("error");
	});
});

describe("shouldAutoReattach", () => {
	it("只在干净退出、有会话文件且本生命周期未重连过时允许重连", () => {
		expect(
			shouldAutoReattach({ sessionPath: "s.jsonl", exitCode: 0, alreadyAttempted: false }),
		).toBe(true);
	});

	it("非 0 退出、无会话文件、或已重连过都拒绝", () => {
		expect(
			shouldAutoReattach({ sessionPath: "s.jsonl", exitCode: 1, alreadyAttempted: false }),
		).toBe(false);
		expect(
			shouldAutoReattach({ sessionPath: undefined, exitCode: 0, alreadyAttempted: false }),
		).toBe(false);
		expect(
			shouldAutoReattach({ sessionPath: "s.jsonl", exitCode: 0, alreadyAttempted: true }),
		).toBe(false);
	});
});
