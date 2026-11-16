/**
 * 时间线投影：transcript 消息 → 渲染条目（agent-run / 文本 / 工具组 / 思考组）。
 *
 * 为什么收成一个模块：分组结果每次渲染都会整体重建，因此「怎么分组」和「怎么判定两条
 * 条目内容相同」必须是同一份知识——比较器的字段集一旦与分组产物的字段集漂移，memo 就会
 * 恒定失效（流式期间每个 delta 都让整轮历史重跑 markdown 解析）或者错误跳过重渲染。
 * 两者放在一起，改一处字段就必然看到另一处。
 *
 * 纯函数、零 React、零 DOM，因此在接口层面直接单测。
 */
import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import { computeThinkingTiming } from "../../../utils/thinkingTiming";
import { stripAnsi, stripThinkingTags } from "../format";

export type ToolGroupItem = {
	kind: "tool-group";
	id: string;
	messages: ChatMessage[];
};

export type MessageItem = { kind: "message"; message: ChatMessage };

export type ThinkingGroupItem = {
	kind: "thinking-group";
	id: string;
	messages: ChatMessage[];
	text: string;
	startedAt: number;
	endedAt: number;
};

export type AgentRunItem = {
	kind: "agent-run";
	id: string;
	items: Array<MessageItem | ToolGroupItem | ThinkingGroupItem>;
	startedAt: number;
	endedAt: number;
};

export type RenderMessage = MessageItem | ToolGroupItem | ThinkingGroupItem | AgentRunItem;

export function sameChatMessageForRender(previous: ChatMessage, next: ChatMessage): boolean {
	// 引用相等直接短路：流式期间未变更的消息按引用复用，避免逐字段深比较。
	if (previous === next) return true;
	if (
		previous.id !== next.id ||
		previous.role !== next.role ||
		previous.text !== next.text ||
		previous.thinking !== next.thinking ||
		previous.timestamp !== next.timestamp ||
		// meta 按引用比较：工具卡的状态/参数/详情都住在 meta 里，且主进程每次推送都是新对象
		// （渲染层不就地改 meta）。只比较上面几个字段会让「工具从 running 变 completed」被判为
		// 未变化，卡片状态停留在 running。
		previous.meta !== next.meta
	) {
		return false;
	}
	return sameImageListForRender(previous.images, next.images);
}

/**
 * 图片列表按内容相等比较。
 *
 * 图片数组常由调用方每次渲染重新拼装（如 TurnRow 汇总整轮图片），引用比较会让
 * memo 永远失效；图片 data 是不变的内容，按内容比较才能让未变化的子树跳过重渲染。
 */
export function sameImageListForRender(
	previous: ImageContent[] | undefined,
	next: ImageContent[] | undefined,
): boolean {
	if (previous === next) return true;
	const a = previous ?? [];
	const b = next ?? [];
	return (
		a.length === b.length &&
		a.every(
			(image, index) =>
				image.mimeType === b[index]?.mimeType && image.data === b[index]?.data,
		)
	);
}

export function sameAgentRunForRender(previous: AgentRunItem, next: AgentRunItem): boolean {
	if (previous === next) return true;
	if (
		previous.id !== next.id ||
		previous.startedAt !== next.startedAt ||
		previous.endedAt !== next.endedAt ||
		previous.items.length !== next.items.length
	) {
		return false;
	}
	return previous.items.every((item, index) => {
		const other = next.items[index];
		if (!other || item.kind !== other.kind) return false;
		if (item.kind === "message" && other.kind === "message") {
			return sameChatMessageForRender(item.message, other.message);
		}
		if (item.kind === "thinking-group" && other.kind === "thinking-group") {
			return (
				item.id === other.id &&
				item.text === other.text &&
				item.startedAt === other.startedAt &&
				item.endedAt === other.endedAt
			);
		}
		if (item.kind === "tool-group" && other.kind === "tool-group") {
			return (
				item.id === other.id &&
				item.messages.length === other.messages.length &&
				item.messages.every((message, messageIndex) =>
					sameChatMessageForRender(message, other.messages[messageIndex]),
				)
			);
		}
		return false;
	});
}

/**
 * 顶层渲染条目（agent-run / 独立消息 / 理论上的 thinking、tool 组）的内容相等比较，
 * 供 MessageListContent 的 memo 比较器使用：对象每次由 groupToolMessages 重建，
 * 必须按内容比较而不是引用，未变化的 run 才能跳过重渲染。
 */
