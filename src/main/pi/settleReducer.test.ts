import { describe, expect, it } from "vitest";
import {
	ABORT_SETTLED_FALLBACK_MS,
	AGENT_SETTLED_TIMEOUT_MS,
	normalizePiBoolean,
	resolveSettle,
} from "./settleReducer";

/**
 * settleReducer 纯函数测试（从 AgentManager 四条 settle 路径提炼）：
 * - 严格布尔归一化（isStreaming === true）只在 reducer 里做一次，字符串/undefined/其它 truthy
 *   一律归一为 false——omp 可能以 "false" 字符串返回，宽松判定会让空闲检查永远无法通过；
 * - 事件路径最优先：agent_settled 到达即无条件 idle，不受 gate / polling 干扰；
 * - abort 封印中：deadline 未到必须 wait（poll 不得越过 gate 抢先置 idle 发 settled）；
 * - 双重超时博弈：settle 窗口（AGENT_SETTLED_TIMEOUT_MS）与 abort 兜底（ABORT_SETTLED_FALLBACK_MS）
 *   是独立纯输入，abort 兜底先到期先解封。
 */

describe("strict boolean normalization（仅此处归一化一次）", () => {
	it("实际布尔 true → normalizedIsStreaming = true，poll 保持 running", () => {
		const result = resolveSettle({
			isStreaming: true,
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("stay-running");
		expect(result.reason).toBe("poll");
		expect(result.normalizedIsStreaming).toBe(true);
	});

	it("实际布尔 false → normalized false，无其它忙碌信号则 no-work idle", () => {
		const result = resolveSettle({
			isStreaming: false,
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("no-work");
		expect(result.normalizedIsStreaming).toBe(false);
	});

	it("undefined → normalized false（缺省视为无流式）", () => {
		const result = resolveSettle({
			isStreaming: undefined,
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("no-work");
		expect(result.normalizedIsStreaming).toBe(false);
	});

	it('字符串 "true"（truthy 但不是 true）→ 严格归一化后 false，不再卡死运行中', () => {
		// omp 的 get_state 布尔字段可能是字符串；宽松 truthy 判定会把 "false" 当真值，
		// 空闲检查永远无法通过。`=== true` 严格判定下字符串一律归 false。
		const result = resolveSettle({
			isStreaming: "true",
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.normalizedIsStreaming).toBe(false);
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("no-work");
	});

	it('字符串 "false" → 同上归一为 false', () => {
		const result = resolveSettle({
			isStreaming: "false",
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.normalizedIsStreaming).toBe(false);
		expect(result.decision).toBe("idle");
	});

	it("其它 truthy 非布尔（数字 1）→ 归一为 false", () => {
		const result = resolveSettle({
			isStreaming: 1,
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.normalizedIsStreaming).toBe(false);
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("no-work");
	});
});

describe("normalizePiBoolean（导出给 getRuntimeState 的同一严格归一化）", () => {
	it("仅实际布尔 true 归 true", () => {
		expect(normalizePiBoolean(true)).toBe(true);
	});

	it("布尔 false / 字符串 / undefined / 其它 truthy 一律归 false", () => {
		expect(normalizePiBoolean(false)).toBe(false);
		expect(normalizePiBoolean("true")).toBe(false);
		expect(normalizePiBoolean("false")).toBe(false);
		expect(normalizePiBoolean(undefined)).toBe(false);
		expect(normalizePiBoolean(1)).toBe(false);
	});
});

describe("poll 路径（omp 兜底：无 agent_settled 事件）", () => {
	it("hasPendingGetState=true（本地忙碌信号/排队消息）→ stay-running", () => {
		const result = resolveSettle({
			isStreaming: false,
			hasPendingGetState: true,
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("stay-running");
		expect(result.reason).toBe("poll");
		expect(result.normalizedIsStreaming).toBe(false);
	});

	it("settle-check 轮询未安排（timeoutMs 缺省）→ 无权给出 no-work 结论，stay-running", () => {
		const result = resolveSettle({ isStreaming: false, now: 0 });
		expect(result.decision).toBe("stay-running");
		expect(result.reason).toBe("poll");
	});

	it("无忙碌信号且轮询已安排 → no-work idle（markIdleIfPiReportsNoWork 收口点）", () => {
		const result = resolveSettle({
			isStreaming: false,
			hasPendingGetState: false,
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("no-work");
		expect(result.normalizedIsStreaming).toBe(false);
	});
});

describe("agent_settled 事件路径（旧 pi 最终稳定点）", () => {
	it("settledAt 已到 → 无条件 idle/event，即使 gate 仍封印或 RPC 显示 busy", () => {
		const result = resolveSettle({
			isStreaming: true,
			gateWaitingAbort: true,
			now: 10_000,
			abortFallbackDeadline: 10_000 + ABORT_SETTLED_FALLBACK_MS,
			settledAt: 9_999,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("event");
		expect(result.normalizedIsStreaming).toBe(true);
	});

	it("事件路径不依赖 timeoutMs（轮询未安排也能收口）", () => {
		const result = resolveSettle({ isStreaming: false, settledAt: 5, now: 5 });
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("event");
	});
});

describe("abort 封印与兜底（ABORT_SETTLED_FALLBACK_MS）", () => {
	it("gate 封印中 + deadline 未到 → wait（即使 poll 显示无工作也不得抢跑）", () => {
		// 语义修正点：原 markIdleIfPiReportsNoWork 不查 gate，abort 后可能抢先置 idle 并发 settled；
		// reducer 统一为 wait，等 abort 对应的 settled 或兜底超时。
		const result = resolveSettle({
			isStreaming: false,
			hasPendingGetState: false,
			gateWaitingAbort: true,
			now: 1_000,
			abortFallbackDeadline: 1_000 + ABORT_SETTLED_FALLBACK_MS,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("wait");
		expect(result.reason).toBe("abort-fallback");
		expect(result.normalizedIsStreaming).toBe(false);
	});

	it("gate 封印中即使远端仍在流式/本地忙碌也 wait——gate 判定先于 poll 忙碌信号", () => {
		// markIdleIfPiReportsNoWork 换用 reducer 后（原实现不查 gate）：settle-check 定时器
		// 在 abort 封印窗口内触发时，即使 get_state 显示 busy 也必须 wait，不得自行收口。
		const result = resolveSettle({
			isStreaming: true,
			hasPendingGetState: true,
			gateWaitingAbort: true,
			now: 1_000,
			abortFallbackDeadline: 1_000 + ABORT_SETTLED_FALLBACK_MS,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("wait");
		expect(result.reason).toBe("abort-fallback");
	});

	it("gate 封印中 + deadline 已过 → idle/abort-fallback（noteAbortSettled 解封）", () => {
		const deadline = 1_000 + ABORT_SETTLED_FALLBACK_MS;
		const result = resolveSettle({
			isStreaming: true, // 兜底无视 RPC busy 信号：超时即按 settled 处理，避免"立刻重发"卡死
			gateWaitingAbort: true,
			now: deadline + 1,
			abortFallbackDeadline: deadline,
		});
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("abort-fallback");
		expect(result.normalizedIsStreaming).toBe(true);
	});

	it("gate 封印中 + 未给 deadline（无兜底定时器）→ 一直 wait", () => {
		const result = resolveSettle({
			isStreaming: false,
			gateWaitingAbort: true,
			now: 99_999,
		});
		expect(result.decision).toBe("wait");
		expect(result.reason).toBe("abort-fallback");
	});

	it("gate 未封印 → 兜底参数不参与，回落到 poll 路径", () => {
		const result = resolveSettle({
			isStreaming: false,
			gateWaitingAbort: false,
			now: 0,
			timeoutMs: AGENT_SETTLED_TIMEOUT_MS,
		});
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("no-work");
	});
});

describe("双重超时博弈（AGENT_SETTLED_TIMEOUT_MS vs 任务预算）", () => {
	// 两个纯输入：settle 窗口（假设 UI 场景 5000ms 上限）与 abort 兜底截止。
	// 它们相互独立：settle 窗口决定 poll 何时该跑，abort 兜底决定 gate 何时解封；
	// 封印期间 poll 不得越过 gate 抢先下结论。
	const SETTLE_WINDOW_MS = 5000;
	const abortAt = 1_000_000;
	const abortDeadline = abortAt + ABORT_SETTLED_FALLBACK_MS;

	it("abort 兜底先于 settle 窗口到期 → 解封，即使 settle 窗口尚未走满", () => {
		// abort 在 t=1_000_000；settle 窗口 5000ms 要到 t=1_005_000 才满；
		// 兜底（1500ms）在 t=1_001_500 已过 → idle/abort-fallback。
		const result = resolveSettle({
			isStreaming: false,
			gateWaitingAbort: true,
			now: abortAt + 2_000,
			abortFallbackDeadline: abortDeadline,
			timeoutMs: SETTLE_WINDOW_MS,
		});
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("abort-fallback");
	});

	it("settle 窗口已满但 abort 兜底未到 → 仍 wait（poll 不越权）", () => {
		const result = resolveSettle({
			isStreaming: false,
			hasPendingGetState: false,
			gateWaitingAbort: true,
			now: abortAt + 5_000, // settle 窗口已走满
			abortFallbackDeadline: abortDeadline + 60_000, // 兜底远未到
			timeoutMs: SETTLE_WINDOW_MS,
		});
		expect(result.decision).toBe("wait");
		expect(result.reason).toBe("abort-fallback");
	});

	it("无封印：settle 窗口走满且无忙碌 → no-work idle；未走满由调用方定时器保证不调用", () => {
		const result = resolveSettle({
			isStreaming: false,
			gateWaitingAbort: false,
			now: abortAt + 5_000,
			timeoutMs: SETTLE_WINDOW_MS,
		});
		expect(result.decision).toBe("idle");
		expect(result.reason).toBe("no-work");
	});
});