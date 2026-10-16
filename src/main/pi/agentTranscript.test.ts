import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/types";
import {
	MAX_TRANSCRIPT_BYTES,
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

	it("replaceMessages forces a full baseline push without dropping in-flight tracking", () => {
		const s = createTranscriptState();
		beginAssistantMessage(s);
		const activeId = s.activeAssistantMessageId;
		expect(activeId).toBeDefined();

		const history = [{ id: "h1", agentId: AGENT, role: "user", text: "old", timestamp: 1 }] as ChatMessage[];
		replaceMessages(s, history);

		expect(s.messages).toBe(history);
		expect(takeDirtySlice(s).replaceFrom).toBe(0);
		// 加载期间正在流式的回答会在 merge 阶段被接回尾部，映射必须保留：
		// 清空会让随后的 text_delta 找不到目标，把同一轮回答变成两个气泡。
		expect(s.activeAssistantMessageId).toBe(activeId);
	});

	it("replaceMessages enforces the memory budget immediately (resume of a huge session)", () => {
		const s = createTranscriptState();
		// 单条消息约 1MB（text 按 UTF-16 计 2 字节/字符），20 条即 20MB，远超 8MB 预算。
		const history = Array.from({ length: 20 }, (_, index) => ({
			id: `h${index}`,
			agentId: AGENT,
			role: "user",
			text: "x".repeat(512 * 1024),
			timestamp: index,
		})) as ChatMessage[];

		replaceMessages(s, history);

		// 裁到 70% 水位以下，且最近的消息必须留着（正在看的就是尾部）。
		expect(s.messages.length).toBeLessThan(history.length);
		expect(s.messages.at(-1)?.id).toBe("h19");
		expect(s.pendingBudgetTrim).toMatchObject({ limitBytes: MAX_TRANSCRIPT_BYTES });
		expect(s.pendingBudgetTrim?.droppedMessages).toBeGreaterThan(0);
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

describe("agent transcript 容量预算", () => {
	/** 每条约 0.8MB 估算体积（400K 字符 × 2 字节）：32 条即 25MB，远超 8MB 预算。 */
	const BIG_TEXT = 400_000;

	it("超预算时只裁头部，保留最近窗口，并强制下一次推送走全量基线", () => {
		const s = createTranscriptState();
		const all: ChatMessage[] = [];
		// 追加 40 条越过 32 条的校验步长，必然触发裁剪
		for (let i = 0; i < 40; i += 1) {
			all.push(
				appendMessage(s, { agentId: AGENT, role: "assistant", text: `${i}` + "x".repeat(BIG_TEXT), now: i }),
			);
		}

		const kept = s.messages;
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(all.length);
		// 只裁头部：保留的必须是原数组的连续尾段，最新一条永远在
		expect(kept.map((message) => message.id)).toEqual(
			all.slice(all.length - kept.length).map((message) => message.id),
		);
		expect(kept.at(-1)).toBe(all.at(-1));
		// 裁剪后必须全量基线重推：否则渲染层还握着旧头部，两侧窗口错位
		expect(takeDirtySlice(s).replaceFrom).toBe(0);
		// 裁剪记录对应裁剪发生的那一刻（第 32 条追加后），不是最终长度
		const trim = s.pendingBudgetTrim;
		expect(trim?.limitBytes).toBe(MAX_TRANSCRIPT_BYTES);
		expect((trim?.droppedMessages ?? 0) + (trim?.keptMessages ?? 0)).toBe(32);
		expect(trim?.estimatedBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
	});

	it("预算内的会话不裁剪：数组保持同一引用，也不产生裁剪记录", () => {
		const s = createTranscriptState();
		for (let i = 0; i < 40; i += 1) {
			appendMessage(s, { agentId: AGENT, role: "assistant", text: `${i}` + "x".repeat(1_000), now: i });
		}

		// 超预算才会重建数组：预算内连追加都不该换引用（渲染层按引用做 diff）
		expect(s.messages).toHaveLength(40);
		expect(s.pendingBudgetTrim).toBeUndefined();
	});

	it("被裁掉的消息 id 会从工具/重试登记里清掉，避免迟到事件重复 push 一张卡", () => {
		const s = createTranscriptState();
		upsertToolMessage(s, {
			agentId: AGENT,
			event: { toolName: "bash", toolCallId: "t1", result: "ok" },
			status: "done",
			abortedDuringAsk: false,
			now: 0,
		});
		const toolMessage = s.messages[0];
		s.retryStatusMessageId = toolMessage.id;
		for (let i = 0; i < 32; i += 1) {
			appendMessage(s, { agentId: AGENT, role: "assistant", text: `${i}` + "x".repeat(BIG_TEXT), now: i + 1 });
		}

		expect(s.messages).not.toContain(toolMessage);
		expect(s.toolMessageIds.size).toBe(0);
		expect(s.retryStatusMessageId).toBeUndefined();
	});
});
