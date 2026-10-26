/**
 * 非组件工具函数集中在此，避免与组件同文件导出导致 Vite Fast Refresh 整页刷新。
 * Fast Refresh 只支持组件和 hook（useXxx）导出，普通函数导出会导致整页刷新。
 */

import type { ReactNode } from "react";
import type { ChatMessage, FileTreeNode, ImageContent, PiCommand } from "../../../../shared/types";
import { computeThinkingTiming } from "../../utils/thinkingTiming";
import { formatFilePathRef } from "./RichInput";
import type { SessionModifiedFile } from "./types";

/* ── ANSI 清理 ── */

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
	// 绝大多数消息文本不含转义码；先做一次 O(n) 扫描，命中则原样返回同一字符串对象，
	// 省掉 replace 的整串分配（20Hz 流式重算整窗消息文本时就是这条路径）。
	return text.includes("\x1b") ? text.replace(ANSI_RE, "") : text;
}

export function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/* ── 时间和摘要 ── */

// 复用同一个 Intl 实例：侧栏/时间线/大纲会按行大量调用 formatTime，
// 每次 new Date().toLocaleString 都会重建格式化器。
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
});

export function formatTime(timestamp: number) {
	return TIME_FORMATTER.format(timestamp);
}

export function summarizeMessage(text: string) {
	const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	const firstLine =
		cleaned
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
}

/* ── 路径与匹配 ── */

export function matches(value: string, keyword: string) {
	return (
		!keyword.trim() ||
		value.toLowerCase().includes(keyword.trim().toLowerCase())
	);
}

function getHomePathPrefix() {
	const match = location.href.match(/file:\/\/\/([A-Za-z]:\/Users\/[^/]+)/i);
	return match?.[1] ?? "C:/Users/14012";
}

export function displayPath(path?: string) {
	if (!path) return "";
	const home = getHomePathPrefix();
	const normalized = path.replace(/\\/g, "/");
	const friendly =
		home && normalized.toLowerCase().startsWith(home.toLowerCase())
			? `~${normalized.slice(home.length)}`
			: normalized;
	return friendly.length > 36 ? `...${friendly.slice(-35)}` : friendly;
}

/**
 * 将文件树展平为文件 + 目录列表。
 * 目录节点一并保留，供 @ 引用搜索与 chip 白名单使用（空目录也能被引用）。
 */
export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) =>
		node.type === "file"
			? [node]
			: [node, ...flattenFiles(node.children ?? [])],
	);
}

/* ── 消息分组类型 ── */

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

/* ── 消息分组 ── */

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

/* ── 会话大纲 ── */

export type OutlineItem = {
	id: string;
	role: string;
	title: string;
	time: string;
};

// 流式期间 transcript 每 50ms 更新一次，但绝大多数历史 user 消息对象引用不变。
// 用 WeakMap 缓存每条消息的大纲项，避免反复跑摘要正则和 Intl 格式化；
// 未变化的消息返回同一个 item 对象，宿主据此保持 items 数组引用稳定。
const outlineItemCache = new WeakMap<
	ChatMessage,
	{ text: string; timestamp: number; item: OutlineItem | null }
>();

export function buildOutline(messages: ChatMessage[]): OutlineItem[] {
	const result: OutlineItem[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		const cached = outlineItemCache.get(message);
		// 同一对象也可能被原地改写（刷新/编辑），因此再核对一次文本与时间戳。
		let item = cached && cached.text === message.text && cached.timestamp === message.timestamp
			? cached.item
			: undefined;
		if (item === undefined) {
			const title = summarizeMessage(message.text);
			item = title
				? {
						id: message.id,
						role: message.role,
						title,
						time: formatTime(message.timestamp),
					}
				: null;
			outlineItemCache.set(message, {
				text: message.text,
				timestamp: message.timestamp,
				item,
			});
		}
		if (item) result.push(item);
	}
	return result;
}

/* ── 输入框建议 ── */

