import { randomUUID } from "node:crypto";
import type { ChatMessage, ImageContent } from "../../shared/types";
import { extractResultDetails } from "../../shared/todo";
import { extractMessageText } from "./messageContent";
import { formatToolDetail } from "./messageTimeline";
import { buildAskCard, extractAskQuestionDetails } from "./askQuestionCard";
import {
	MAX_TOOL_RESULT_CHARS,
	extractThinking,
	extractToolResultText,
	safeJson,
	stripAnsi,
	truncateForDetail,
} from "./messageTextUtils";

/**
 * 单 agent 的会话转录（AgentTranscript）——消息时间线 + 流式思考 + 增量推送统计。
 *
 * 设计动机（deep module）：
 *   - 增量转录原先散在 AgentManager 的 12 个私有方法与 10 个 AgentRuntime 字段上，
 *     handlePiEvent 的每个分支都直接改写这些字段；abort / agent_end / agent_settled /
 *     markIdle 各自手写一遍「清空运行态」，改一处要同步四处。
 *   - 真正的复杂度在「增量」：delta 追加与终态全量校准的取舍、并行工具按 toolCallId
 *     配对、思考分段重启、脏区间记账、完整工具结果的 LRU。这些规则与 IPC、pi 进程
 *     无关，收拢成本模块后可用纯函数直接测试。
 *   - 状态仍以对象字段挂在 AgentRuntime 上（与 streamGate 同一模式），调用方读字段
 *     不变，只要写字段改走本模块的函数。
 *
 * 边界：本模块不碰 IPC、定时器与进程。节流调度（何时 flush）留在 AgentManager，
 * 本模块只回答「自上次取走以来哪些消息变了」（takeDirtySlice）。
 */

/** 工具完整结果文本的内存缓存上限：超出按插入序淘汰最旧一条。 */
const TOOL_FULL_TEXT_LRU_MAX = 200;

export type AgentTranscriptState = {
	/** 会话时间线：user / assistant / tool / system 混排，append-only（就地更新不改顺序）。 */
	messages: ChatMessage[];
	/** 当前正在流式更新的 assistant 消息 id；tool 事件插入时继续更新同一回答块。 */
	activeAssistantMessageId?: string;
	/** toolCallId → messageId，把同一次工具调用合并成一条 UI 记录。 */
	toolMessageIds: Map<string, string>;
	/** 每个 agent 只保留一条自动重试状态消息，避免短暂 5xx 刷屏。 */
	retryStatusMessageId?: string;
	/** 本轮流式思考的累积缓冲（thinking_delta 逐段拼接，thinking_end 后清空）。 */
	streamingThinking: string;
	thinkingStartedAt?: number;
	thinkingEndedAt?: number;
	/**
	 * 自上次 flush 以来最早被变更的消息下标，作为增量推送的 replaceFrom。
	 * flush 后重置为 messages.length；任何消息增/删/就地更新都向前收缩该值。
	 * 历史加载/重启重建时置 0，强制下一次 flush 全量推送基线。
	 */
	messageDirtyFrom: number;
	/** 超过 MAX_TOOL_RESULT_CHARS 的工具结果全文（LRU）：UI 只需截断版，全文按需取。 */
	fullTextByMessageId: Map<string, string>;
	/** 是否有已排期但尚未 flush 的消息推送（配合 messageFlushTimer 做 50ms 合并）。 */
	pendingMessage: boolean;
	/** 节流定时器由调用方创建/清理（回调要触发 IPC），仅在此登记以便统一取消。 */
	messageFlushTimer?: NodeJS.Timeout;
};

export function createTranscriptState(): AgentTranscriptState {
	return {
		messages: [],
		toolMessageIds: new Map(),
		streamingThinking: "",
		messageDirtyFrom: 0,
		fullTextByMessageId: new Map(),
		pendingMessage: false,
	};
}

/**
 * 清空运行态（abort / agent_start / agent_end / agent_settled / 置 idle 共用）。
 * 原实现把这 5 行在 5 处各写一遍，漏改一处就会出现「上一轮的思考块挂到下一轮」。
 */
export function resetTranscriptRun(state: AgentTranscriptState): void {
	state.streamingThinking = "";
	state.thinkingStartedAt = undefined;
	state.thinkingEndedAt = undefined;
	state.activeAssistantMessageId = undefined;
	state.toolMessageIds.clear();
}