export function sameRenderMessageForRender(previous: RenderMessage, next: RenderMessage): boolean {
	if (previous.kind !== next.kind) return false;
	switch (previous.kind) {
		case "agent-run":
			return next.kind === "agent-run" && sameAgentRunForRender(previous, next);
		case "message":
			return next.kind === "message" && sameChatMessageForRender(previous.message, next.message);
		case "thinking-group":
			return (
				next.kind === "thinking-group" &&
				previous.id === next.id &&
				previous.text === next.text &&
				previous.startedAt === next.startedAt &&
				previous.endedAt === next.endedAt
			);
		case "tool-group":
			return (
				next.kind === "tool-group" &&
				previous.id === next.id &&
				previous.messages.length === next.messages.length &&
				previous.messages.every((message, messageIndex) =>
					sameChatMessageForRender(message, next.messages[messageIndex]),
				)
			);
	}
}

/** 顶层条目列表的内容相等比较（长度 + 逐条内容）。 */
export function sameRenderMessageListForRender(
	previous: RenderMessage[],
	next: RenderMessage[],
): boolean {
	// 未变更的列表（同一数组引用）在父组件每次渲染时都会被比较一次，先短路。
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	return previous.every((item, index) => sameRenderMessageForRender(item, next[index]));
}

export function getMultiSelectImageCaptureIds(
	items: RenderMessage[],
	selectedIds: Set<string>,
): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (item.kind === "message") {
			if (selectedIds.has(item.message.id)) ids.add(item.message.id);
			continue;
		}
		if (item.kind === "agent-run") {
			const hasSelectedAssistant = item.items.some(
				(sub) =>
					sub.kind === "message" &&
					sub.message.role === "assistant" &&
					selectedIds.has(sub.message.id),
			);
			if (hasSelectedAssistant) ids.add(item.id);
		}
	}
	return ids;
}