export type ComposerSuggestionResult = {
	text: string;
	cursor: number;
};

export type ComposerTrigger = {
	start: number;
	char: string;
	query: string;
};

export function detectTrigger(
	text: string,
	cursor: number,
): ComposerTrigger | null {
	if (cursor < 0 || cursor > text.length) cursor = text.length;
	const before = text.slice(0, cursor);
	const atIdx = before.lastIndexOf("@");
	const slashIdx = before.lastIndexOf("/");
	const ampIdx = before.lastIndexOf("&");
	const start = Math.max(atIdx, slashIdx, ampIdx);
	if (start < 0) return null;
	const char = before[start];
	const segment = before.slice(start + 1);
	if (char === "&") {
		if (/[\n]/.test(segment)) return null;
		const prev = start > 0 ? before[start - 1] : "";
		// 只阻止 URL 查询参数场景（?foo=bar&），不拦 &&、&chip& 等正常场景
		if (prev === "=" || prev === "?") return null;
		return { start, char, query: segment };
	}
	if (char === "/") {
		// 检查 / 是否属于 @file 路径（@ 在前且路径段内无空白），是则当作 @ 触发而非命令。
		// 关键：路径完成后光标后有空格/后续文本时（@src/ 说明…），必须关闭，
		// 否则路径中的每个 / 都会把建议框永久钉住。
		const beforeSlash = before.slice(0, start);
		const atBefore = beforeSlash.lastIndexOf("@");
		if (atBefore >= 0 && !/\s/.test(beforeSlash.slice(atBefore))) {
			const fileSegment = before.slice(atBefore + 1);
			if (/\s/.test(fileSegment)) return null;
			return { start: atBefore, char: "@", query: fileSegment };
		}
		// 子命令输入：`/fast on` 保留触发，让带 subcommands 的命令能继续提示第二段。
		// 只放行「命令名 + 恰好一个子命令 token」，且 / 必须位于词首（行首或空白之后），
		// 否则正文里的 "and/or something" 会被误判成命令；再出现空白即关闭，避免面板钉死。
		const subMatch = /^([\w.:-]+) ([\w.:-]*)$/.exec(segment);
		const charBeforeSlash = start > 0 ? before[start - 1] : "";
		if (subMatch && (!charBeforeSlash || /\s/.test(charBeforeSlash))) return { start, char, query: segment };
	}
	if (/[\s@/&]/.test(segment)) return null;
	const prevChar = start > 0 ? before[start - 1] : "";
	if (prevChar) {
		if (/[:/]/.test(prevChar)) return null;
	}
	return { start, char, query: segment };
}

export function applySuggestion(
	current: string,
	cursor: number,
	value: string,
): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor);
	if (!trigger) {
		const text = `${current}${value} `;
		return { text, cursor: text.length };
	}
	const text = `${current.slice(0, trigger.start)}${value} ${current.slice(cursor)}`;
	return { text, cursor: trigger.start + value.length + 1 };
}

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
	/** 命令参数提示（omp input.hint），渲染在命令名右侧，如 `[on|off|status]` */
	hint?: string;
	/** 不可选中的分组头；目录本身可选，不再使用 disabled 表示目录 */
	disabled?: boolean;
	/** 树形缩进层级（0=根目录），仅在 @ 无关键词时使用 */
	treeDepth?: number;
	/** 目录引用：UI 显示文件夹图标，插入路径与文件相同 */
	isDirectory?: boolean;
	sessionMeta?: { sessionId: string; filePath: string; projectPath?: string };
};

/* ── 命令管理 ── */

/**
 * 桌面有专用 UI 承载、无需在斜线命令建议中暴露的内置命令。
 * `model`：桌面有模型选择器（model picker），重复暴露会造成两个入口不一致。
 */
const HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES: Record<string, true> = { model: true };