/** 新一轮回答开始：只在没有活跃 assistant 消息时分配新 id。 */
export function beginAssistantMessage(state: AgentTranscriptState): void {
	if (state.activeAssistantMessageId === undefined) {
		state.activeAssistantMessageId = randomUUID();
	}
}

/**
 * 追加一段思考增量，返回拼接后的完整文本供节流发射器推送。
 *
 * 同一轮 agent 内可能有多段思考（思考→工具→再思考）。上一段已结束
 * （thinkingEndedAt 有值）时视为新一轮思考，刷新起点，否则时长会从第一段起点
 * 累计，把工具调用等无关时间算进本轮思考。
 */
export function appendThinkingDelta(state: AgentTranscriptState, delta: string, now: number): string {
	if (state.thinkingStartedAt === undefined || state.thinkingEndedAt !== undefined) {
		state.thinkingStartedAt = now;
	}
	state.thinkingEndedAt = undefined;
	// 只拼接一次、strip 一次；upsertAssistantMessage 的增量模式不会再全量提取
	// content，避免同一段思考文本被反复整段扫描。
	state.streamingThinking += delta;
	return state.streamingThinking;
}

/**
 * 思考结束：用终态内容校准缓冲，返回应推送的最终文本（空串表示无需推送）。
 * 调用方负责清空 buffer（见 clearThinkingBuffer）。
 */
export function endThinking(state: AgentTranscriptState, finalContent: unknown, now: number): string {
	const finalThinking = String(finalContent ?? state.streamingThinking ?? "");
	if (finalThinking) state.streamingThinking = finalThinking;
	state.thinkingEndedAt = now;
	return finalThinking;
}

/**
 * 思考缓冲消费完毕（内容已并入消息）：清空缓冲，避免工具调用后第二段思考的
 * thinking_delta 追加到本段完整文本之后造成内容重复。
 */
export function clearThinkingBuffer(state: AgentTranscriptState): void {
	state.streamingThinking = "";
}

/** 记录消息数组自上次 flush 以来的最早变更下标，增量推送据此计算 replaceFrom。 */
export function markDirtyFrom(state: AgentTranscriptState, fromIndex: number): void {
	if (fromIndex < state.messageDirtyFrom) state.messageDirtyFrom = fromIndex;
}

/** 记录某条消息被就地变更（按引用定位下标，避免各调用方自己维护 index）。 */
export function markMessageDirty(state: AgentTranscriptState, message: ChatMessage | undefined): void {
	if (!message) return;
	const index = state.messages.indexOf(message);
	if (index !== -1) markDirtyFrom(state, index);
}

/** 整组消息被重建（历史加载/重启替换），下一次 flush 必须全量推送基线。 */
export function markAllMessagesDirty(state: AgentTranscriptState): void {
	state.messageDirtyFrom = 0;
}

/** 取走本轮增量：replaceFrom 起为变更内容；replaceFrom === 0 表示全量基线。 */
export function takeDirtySlice(state: AgentTranscriptState): { replaceFrom: number; messages: ChatMessage[] } {
	const messages = state.messages;
	const replaceFrom = Math.min(state.messageDirtyFrom, messages.length);
	// 本轮变更已随 slice 发出，重置为数组尾部；下一次变更再向前收缩。
	state.messageDirtyFrom = messages.length;
	return { replaceFrom, messages: messages.slice(replaceFrom) };
}

/** 整表替换（历史加载 / 会话切换）：新基线 + 全量推送。 */
export function replaceMessages(state: AgentTranscriptState, messages: ChatMessage[]): void {
	state.messages = messages;
	state.activeAssistantMessageId = undefined;
	state.toolMessageIds.clear();
	markAllMessagesDirty(state);
}

/**
 * 追加一条消息（user / assistant / tool / system 的统一写入点）。
 * 返回落库对象：语义事件订阅者拿到的必须与 state.messages 中的对象同构。
 */
export function appendMessage(
	state: AgentTranscriptState,
	input: {
		agentId: string;
		role: ChatMessage["role"];
		text: string;
		meta?: Record<string, unknown>;
		images?: ImageContent[];
		now: number;
	},
): ChatMessage {
	const message: ChatMessage = {
		id: randomUUID(),
		agentId: input.agentId,
		role: input.role,
		text: input.text,
		timestamp: input.now,
		meta: input.meta,
		...(input.images && input.images.length > 0 ? { images: input.images } : {}),
	};
	state.messages.push(message);
	markDirtyFrom(state, state.messages.length - 1);
	return message;
}

