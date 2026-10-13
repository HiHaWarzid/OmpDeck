import { describe, expect, it } from "vitest";
import { createTranscriptState, beginAssistantMessage, appendThinkingDelta } from "./agentTranscript";
import {
	abortFallbackDeadline,
	closeRun,
	createRunState,
	decideSettle,
	hasLocalWork,
	isRunSealed,
	noteRunAbortSettled,
	sealRun,
	SETTLE_POLL_TIMEOUT_MS,
} from "./agentRunState";
import { ABORT_SETTLED_FALLBACK_MS } from "./settleReducer";
import { openStreamGateForNewRun } from "./streamGate";

const idleSignals = {
	hasPendingUiRequest: false,
	compacting: false,
	hasActiveAssistant: false,
	toolExecuting: null,
};

describe("agent run state", () => {
	it("local work signals gate the settle decision without an RPC round-trip", () => {
		expect(hasLocalWork(idleSignals)).toBe(false);
		expect(hasLocalWork({ ...idleSignals, hasPendingUiRequest: true })).toBe(true);
		expect(hasLocalWork({ ...idleSignals, compacting: true })).toBe(true);
		expect(hasLocalWork({ ...idleSignals, hasActiveAssistant: true })).toBe(true);
		expect(hasLocalWork({ ...idleSignals, toolExecuting: "bash" })).toBe(true);
	});

	it("abort seals the generation and schedules a fallback deadline", () => {
		const run = createRunState();
		sealRun(run, 10_000);

		expect(isRunSealed(run)).toBe(true);
		expect(run.recentlyAborted).toBe(true);
		expect(abortFallbackDeadline(run)).toBe(10_000 + ABORT_SETTLED_FALLBACK_MS);
	});

	it("a sealed run stays waiting until abort settles, and only a fresh open unseals it", () => {
		const run = createRunState();
		sealRun(run, 1_000);

		// 封印期间不得判空闲：poll 越过闸门会把 abort 误报成完成
		const whileSealed = decideSettle({ run, local: idleSignals, now: 1_100, timeoutMs: SETTLE_POLL_TIMEOUT_MS });
		expect(whileSealed.decision).not.toBe("idle");

		noteRunAbortSettled(run);
		expect(abortFallbackDeadline(run)).toBeUndefined();
		// 没有新的 agent_start：闸门按设计保持封印，直到下一轮真正开始
		expect(isRunSealed(run)).toBe(true);

		run.streamGate = openStreamGateForNewRun(run.streamGate);
		expect(isRunSealed(run)).toBe(false);
		const after = decideSettle({ run, local: idleSignals, now: 1_200, timeoutMs: SETTLE_POLL_TIMEOUT_MS });
		expect(after.decision).toBe("idle");
	});

	it("remote busy fields keep the run alive; queued and pending message counts are both read", () => {
		const run = createRunState();
		expect(
			decideSettle({ run, local: idleSignals, remote: { isStreaming: true }, now: 5, timeoutMs: SETTLE_POLL_TIMEOUT_MS })
				.decision,
		).not.toBe("idle");
		expect(
			decideSettle({
				run,
				local: idleSignals,
				remote: { isCompacting: true },
				now: 5,
				timeoutMs: SETTLE_POLL_TIMEOUT_MS,
			}).decision,
		).not.toBe("idle");
		// omp 用 queuedMessageCount，旧 pi 用 pendingMessageCount：任一非零都算有排队
		expect(
			decideSettle({
				run,
				local: idleSignals,
				remote: { queuedMessageCount: 1 },
				now: 5,
				timeoutMs: SETTLE_POLL_TIMEOUT_MS,
			}).decision,
		).not.toBe("idle");
		expect(
			decideSettle({
				run,
				local: idleSignals,
				remote: { pendingMessageCount: 2 },
				now: 5,
				timeoutMs: SETTLE_POLL_TIMEOUT_MS,
			}).decision,
		).not.toBe("idle");
	});

	it("no work plus an elapsed poll window yields idle", () => {
		const run = createRunState();
		const decision = decideSettle({
			run,
			local: idleSignals,
			remote: { isStreaming: false, isCompacting: false, queuedMessageCount: 0 },
			now: 9_000,
			timeoutMs: SETTLE_POLL_TIMEOUT_MS,
		});
		expect(decision.decision).toBe("idle");
	});

	it("closeRun clears gate, abort markers and transcript run state in one step", () => {
		const run = createRunState();
		const transcript = createTranscriptState();
		sealRun(run, 1_000);
		beginAssistantMessage(transcript);
		appendThinkingDelta(transcript, "thinking", 2_000);

		closeRun(run, transcript);

		expect(isRunSealed(run)).toBe(false);
		expect(run.recentlyAborted).toBe(false);
		expect(run.abortSettledAt).toBeUndefined();
		expect(transcript.activeAssistantMessageId).toBeUndefined();
		expect(transcript.streamingThinking).toBe("");
		expect(transcript.thinkingStartedAt).toBeUndefined();
	});

	it("pi 自报 isSettled 压过陈旧的 isStreaming/isCompacting/排队快照", () => {
		// 陈旧标志形态：run 已结束但 get_state 仍报忙碌——若继续采信快照，UI 永久停在 running。
		const decision = decideSettle({
			run: createRunState(),
			local: idleSignals,
			remote: { isStreaming: true, isCompacting: true, pendingMessageCount: 3, isSettled: true },
			now: 9_000,
			timeoutMs: SETTLE_POLL_TIMEOUT_MS,
		});
		expect(decision.decision).toBe("idle");
		expect(decision.reason).toBe("pi-settled");
	});

	it("本地忙碌信号优先于 pi 的 isSettled（app 一手证据不被远端快照覆盖）", () => {
		// 例如扩展正在等用户回答、或本地仍在压缩：此时不能因为 pi 说 settled 就收口。
		const decision = decideSettle({
			run: createRunState(),
			local: { ...idleSignals, hasPendingUiRequest: true },
			remote: { isSettled: true },
			now: 9_000,
			timeoutMs: SETTLE_POLL_TIMEOUT_MS,
		});
		expect(decision.decision).toBe("stay-running");
	});

	it("无 isSettled 字段（老 pi）时沿用原忙碌判定", () => {
		const busy = decideSettle({
			run: createRunState(),
			local: idleSignals,
			remote: { isStreaming: true },
			now: 9_000,
			timeoutMs: SETTLE_POLL_TIMEOUT_MS,
		});
		const idle = decideSettle({
			run: createRunState(),
			local: idleSignals,
			remote: { isStreaming: false, isCompacting: false },
			now: 9_000,
			timeoutMs: SETTLE_POLL_TIMEOUT_MS,
		});
		expect(busy.decision).toBe("stay-running");
		expect(idle.decision).toBe("idle");
		expect(idle.reason).toBe("no-work");
	});
});