/**
 * 命令目录的唯一事实源是 omp runtime（启动推送 + `agents.commands` 拉取）。
 *
 * 1. 隐藏「桌面已有等价入口」的内置命令（`model` 有专用模型选择器）；
 * 2. 再按名字去重，保留先出现的可见项。顺序很关键：必须先隐藏再去重，
 *    否则 builtin `model` 先占位后，扩展同名命令会被当作重复项丢掉，
 *    用户可执行的命令从建议里消失。旧实现还维护过一份手写内置命令清单，
 *    它曾与 runtime 漂移，凭空多出 /copy、/hotkeys、/settings、/vision。
 */
export function filterVisibleCommands(commands: PiCommand[]) {
	const seen = new Set<string>();
	const visible: PiCommand[] = [];
	for (const command of commands) {
		const key = command.name.toLowerCase();
		const isBuiltin = command.source == null || command.source === "builtin";
		if (isBuiltin && HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES[key]) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		visible.push(command);
	}
	return visible;
}

function fuzzyScore(value: string, keyword: string) {
	if (!keyword) return 1;
	const text = value.toLowerCase();
	const query = keyword.toLowerCase();
	if (text.includes(query)) return 100 + query.length;
	let score = 0;
	let pos = 0;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found === -1) return 0;
		score += found === pos ? 8 : 2;
		pos = found + 1;
	}
	return score;
}

/** 目录引用在建议列表与插入文本中都用尾斜杠标记，避免 @src 被模型当成智能体。 */
function formatPathSuggestionLabel(node: FileTreeNode): string {
	return node.type === "directory" ? `@${node.name}/` : `@${node.name}`;
}

function formatPathSuggestionValue(node: FileTreeNode): string {
	return formatFilePathRef(node.relativePath, {
		isDirectory: node.type === "directory",
	});
}

/**
 * 从扁平路径列表（文件 + 目录）重建一级树视图。
 * 目录与文件均可选，便于直接 @src 这类目录引用。
 */
function buildFileTreeItems(entries: FileTreeNode[]): SuggestionItem[] {
	interface PathNode {
		name: string;
		relativePath: string;
		children: Map<string, PathNode>;
		files: FileTreeNode[];
		dirNode?: FileTreeNode;
	}
	// 用 / 分隔符构建路径树；目录节点单独挂 dirNode，空目录也能出现。
	const root: PathNode = { name: "", relativePath: "", children: new Map(), files: [] };
	const ensureDir = (parent: PathNode, part: string): PathNode => {
		let child = parent.children.get(part);
		if (!child) {
			const relativePath = parent.relativePath ? `${parent.relativePath}/${part}` : part;
			child = { name: part, relativePath, children: new Map(), files: [] };
			parent.children.set(part, child);
		}
		return child;
	};
	for (const entry of entries) {
		const parts = entry.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
		if (parts.length === 0) continue;
		if (entry.type === "directory") {
			let node = root;
			for (const part of parts) node = ensureDir(node, part);
			node.dirNode = entry;
			continue;
		}
		let node = root;
		for (const part of parts.slice(0, -1)) node = ensureDir(node, part);
		node.files.push(entry);
	}
	// 仅展平第一层（根目录文件 + 一级目录），避免大项目卡顿
	const result: SuggestionItem[] = [];
	function flatten(node: PathNode, depth: number, maxDepth: number) {
		const sortedDirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
		const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
		for (const dir of sortedDirs) {
			const dirPath = dir.dirNode?.relativePath ?? dir.relativePath;
			result.push({
				key: dir.dirNode?.path ?? `dir:${dirPath}`,
				label: `@${dir.name}/`,
				description: dirPath,
				// 必须插入 @dir/：裸 @dir 无法过 chip 路径规则，也易被模型当成 mention
				value: formatFilePathRef(dirPath, { isDirectory: true }),
				treeDepth: depth,
				isDirectory: true,
			});
			if (depth < maxDepth) flatten(dir, depth + 1, maxDepth);
		}
		for (const file of sortedFiles) {
			result.push({
				key: file.path,
				label: formatPathSuggestionLabel(file),
				description: file.relativePath,
				value: formatPathSuggestionValue(file),
				treeDepth: depth,
				isDirectory: file.type === "directory",
			});
		}
	}
	flatten(root, 0, 0); // 只展开第一层
	return result;
}

