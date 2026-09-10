import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/types";
import {
	appendMessage,
	appendThinkingDelta,
	beginAssistantMessage,
	clearThinkingBuffer,
	createTranscriptState,
	endThinking,
	fullTextOf,
	markAllMessagesDirty,
	markMessageDirty,
	replaceMessages,
	resetTranscriptRun,
	takeDirtySlice,
	upsertAssistantMessage,
	upsertToolMessage,
} from "./agentTranscript";

const AGENT = "a1";

describe("agent transcript", () => {
	it("appendMessage registers the new message and shrinks the dirty range to its index", () => {
		const s = createTranscriptState();
		appendMessage(s, { agentId: AGENT, role: "user", text: "hi", now: 1_000 });
		appendMessage(s, { agentId: AGENT, role: "assistant", text: "yo", now: 1_001 });

		expect(s.messages).toHaveLength(2);
		expect(takeDirtySlice(s).replaceFrom).toBe(0);
		// 取走后再无变更：下一次 slice 从尾部开始，推送 0 条
		expect(takeDirtySlice(s)).toMatchObject({ replaceFrom: 2, messages: [] });
	});

	it("in-place update marks only that message dirty (incremental push, not full baseline)", () => {
		const s = createTranscriptState();
		appendMessage(s, { agentId: AGENT, role: "user", text: "q", now: 1 });
		const target = appendMessage(s, { agentId: AGENT, role: "assistant", text: "a", now: 2 });
		takeDirtySlice(s);

		target.text = "a2";
		markMessageDirty(s, target);

		expect(takeDirtySlice(s)).toMatchObject({ replaceFrom: 1, messages: [target] });
	});

	it("replaceMessages forces a full baseline push and drops the active assistant id", () => {
		const s = createTranscriptState();
		beginAssistantMessage(s);
		expect(s.activeAssistantMessageId).toBeDefined();

		const history = [{ id: "h1", agentId: AGENT, role: "user", text: "old", timestamp: 1 }] as ChatMessage[];
		replaceMessages(s, history);

		expect(s.messages).toBe(history);
		expect(s.activeAssistantMessageId).toBeUndefined();
		expect(takeDirtySlice(s).replaceFrom).toBe(0);
	});

	it("streaming deltas accumulate; text_end recalibrates instead of doubling the text", () => {
		const s = createTranscriptState();
		// text_delta 增量模式：直接追加 delta，跳过 O(累积文本) 的全量提取
		upsertAssistantMessage(s, { agentId: AGENT, partialMessage: undefined, fallbackDelta: "Hel", incremental: true, now: 1 });
		upsertAssistantMessage(s, { agentId: AGENT, partialMessage: undefined, fallbackDelta: "lo", incremental: true, now: 2 });
		expect(s.messages[0].text).toBe("Hello");

		// 终态事件携带完整 content：用全量提取校准，不叠加
		upsertAssistantMessage(s, {
			agentId: AGENT,
			partialMessage: { content: [{ type: "text", text: "Hello" }] },
			now: 3,
		});
		expect(s.messages[0].text).toBe("Hello");
	});

	it("a second thinking segment refreshes the start time and clears the stale end", () => {
		const s = createTranscriptState();
		expect(appendThinkingDelta(s, "first", 100)).toBe("first");
		expect(s.thinkingStartedAt).toBe(100);

		endThinking(s, "first", 200);
		expect(s.thinkingEndedAt).toBe(200);

		// 工具调用后的第二段思考：起点必须刷新，否则时长把工具耗时算进思考
		appendThinkingDelta(s, "second", 500);
		expect(s.thinkingStartedAt).toBe(500);
		expect(s.thinkingEndedAt).toBeUndefined();
		expect(s.streamingThinking).toBe("firstsecond");
	});

	it("clearing the thinking buffer prevents the next segment from repeating the previous text", () => {
		const s = createTranscriptState();
		appendThinkingDelta(s, "seg1", 10);
		clearThinkingBuffer(s);
		expect(appendThinkingDelta(s, "seg2", 20)).toBe("seg2");
	});

	it("consumed thinking is reported so the caller can emit an empty thinking update", () => {
		const s = createTranscriptState();
		appendThinkingDelta(s, "thinking", 10);
		const { clearedThinking } = upsertAssistantMessage(s, {
			agentId: AGENT,
			partialMessage: { content: [{ type: "text", text: "answer" }], thinking: "thinking" },
			now: 20,
		});
		expect(clearedThinking).toBe(true);
		expect(s.messages[0].thinking).toBe("thinking");
	});

	it("tool events pair by toolCallId into one message, and duration comes from start/end only", () => {
		const s = createTranscriptState();
		upsertToolMessage(s, {
			agentId: AGENT,
			event: { toolName: "bash", toolCallId: "t1", args: { command: "ls" } },
			status: "running",
			abortedDuringAsk: false,
			now: 1_000,
		});
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0].meta?.startedAt).toBe(1_000);
		expect(s.messages[0].meta?.durationMs).toBeUndefined();

		upsertToolMessage(s, {
			agentId: AGENT,
			event: { toolName: "bash", toolCallId: "t1", result: "ok" },
			status: "done",
			abortedDuringAsk: false,
			now: 1_250,
		});
		// 同一次调用仍是一条消息，耗时由 start/end 推导
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0].meta?.durationMs).toBe(250);
		expect(s.messages[0].meta?.startedAt).toBe(1_000);
		expect(s.messages[0].meta?.isError).toBe(false);
	});

	it("error tool results are flagged, and large results keep the full text out of the message", () => {
		const s = createTranscriptState();
		const big = "x".repeat(20_000);
		upsertToolMessage(s, {
			agentId: AGENT,
			event: { toolName: "read", toolCallId: "t2", result: big, isError: true },
			status: "error",
			abortedDuringAsk: false,
			now: 5,
		});

		const meta = s.messages[0].meta as Record<string, unknown>;
		expect(meta.isError).toBe(true);
		expect(meta.truncated).toBe(true);
		expect((meta.result as string).length).toBeLessThan(big.length);

		// 缓存全文与 meta.fullLength 必须指向同一份文本（读取侧据此判断是否截断）
		const id = s.messages[0].id;
		expect(fullTextOf(s, id)).toHaveLength(meta.fullLength as number);
		expect(fullTextOf(s, id)).toContain("xxxx");
	});

	it("full-text cache evicts oldest entries beyond the LRU cap", () => {
		const s = createTranscriptState();
		for (let i = 0; i < 210; i += 1) {
			upsertToolMessage(s, {
				agentId: AGENT,
				event: { toolName: "read", toolCallId: `t${i}`, result: "y".repeat(20_000) },
				status: "done",
				abortedDuringAsk: false,
				now: i,
			});
		}
		// 上限 200：最早的 10 条已被逐出
		expect(s.fullTextByMessageId.size).toBe(200);
		expect(fullTextOf(s, s.messages[0].id)).toBeUndefined();
		expect(fullTextOf(s, s.messages[209].id)).toBeDefined();
	});

	it("resetTranscriptRun clears every per-run field, so the next run starts clean", () => {
		const s = createTranscriptState();
		beginAssistantMessage(s);
		appendThinkingDelta(s, "x", 1);
		upsertToolMessage(s, {
			agentId: AGENT,
			event: { toolName: "bash", toolCallId: "t1" },
			status: "running",
			abortedDuringAsk: false,
			now: 1,
		});
		markAllMessagesDirty(s);

		resetTranscriptRun(s);

		expect(s.activeAssistantMessageId).toBeUndefined();
		expect(s.toolMessageIds.size).toBe(0);
		expect(s.streamingThinking).toBe("");
		expect(s.thinkingStartedAt).toBeUndefined();
		expect(s.thinkingEndedAt).toBeUndefined();
		// 消息本身保留：运行态清空不等于清空转录
		expect(s.messages).toHaveLength(1);
	});
});