/**
 * upsert 当前 assistant 消息。
 *
 * 增量模式（text_delta / thinking_delta 高频路径）跳过对 partialMessage.content 的
 * 全量提取：每条 delta 都携带完整累积 content，全量 extractMessageText +
 * extractThinking + stripAnsi 是 O(累积文本)，长回答整体退化为 O(N²)。
 * delta 追加语义由 pi 协议保证；message_end/text_end/thinking_end 等终态走全量
 * 提取，用完整 content 校准。
 *
 * @returns clearedThinking 为 true 表示思考缓冲已被内容消费，调用方需清空思考显示。
 */
export function upsertAssistantMessage(
	state: AgentTranscriptState,
	input: {
		agentId: string;
		partialMessage?: unknown;
		fallbackDelta?: string;
		incremental?: boolean;
		now: number;
	},
): { clearedThinking: boolean } {
	const fallbackDelta = input.fallbackDelta ?? "";
	const incremental = input.incremental === true;
	let messageId = state.activeAssistantMessageId;
	if (!messageId) {
		messageId = randomUUID();
		state.activeAssistantMessageId = messageId;
	}

	const partialSource = input.partialMessage;
	const partialContent =
		partialSource && typeof partialSource === "object" && "content" in partialSource
			? partialSource.content
			: undefined;
	const extractedText = !incremental && partialContent !== undefined ? extractMessageText(partialContent) : "";
	const extractedThinking = !incremental && partialContent !== undefined ? extractThinking(partialContent) : "";
	const nextThinking = stripAnsi(extractedThinking || state.streamingThinking || "");
	const { thinkingStartedAt, thinkingEndedAt } = state;

	// 单次线性扫描定位（findIndex），避免 find + indexOf 的双重扫描；
	// 流式消息总是数组尾部，findIndex 命中即退出。
	const list = state.messages;
	const existingIndex = list.findIndex((message) => message.id === messageId);
	if (existingIndex !== -1) {
		const existing = list[existingIndex];
		existing.text = extractedText || `${existing.text}${fallbackDelta}`;
		if (nextThinking) existing.thinking = nextThinking;
		existing.timestamp = input.now;
		if (thinkingStartedAt) {
			if (existing.thinkingStartedAt !== thinkingStartedAt) {
				// 新一轮思考开始（起点已刷新）：旧的 thinkingEndedAt 不再适用，
				// 必须清除，否则 UI 会误判思考已结束、停止实时计时。
				existing.thinkingEndedAt = undefined;
			}
			existing.thinkingStartedAt = thinkingStartedAt;
		}
		if (thinkingEndedAt) existing.thinkingEndedAt = thinkingEndedAt;
		markDirtyFrom(state, existingIndex);
	} else {
		const text = extractedText || fallbackDelta;
		if (!text) return { clearedThinking: false };
		list.push({
			id: messageId,
			agentId: input.agentId,
			role: "assistant",
			text,
			timestamp: input.now,
			...(nextThinking ? { thinking: nextThinking } : {}),
			...(thinkingStartedAt ? { thinkingStartedAt } : {}),
			...(thinkingEndedAt ? { thinkingEndedAt } : {}),
		});
		markDirtyFrom(state, list.length - 1);
	}

	return { clearedThinking: Boolean(nextThinking && (extractedText || fallbackDelta)) };
}

/**
 * upsert 一条工具消息（按 toolCallId 合并同一次调用的 start/end）。
 * 工具耗时只能由 start/end 两个事件推导：start 时保存 startedAt，end 时写入
 * durationMs，避免使用消息 timestamp（会在 update/end 时刷新）导致历史恢复后耗时不可还原。
 */