export function buildSuggestionItems(
	prompt: string,
	cursor: number,
	commands: PiCommand[],
	files: FileTreeNode[],
	sessions?: { id: string; filePath: string; projectPath?: string; name?: string; preview: string; updatedAt: number }[],
): SuggestionItem[] {
	const allCommands = filterVisibleCommands(commands);
	const trigger = detectTrigger(prompt, cursor);
	if (!trigger) return [];
	const keyword = trigger.query.toLowerCase();
	if (trigger.char === "/") {
		// 已有子命令段：`/fast on`。只有命令自身声明了 subcommands 才展开，
		// 未声明的组合返回空——参数值不该被当成命令候选。
		const spaceAt = keyword.indexOf(" ");
		if (spaceAt > 0) {
			const commandName = keyword.slice(0, spaceAt);
			const subQuery = keyword.slice(spaceAt + 1);
			const command = allCommands.find((item) => item.name.toLowerCase() === commandName);
			if (!command) return [];
			return (command.subcommands ?? [])
				.filter((sub) => sub.name.toLowerCase().includes(subQuery))
				.map((sub) => ({
					// 用 runtime 的原始大小写生成插入文本，避免把 `/SkillName` 改写成小写
					key: `${command.name} ${sub.name}`,
					label: `/${command.name} ${sub.name}`,
					description: sub.description ?? "",
					value: `/${command.name} ${sub.name}`,
				}));
		}
		return allCommands
			.filter((command) => command.name.toLowerCase().includes(keyword))
			.map((command) => ({
				key: command.name,
				label: `/${command.name}`,
				hint: command.inputHint,
				description: command.description ?? "",
				value: `/${command.name}`,
			}));
	}
	if (trigger.char === "@") {
		if (!keyword) {
			// 无关键词：展示一级目录/文件；目录可直接选中引用
			return buildFileTreeItems(files);
		}
		// 有关键词：文件与目录一起模糊搜索；同名时目录略优先，方便找文件夹
		return files
			.map((file) => ({
				file,
				score:
					fuzzyScore(file.relativePath, keyword) +
					fuzzyScore(file.name, keyword) * 2 +
					(file.type === "directory" ? 4 : 0),
			}))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 15)
			.map((item) => ({
				key: item.file.path,
				label: formatPathSuggestionLabel(item.file),
				description: item.file.relativePath,
				// 相对路径含空格时同样加引号；目录追加 / 以通过 chip 规则并语义化为路径。
				value: formatPathSuggestionValue(item.file),
				isDirectory: item.file.type === "directory",
			}));
	}
	if (trigger.char === "&") {
		const list = sessions ?? [];
		return list
			.map((s) => ({ session: s, score: fuzzyScore(s.name ?? s.filePath, keyword) + fuzzyScore(s.preview ?? "", keyword) }))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				key: item.session.filePath,
				label: item.session.name ?? item.session.filePath,
				description: item.session.preview,
				value: `&${item.session.name ?? item.session.filePath}`,
				sessionMeta: { sessionId: item.session.id, filePath: item.session.filePath, projectPath: item.session.projectPath },
			}));
	}
	return [];
}

/* ── 工具参数解析 ── */

export function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		let parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "string" && parsed.trim()) {
			try { parsed = JSON.parse(parsed); } catch { return undefined; }
		}
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function getToolFilePath(args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	return typeof a.filePath === "string" && a.filePath ? a.filePath
		: typeof a.file_path === "string" && a.file_path ? a.file_path
		: typeof a.path === "string" && a.path ? a.path
		: typeof a.targetPath === "string" && a.targetPath ? a.targetPath
		: typeof a.target_path === "string" && a.target_path ? a.target_path
		: typeof a.outputPath === "string" && a.outputPath ? a.outputPath
		: typeof a.output_path === "string" && a.output_path ? a.output_path
		: typeof a.file === "string" && a.file ? a.file
		: typeof a.fileName === "string" && a.fileName ? a.fileName
		: typeof a.filename === "string" && a.filename ? a.filename
		: undefined;
}

