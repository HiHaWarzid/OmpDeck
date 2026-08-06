import type { ChatMessage, ImageContent } from "../../shared/types";
import { extractMessageText } from "./messageContent";
import { takeActiveEntryId } from "./sessionEntryIds";

/**
 * 会话消息时间线 -- 把 pi 原始条目（rawMessages）转换为 UI 可渲染的 ChatMessage[]。
 *
 * 从 AgentManager 提取的纯函数模块，零实例依赖。
 * 所有方法接收原始数据 + 参数，返回 ChatMessage[]/string/Map。
 * buildAskCard 的 aborted 状态由调用方传入，不再读 AgentManager 实例字段。
 *
 * 依赖方向：messageTimeline 不依赖 AgentManager，不依赖 SessionJsonl。
 * 被 AgentManager（live 路径 + 历史加载）和未来的 SessionJsonl 模块共同消费。
 */

/** 工具结果文本截断阈值（字符数），从 AgentManager.MAX_TOOL_RESULT_CHARS 提取为模块常量。 */
const MAX_TOOL_RESULT_CHARS = 8000;

/** 从 unknown 值中安全提取 number timestamp，回退到 Date.now()。 */
function toTimestamp(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

// ── 历史消息转换 ─────────────────────────────────────────

/**
 * 把 pi 原始消息数组转换为 ChatMessage[]，按 active branch 过滤。
 * aborted 参数控制 ask_question 卡片是否显示为已取消（live 路径传 this.abortedDuringAsk.has(agentId)，历史路径传 false）。
 */
export function convertAgentMessages(
	agentId: string,
	rawMessages: unknown[],
	activeEntryIds: string[] | undefined,
	aborted: boolean,
): ChatMessage[] {
	const historicalToolCalls = collectHistoricalToolCalls(rawMessages);
	const historicalOriginalContentByPath = collectHistoricalOriginalContentByPath(
		rawMessages,
		historicalToolCalls,
	);
	let metaSeq = 0;
	let entryIndex = 0;
	return rawMessages
		.flatMap<ChatMessage>((message, index) => {
			if (!message || typeof message !== "object") return [];
			const typed = message as Record<string, unknown>;

			if (typed.role === "user") {
				const taken = takeActiveEntryId(activeEntryIds, entryIndex);
				entryIndex = taken.nextIndex;
				const currentEntryId = taken.entryId;
				const images = extractImages(typed.content);
				const text = extractMessageText(typed.content) ||
					(images.length > 0 ? "[图片]" : "");
				if (!text.trim()) return [];
				return [{
					id: `${agentId}-history-${currentEntryId ?? index}`,
					agentId,
					role: "user" as const,
					text,
					timestamp: toTimestamp(typed.timestamp),
					meta: {
						...(currentEntryId ? { entryId: currentEntryId } : {}),
						_piDeckMsgSeq: index,
					},
					...(images.length > 0 ? { images } : {}),
				}];
			}
			if (typed.role === "assistant") {
				const taken = takeActiveEntryId(activeEntryIds, entryIndex);
				entryIndex = taken.nextIndex;
				const currentEntryId = taken.entryId;
				const text = extractMessageText(typed.content);
				const thinking = extractThinking(typed.content);
				if (!text.trim() && !thinking?.trim()) return [];
				return [{
					id: `${agentId}-history-${currentEntryId ?? index}`,
					agentId,
					role: "assistant" as const,
					text,
					timestamp: toTimestamp(typed.timestamp),
					meta: {
						...(currentEntryId ? { entryId: currentEntryId } : {}),
						_piDeckMsgSeq: index,
					},
					...(thinking ? { thinking } : {}),
				}];
			}
			if (typed.role === "toolResult") {
				const taken = takeActiveEntryId(activeEntryIds, entryIndex);
				entryIndex = taken.nextIndex;
				const currentEntryId = taken.entryId;
				const toolCallId = String(typed.toolCallId ?? `history-tool-${index}`);
				const historicalCall = historicalToolCalls.get(toolCallId);
				const toolName = String(typed.toolName ?? historicalCall?.name ?? "tool");
				const isError = Boolean(typed.isError);
				const startedAt =
					typeof typed.startedAt === "number" ? typed.startedAt : historicalCall?.timestamp;
				const durationMs =
					typeof typed.durationMs === "number"
						? typed.durationMs
						: typeof startedAt === "number" && typeof typed.timestamp === "number"
							? Math.max(0, (typed.timestamp as number) - startedAt)
							: undefined;
				const result = {
					content: typed.content,
					details: typed.details,
				};
				const filePath = getToolPathFromArgs(historicalCall?.args);
				const piDeckOriginalContent = (typed.details as Record<string, unknown> | undefined)?._piDeckOriginalContent as
					| string
					| undefined;
				const originalContent =
					piDeckOriginalContent ??
					(filePath
						? historicalOriginalContentByPath.get(filePath)
						: undefined);
				void originalContent; // 历史会话不保存 originalContent，但保留提取逻辑供未来 diff
				const detailText = formatToolDetail(
					toolName,
					historicalCall?.args,
					result,
					isError,
				);
				const askCard = buildAskCard(
					extractAskQuestionDetails(toolName, typed, historicalCall?.args),
					aborted,
				);
				return [{
					id: `${agentId}-history-${currentEntryId ?? index}`,
					agentId,
					role: "tool" as const,
					text: `${isError ? "✗" : "✓"} ${toolName}`,
					timestamp: toTimestamp(typed.timestamp),
					meta: {
						...(currentEntryId ? { entryId: currentEntryId } : {}),
						_piDeckMsgSeq: index,
						status: isError ? "error" : "done",
						toolName,
						toolCallId,
						...(startedAt !== undefined ? { startedAt } : {}),
						...(durationMs !== undefined ? { durationMs } : {}),
						args: truncateForDetail(safeJson(historicalCall?.args)),
						result: truncateForDetail(extractToolResultText(result) || safeJson(result)),
						isError,
						detailText,
						...(askCard ? { _askCard: askCard } : {}),
					},
				}];
			}
			if (typed.role === "compactionSummary" || typed.role === "branchSummary") {
				const isCompaction = typed.role === "compactionSummary";
				metaSeq++;
				const typedMeta = typed.meta as Record<string, unknown> | undefined;
				return [{
					id: `${agentId}-meta-${metaSeq}`,
					agentId,
					role: "system" as const,
					text: (typed.summary as string) ?? (isCompaction ? "Session compacted" : "Branch summarized"),
					timestamp: typeof typed.timestamp === "number"
						? typed.timestamp
						: Date.now(),
					meta: {
						type: isCompaction ? "compaction" : "branchSummary",
						tokensBefore: typed.tokensBefore,
						...(isCompaction && typedMeta?.compactionCount != null
							? { compactionCount: typedMeta.compactionCount }
							: {}),
						...(typedMeta?.archivedMessages != null
							? { archivedMessages: typedMeta.archivedMessages }
							: {}),
					},
				}];
			}
			return [];
		})
		.filter((message: ChatMessage) => message.text.trim());
}

// ── 历史截断 ─────────────────────────────────────────────

/**
 * 按对话轮次截断：保留最后 maxTurns 个用户提问及其后的全部消息。
 * 无 user 消息时回退到最后 50 条。
 */
export function trimHistoryMessages(rawMessages: unknown[], maxTurns = 40): unknown[] {
	if (rawMessages.length === 0) return rawMessages;
	const userIndices: number[] = [];
	for (let i = rawMessages.length - 1; i >= 0; i--) {
		const msg = rawMessages[i] as { role?: unknown } | undefined;
		if (msg?.role === "user") {
			userIndices.unshift(i);
			if (userIndices.length >= maxTurns) break;
		}
	}
	if (userIndices.length === 0) return rawMessages.slice(-50);
	return rawMessages.slice(userIndices[0]);
}

// ── Active branch 计算 ──────────────────────────────────

type BranchEntry = {
	id: string;
	parentId: string | null;
	type?: string;
	message?: { role?: string };
};

/**
 * 从 leafId 回溯到 root，只保留 type=message 的条目 ID。
 */
export function buildActiveBranchEntryIds(entries: BranchEntry[], leafId: string): string[] {
	const entryById = new Map<string, BranchEntry>();
	for (const entry of entries) {
		entryById.set(entry.id, entry);
	}

	const allBranchIds: string[] = [];
	let currentId: string | null = leafId;
	while (currentId) {
		allBranchIds.unshift(currentId);
		const entry = entryById.get(currentId);
		currentId = entry?.parentId ?? null;
	}
	return allBranchIds.filter((id) => entryById.get(id)?.type === "message");
}

// ── 工具调用历史重建 ────────────────────────────────────

type HistoricalToolCall = { name: string; args: unknown; timestamp?: number };

export function collectHistoricalToolCalls(rawMessages: unknown[]): Map<string, HistoricalToolCall> {
	const calls = new Map<string, HistoricalToolCall>();
	for (const message of rawMessages) {
		if (!message || typeof message !== "object") continue;
		const typed = message as Record<string, unknown>;
		if (typed.role !== "assistant" || !Array.isArray(typed.content)) continue;
		for (const block of typed.content) {
			if (!block || typeof block !== "object") continue;
			const toolCall = block as Record<string, unknown>;
			if (toolCall.type !== "toolCall" || !toolCall.id) continue;
			calls.set(String(toolCall.id), {
				name: String(toolCall.name ?? "tool"),
				args: toolCall.arguments,
				timestamp: typeof typed.timestamp === "number" ? typed.timestamp : undefined,
			});
		}
	}
	return calls;
}

export function collectHistoricalOriginalContentByPath(
	rawMessages: unknown[],
	historicalToolCalls: Map<string, { name: string; args: unknown }>,
): Map<string, string> {
	const originals = new Map<string, string>();
	for (const message of rawMessages) {
		if (!message || typeof message !== "object") continue;
		const typed = message as Record<string, unknown>;
		if (typed.role !== "toolResult") continue;
		const toolCallId = String(typed.toolCallId ?? "");
		const historicalCall = historicalToolCalls.get(toolCallId);
		if (!historicalCall || historicalCall.name !== "read") continue;
		const filePath = getToolPathFromArgs(historicalCall.args);
		if (!filePath) continue;
		const content = extractMessageText(typed.content);
		if (content) originals.set(filePath, content);
	}
	return originals;
}

export function getToolPathFromArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const typed = args as Record<string, unknown>;
	return String(
		typed.path ??
			typed.filePath ??
			typed.file ??
			typed.target_file ??
			typed.targetFile ??
			"",
	);
}