export function upsertToolMessage(
	state: AgentTranscriptState,
	input: {
		agentId: string;
		event: Record<string, any>;
		status: "running" | "done" | "error";
		abortedDuringAsk: boolean;
		now: number;
	},
): void {
	const { event, status, now } = input;
	const toolName = event.toolName || "tool";
	const toolCallId = String(event.toolCallId ?? `${toolName}-${now}`);
	const agentTools = state.toolMessageIds;

	let messageId = agentTools.get(toolCallId);
	if (!messageId) {
		messageId = randomUUID();
		agentTools.set(toolCallId, messageId);
	}

	const list = state.messages;
	const existingIndex = list.findIndex((message) => message.id === messageId);
	const existing = existingIndex !== -1 ? list[existingIndex] : undefined;
	const isError = status === "error" || event.isError === true;
	const args = event.args ?? existing?.meta?.args;
	const startedAt = typeof existing?.meta?.startedAt === "number" ? existing.meta.startedAt : now;
	const durationMs = status === "running" ? undefined : Math.max(0, now - startedAt);
	const result = event.result ?? event.partialResult ?? event.output ?? existing?.meta?.result;
	// 完整结果文本只算一次：detailText（截断版）、meta.result（截断版）、
	// truncated 判定与全文缓存（未截断）共用同一份，避免大工具结果在同一事件内
	// 被 extractToolResultText / safeJson 重复处理（历史实现计算了 2~3 次）。
	const fullResultText = extractToolResultText(result) || safeJson(result) || "";
	// tool_execution_start 事件（omp 协议）不带 result/partialResult/output，
	// result 为 undefined；safeJson 归一为 "" 后此处恒为字符串，下游 .length 安全。
	const detailText = formatToolDetail(toolName, args, result, isError, fullResultText);
	const icon = status === "running" ? "▶" : isError ? "✗" : "✓";
	const text = `${icon} ${toolName}`;
	// args 可能来自 event.args（对象）或 existing.meta.args（已序列化的 JSON 字符串）。
	// 如果是后者（如 tool_execution_end 不带 args），直接复用已有字符串避免 double encoding。
	const argsMeta = typeof args === "string" ? args : truncateForDetail(safeJson(args));
	// omp 等工具的结构化结果快照（todo 的 details.phases）以对象形式保存，
	// 供工具卡渲染与历史恢复解析；extractToolResultText 只保留文本会丢失该信息。
	const resultDetails = extractResultDetails(result);
	// 提取 ask_question 详情用于渲染提问卡片；支持批量（questions 数组）和单问题两种格式。
	const askDetails = extractAskQuestionDetails(toolName, result, args);
	const askCard = buildAskCard(askDetails, input.abortedDuringAsk);
	if (fullResultText.length > MAX_TOOL_RESULT_CHARS) {
		cacheFullText(state, messageId, fullResultText);
	}
	const meta = {
		status,
		toolName,
		toolCallId,
		startedAt,
		...(durationMs !== undefined ? { durationMs } : {}),
		args: argsMeta,
		result: truncateForDetail(fullResultText),
		...(fullResultText.length > MAX_TOOL_RESULT_CHARS
			? { truncated: true, fullLength: fullResultText.length }
			: {}),
		...(resultDetails !== undefined ? { details: resultDetails } : {}),
		isError,
		detailText,
		// originalContent 不再存储到消息中（full file 会使会话元数据体积过大）。
		// diff 使用工具参数（oldText/newText 等）展示变动区域，无需完整文件快照。
		...(askCard ? { _askCard: askCard } : {}),
	};

	if (existing) {
		existing.text = text;
		existing.timestamp = now;
		existing.meta = meta;
		markDirtyFrom(state, existingIndex);
	} else {
		list.push({
			id: messageId,
			agentId: input.agentId,
			role: "tool",
			text,
			timestamp: now,
			meta,
		});
		markDirtyFrom(state, list.length - 1);
	}
}

/** 缓存工具完整结果全文（LRU：超出上限按插入序淘汰最旧一条）。 */
export function cacheFullText(state: AgentTranscriptState, messageId: string, fullText: string): void {
	state.fullTextByMessageId.set(messageId, fullText);
	if (state.fullTextByMessageId.size > TOOL_FULL_TEXT_LRU_MAX) {
		const oldest = state.fullTextByMessageId.keys().next().value;
		if (oldest !== undefined) state.fullTextByMessageId.delete(oldest);
	}
}

/** 取工具结果全文（仅截断下发时缓存过）。 */
export function fullTextOf(state: AgentTranscriptState, messageId: string): string | undefined {
	return state.fullTextByMessageId.get(messageId);
}