export function groupToolMessages(messages: ChatMessage[]): RenderMessage[] {
	const result: RenderMessage[] = [];
	let currentTools: ChatMessage[] = [];
	let currentThinking: ChatMessage[] = [];
	let currentRun: Array<MessageItem | ToolGroupItem | ThinkingGroupItem> = [];
	let runStartedAt = 0;
	let runEndedAt = 0;
	/** 当前回合的触发用户消息时间戳，用于替代 assistant/tool 时间戳作为回合起点 */
	let lastUserTimestamp = 0;

	function isThinkingOnly(message: ChatMessage) {
		return (
			message.role === "assistant" &&
			Boolean(message.thinking?.trim()) &&
			!stripThinkingTags(stripAnsi(message.text)).trim()
		);
	}

	function flushThinking() {
		if (currentThinking.length === 0) return;
		const previous = currentRun[currentRun.length - 1];
		// 单一计时链：startedAt 取首条消息、endedAt 取末条消息，均走
		// computeThinkingTiming（timestampTier 保留本路径原链的 timestamp 层级），
		// run.endedAt 兜底是模块签名外的显式尾部回退（见 thinkingTiming 变化报告）。
		const now = Date.now();
		const started = computeThinkingTiming(
			currentThinking[0],
			undefined,
			runStartedAt,
			now,
			{ timestampTier: true },
		);
		const ended = computeThinkingTiming(
			currentThinking[currentThinking.length - 1],
			undefined,
			runEndedAt,
			now,
			{ timestampTier: true },
		);
		const nextGroup: ThinkingGroupItem = {
			kind: "thinking-group",
			id: currentThinking.map((message) => message.id).join("|"),
			messages: currentThinking,
			text: currentThinking
				.map((message) => stripAnsi(message.thinking ?? ""))
				.filter(Boolean)
				.join("\n\n"),
			startedAt: started.startedAt ?? runStartedAt,
			endedAt: ended.endedAt ?? runEndedAt,
		};
		if (previous?.kind === "thinking-group") {
			previous.id = `${previous.id}|${nextGroup.id}`;
			previous.messages = [...previous.messages, ...nextGroup.messages];
			previous.text = [previous.text, nextGroup.text].filter(Boolean).join("\n\n");
			previous.endedAt = nextGroup.endedAt;
		} else {
			currentRun.push(nextGroup);
		}
		runEndedAt = nextGroup.endedAt;
		currentThinking = [];
	}

	function flushTools() {
		if (currentTools.length === 0) return;
		flushThinking();
		const group: ToolGroupItem = {
			kind: "tool-group",
			id: currentTools.map((message) => message.id).join("|"),
			messages: currentTools,
		};
		currentRun.push(group);
		runEndedAt = currentTools[currentTools.length - 1]?.timestamp ?? runEndedAt;
		currentTools = [];
	}

	function flushRun() {
		flushTools();
		flushThinking();
		if (currentRun.length === 0) return;

		// 合并连续的 assistant 文本消息，避免同一轮回答被拆成多个气泡
		const merged: Array<MessageItem | ToolGroupItem | ThinkingGroupItem> = [];
		for (const item of currentRun) {
			const prev = merged[merged.length - 1];
			if (
				item.kind === "message" &&
				item.message.role === "assistant" &&
				prev?.kind === "message" &&
				prev.message.role === "assistant"
			) {
				prev.message = {
					...prev.message,
					text: prev.message.text + "\n\n" + item.message.text,
					thinking: (prev.message.thinking || "") + (item.message.thinking ? "\n\n" + item.message.thinking : ""),
					id: prev.message.id + "|" + item.message.id,
				};
			} else {
				merged.push(item);
			}
		}

		result.push({
			kind: "agent-run",
			id: merged
				.map((item) => (item.kind === "message" ? item.message.id : item.id))
				.join("|"),
			items: merged,
			// 回合起点优先用触发它的用户消息时间戳，无用户消息时回退到 run 内首条消息时间戳
			startedAt: lastUserTimestamp || runStartedAt,
			endedAt: runEndedAt || runStartedAt,
		});
		currentRun = [];
		runStartedAt = 0;
		runEndedAt = 0;
		lastUserTimestamp = 0;
	}

	function appendRunMessage(message: ChatMessage) {
		flushThinking();
		flushTools();
		if (currentRun.length === 0) runStartedAt = message.timestamp;
		runEndedAt = message.timestamp;
		currentRun.push({ kind: "message", message });
	}

	// 暂存区：仅用于 ask_question 续答——system 卡片后用户回复时，把卡片前的工具/思考
	// 暂存起来，等下一条 assistant 到来后合并为同一 agent-run。
	// 普通「上一轮只有工具/思考、用户又发新问题」场景不得使用此暂存，否则会串轮。
	let pendingRun: (MessageItem | ToolGroupItem | ThinkingGroupItem)[] | null = null;

	for (const message of messages) {
		if (isThinkingOnly(message)) {
			flushTools();
			if (currentRun.length === 0 && currentThinking.length === 0) {
				runStartedAt = message.timestamp;
			}
			currentThinking.push(message);
			runEndedAt = message.timestamp;
		} else if (message.role === "assistant") {
			// 有暂存 run 时先合并到当前 run
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
			}
			appendRunMessage(message);
		} else if (message.role === "tool") {
			flushThinking();
			if (currentRun.length === 0) runStartedAt = message.timestamp;
			currentTools.push(message);
		} else if (message.role === "system") {
			// System 消息（如 askQuestion 卡片）不应中断当前 agent run。
			// 工具、thinking 和后续 assistant 消息应合并为同一轮回答，
			// 否则会被拆成两个独立的折叠区域。
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉。
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				flushRun();
			}
			result.push({ kind: "message", message });
		} else {
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				flushRun();
			}
			// 用户消息到来时，当前 run 可能只有工具/思考、没有最终回答文本。
			// 仅在「回答 ask_question」场景下暂存合并：上一条 result 是 system 消息。
			// 普通新提问（上一轮未完成回答就发下一条）必须 flush 成独立 agent-run，
			// 否则上一轮的工具/思考会混进下一轮回答块。
			const hasToolsWithoutAssistant =
				currentRun.length > 0 &&
				currentRun.every((i) => i.kind !== "message" || i.message.role !== "assistant");
			const lastResult = result[result.length - 1];
			const isAnsweringAskQuestion =
				lastResult?.kind === "message" && lastResult.message.role === "system";
			if (hasToolsWithoutAssistant && isAnsweringAskQuestion) {
				flushTools();
				flushThinking();
				pendingRun = [...currentRun];
				currentRun = [];
				runStartedAt = 0;
				runEndedAt = 0;
			} else {
				flushRun();
			}
			result.push({ kind: "message", message });
			// 记录触发回合的用户消息时间戳，作为回合的真实起点
			lastUserTimestamp = message.timestamp;
		}
	}
	// 最后 flush 当前 run（含合并后的暂存 run）
	if (pendingRun) {
		currentRun.push(...pendingRun);
		pendingRun = null;
	}
	flushRun();

	return result;
}