// ── 工具详情格式化 ──────────────────────────────────────

export function formatToolDetail(
	toolName: string,
	args: unknown,
	result: unknown,
	isError: boolean,
): string {
	const details = extractToolDetails(result);
	let argsObj = args;
	if (typeof args === "string" && args.trim()) {
		try {
			argsObj = JSON.parse(args) as unknown;
		} catch {
			// truncated/不可解析时保持原样
		}
	}
	const argsText = argsObj ? truncateForDetail(safeJson(argsObj)) : "";
	const resultText = result
		? truncateForDetail(extractToolResultText(result) || safeJson(result))
		: "";
	const detailsText = details ? truncateForDetail(safeJson(details)) : "";
	const sections = [
		`工具：${toolName ?? "tool"}`,
		`状态：${isError ? "失败" : "完成"}`,
		args ? `参数：\n${argsText}` : "",
		result ? `结果：\n${resultText}` : "",
		details ? `详情：\n${detailsText}` : "",
	].filter(Boolean);
	return sections.join("\n\n");
}

function extractToolDetails(result: unknown): unknown {
	if (!result || typeof result !== "object") return undefined;
	return (result as Record<string, unknown>).details;
}

// ── Ask question 解析 ───────────────────────────────────

export function tryParseBatchAskEnvelope(title: string): {
	review?: boolean;
	questions: Array<Record<string, unknown>>;
} | null {
	const raw = title?.trim();
	if (!raw || raw[0] !== "{") return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed?.__piDeckBatchAsk !== 1) return null;
		if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
		return {
			review: parsed.review === true,
			questions: parsed.questions as Array<Record<string, unknown>>,
		};
	} catch {
		return null;
	}
}