export function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

export function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (edits) {
		const parts = edits.map((edit: unknown) => {
			if (!edit || typeof edit !== "object") return null;
			const e = edit as Record<string, unknown>;
			const oldText = String(e.oldText ?? e.old_text ?? "");
			const newText = String(e.newText ?? e.new_text ?? "");
			return { oldText, newText };
		}).filter((p): p is { oldText: string; newText: string } => p !== null);
		if (parts.length === 0) return undefined;
		return {
			oldText: parts.map(p => p.oldText).join("\n"),
			newText: parts.map(p => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

export function getToolNewContent(toolName: string, args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (!toolName) return undefined;
	if (/write|create/i.test(toolName)) {
		const a = args as Record<string, unknown>;
		return typeof a.content === "string" ? a.content : typeof a.text === "string" ? a.text : typeof a.data === "string" ? a.data : typeof a.body === "string" ? a.body : undefined;
	}
	if (/edit|patch/i.test(toolName)) {
		const diff = getToolEditDiff(args);
		return diff?.newText;
	}
	return undefined;
}

export function getToolChangedLineCount(toolName: string, args: any): number {
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return 0; }
	}
	if (!toolName) return 0;
	if (/edit|patch/i.test(toolName)) {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		if (edits) {
			return edits.reduce((total: number, edit: any) => {
				const oldLines = countTextLines(String(edit?.oldText ?? edit?.old_text ?? ""));
				const newLines = countTextLines(String(edit?.newText ?? edit?.new_text ?? ""));
				return total + Math.max(oldLines, newLines);
			}, 0);
		}
		return Math.max(countTextLines(String(args?.oldText ?? args?.old_text ?? "")), countTextLines(String(args?.newText ?? args?.new_text ?? "")));
	}
	if (/write|create/i.test(toolName)) {
		return countTextLines(String(args?.content ?? args?.text ?? args?.data ?? args?.body ?? ""));
	}
	return 0;
}

/**
 * 从工具消息里归并出「当前会话修改过的文件」。
 *
 * 之前这段推导挂在 App 根 useMemo 上，导致 transcript 每次 50ms 增量都要唤醒根组件；
 * 现在只在真正需要（打开 diff）时按当前 transcript 快照计算一次，点击路径可接受 O(n)。
 */
export function buildModifiedFiles(messages: ChatMessage[]): SessionModifiedFile[] {
	const byPath = new Map<string, SessionModifiedFile>();
	for (const msg of messages) {
		if (msg.role !== "tool") continue;
		const toolName: string | undefined = msg.meta?.toolName as string | undefined;
		const args: unknown = msg.meta?.args;
		const status: string = String(msg.meta?.status ?? "done");
		// 只收集文件写入/编辑类的工具调用，作为右侧 Files 与会话结束摘要的统一数据源。
		if (!toolName || !/write|edit|create|patch/i.test(toolName)) continue;
		const filePath = getToolFilePath(args);
		if (!filePath) continue;
		const previous = byPath.get(filePath);
		// 同一路径再次被修改时移动到 Map 末尾，右侧修改清单才能按"最新修改"展示。
		if (previous) byPath.delete(filePath);
		// originalContent 不再存储到消息 meta 中（full file 会使会话体积过大）。
		// diff 展示时使用工具参数（oldText/newText）显示变动区域。
		byPath.set(filePath, {
			path: filePath,
			toolName,
			status: status === "running" ? "running" : (previous?.status ?? status),
			changedLines: (previous?.changedLines ?? 0) + getToolChangedLineCount(toolName, args),
			originalContent: "",
			content: getToolNewContent(toolName, args) ?? previous?.content,
		});
	}
	return Array.from(byPath.values());
}