export function extractAskQuestionDetails(
	toolName: string,
	result: unknown,
	args: unknown,
): Record<string, unknown> | undefined {
	if (toolName !== "ask_question") return undefined;

	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		const rDetails = r.details as Record<string, unknown> | undefined;
		if (rDetails?.question || Array.isArray(rDetails?.answers) || Array.isArray(rDetails?.questions)) {
			return rDetails;
		}
		if (r.question || Array.isArray(r.answers) || Array.isArray(r.questions)) {
			return r;
		}
	}

	let parsedArgs: unknown = args;
	if (typeof args === "string") {
		try {
			parsedArgs = JSON.parse(args);
		} catch {
			parsedArgs = undefined;
		}
	}
	if (parsedArgs && typeof parsedArgs === "object") {
		const a = parsedArgs as Record<string, unknown>;
		if (Array.isArray(a.questions) && a.questions.length > 0) {
			const answerValue =
				typeof result === "string"
					? result
					: (result as Record<string, unknown>)?.value ?? (result as Record<string, unknown>)?.answer ?? null;
			return {
				questions: a.questions,
				answers: answerValue != null ? [{ id: (a.questions[0] as Record<string, unknown>)?.id ?? "default", value: answerValue, label: String(answerValue) }] : [],
				cancelled: false,
			};
		}
		if (a.question) {
			const answerValue =
				typeof result === "string"
					? result
					: (result as Record<string, unknown>)?.value ?? (result as Record<string, unknown>)?.answer ?? null;
			return {
				question: a.question,
				type: a.type,
				options: a.options,
				answer: answerValue,
				answered: answerValue !== null && answerValue !== undefined,
				answerLabel: answerValue != null ? String(answerValue) : undefined,
			};
		}
	}
	return undefined;
}

/**
 * 把 ask_question details 转成前端 ToolCard 用的 _askCard。
 * aborted 参数由调用方传入（live 路径传 this.abortedDuringAsk.has(agentId)，历史路径传 false）。
 */
export function buildAskCard(
	askDetails: Record<string, unknown> | undefined,
	aborted: boolean,
): Record<string, unknown> | undefined {
	if (!askDetails) return undefined;

	if (Array.isArray(askDetails.questions) || Array.isArray(askDetails.answers)) {
		const questions = Array.isArray(askDetails.questions) ? askDetails.questions : [];
		const answers = Array.isArray(askDetails.answers) ? askDetails.answers : [];
		const cancelled = aborted || askDetails.cancelled === true;
		const items = questions.map((q: Record<string, unknown>, i: number) => {
			const a = answers.find((x: Record<string, unknown>) => x?.id === q?.id) ?? answers[i];
			const value = cancelled ? null : (a as Record<string, unknown>)?.value ?? null;
			const hasAnswer = value !== null && value !== undefined;
			return {
				id: String(q?.id ?? (a as Record<string, unknown>)?.id ?? `q${i + 1}`),
				question: String(q?.question ?? (a as Record<string, unknown>)?.id ?? ""),
				type: String((a as Record<string, unknown>)?.type ?? q?.type ?? "input"),
				answered: !cancelled && hasAnswer,
				answer: value,
				answerLabel: cancelled ? undefined : (a as Record<string, unknown>)?.label ?? (hasAnswer ? String(value) : undefined),
				options: q?.options,
				wasCustom: (a as Record<string, unknown>)?.wasCustom === true,
			};
		});
		if (items.length === 0 && answers.length > 0) {
			for (const a of answers as Array<Record<string, unknown>>) {
				const value = cancelled ? null : a?.value ?? null;
				const hasAnswer = value !== null && value !== undefined;
				items.push({
					id: String(a?.id ?? "q"),
					question: String(a?.id ?? ""),
					type: String(a?.type ?? "input"),
					answered: !cancelled && hasAnswer,
					answer: value,
					answerLabel: cancelled ? undefined : a?.label ?? (hasAnswer ? String(value) : undefined),
					options: undefined,
					wasCustom: a?.wasCustom === true,
				});
			}
		}
		const anyAnswered = items.some((it: { answered: boolean }) => it.answered);
		const first = items[0] as { answer: unknown; answerLabel: unknown } | undefined;
		return {
			question: `问卷（${items.length} 题）`,
			type: "batch",
			answered: !cancelled && anyAnswered,
			answer: first?.answer ?? null,
			answerLabel: first?.answerLabel,
			options: undefined,
			cancelled,
			items,
		};
	}

	if (askDetails.question) {
		const rawAnswer = aborted ? null : askDetails.answer;
		const hasAnswer = rawAnswer !== null && rawAnswer !== undefined && rawAnswer !== "";
		const answered = aborted
			? false
			: typeof askDetails.answered === "boolean"
				? askDetails.answered
				: hasAnswer;
		return {
			question: askDetails.question,
			type: askDetails.type,
			answered,
			answer: aborted ? null : askDetails.answer,
			answerLabel: aborted ? undefined : (askDetails.answerLabel as string | undefined) ?? (hasAnswer ? String(rawAnswer) : undefined),
			options: askDetails.options,
		};
	}
	return undefined;
}

// ── 文本工具 ────────────────────────────────────────────

/** 对超长工具文本做首尾截断，保留头部和尾部以兼顾开头信息和错误堆栈。 */
export function truncateForDetail(text: unknown): string {
	const str = typeof text === "string" ? text : text == null ? "" : String(text);
	if (str.length <= MAX_TOOL_RESULT_CHARS) return str;
	const keep = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
	const omitted = str.length - keep * 2;
	return (
		`${str.slice(0, keep)}\n` +
		`…（已省略中间 ${omitted} 字符，完整内容共 ${str.length} 字符）\n` +
		str.slice(-keep)
	);
}

export function extractToolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as Record<string, unknown>).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (typeof (item as Record<string, unknown>)?.text === "string" ? (item as Record<string, unknown>).text as string : ""))
		.filter(Boolean)
		.join("\n");
}

export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** 从 pi 历史消息 content 中恢复图片附件，用于历史会话重新打开后的图片展示。 */
export function extractImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap<ImageContent>((item) => {
		if (!item || typeof item !== "object") return [];
		const typed = item as Record<string, unknown>;
		if (typed.type !== "image") return [];
		const data = typeof typed.data === "string" ? typed.data : "";
		const mimeType =
			typeof typed.mimeType === "string"
				? typed.mimeType
				: typeof typed.mime_type === "string"
					? typed.mime_type
					: "image/png";
		return data ? [{ type: "image", data, mimeType }] : [];
	});
}

/** 从历史消息 content 数组中提取 thinking 内容块的文本，清理 ANSI 转义码 */
export function extractThinking(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const raw = content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const typed = item as Record<string, unknown>;
			if (typed.type !== "thinking") return "";
			return String(typed.thinking ?? typed.text ?? "");
		})
		.filter(Boolean)
		.join("\n");
	return stripAnsi(raw);
}

/** 清理 ANSI 转义码，模型思考内容中常见终端颜色序列 */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}
