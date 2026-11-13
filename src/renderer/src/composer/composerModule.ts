/**
 * composer 深模块的纯实现：输入链的全部规则都收敛在这里。
 *
 * 职责边界：
 * - 本文件只有纯函数（无 React、无 DOM、无 IPC），因此可直接单测；
 * - React 侧只有 `useComposerController` 一层薄适配（DOM 事件转发 + 状态存放）；
 * - 草稿/图片/历史的存储仍由既有 owner 持有（useAgentLifecycle / composerSlice），
 *   这里只提供读改写规则，绝不引入第二个 store。
 *
 * 迁入来源：App.tsx 中 8 组分散的输入链逻辑
 * （draft 镜像推导、bang 识别、光标意图、建议索引、提示历史、历史合并、发送路线、
 * 队列行投影），原 utils/queueChips 与 messageDeltaResolver 里的历史合并副本已合并到本文件。
 */
import type {
	AgentQueuedMessages,
	ComposerAgentMode,
	RestoredQueuedMessage,
} from "../../../shared/types";

/* ── 1. bang 模式（`!` 执行 shell / `!!` 静默执行） ─────────────────────── */

export type ComposerBangMode = "none" | "bang" | "bang-bang";

/**
 * 从草稿前缀判断 shell 模式。
 * 只认行首：用户正文中间的 `!` 不改变执行语义。
 */
export function detectBangMode(text: string): ComposerBangMode {
	if (text.startsWith("!!")) return "bang-bang";
	if (text.startsWith("!")) return "bang";
	return "none";
}

/* ── 2. 提示历史：合并 / 上限 / 记录 / 导航 ─────────────────────────────── */

/** 历史条数上限：发送记录、消息基线重建、会话文件补全共用同一常量。 */
export const PROMPT_HISTORY_LIMIT = 100;

/**
 * 合并两份「最新在前、各自去重」的历史列表：incoming 是权威较新来源放前面，
 * existing（持久化/发送记录）补充更早的条目；按 trim 后文本去重、空白条目丢弃，结果限长。
 */
export function mergePromptHistory(
	existing: readonly string[] | undefined,
	incoming: readonly string[],
	limit: number = PROMPT_HISTORY_LIMIT,
): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const text of [...incoming, ...(existing ?? [])]) {
		const trimmed = text.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		merged.push(trimmed);
	}
	return merged.slice(0, limit);
}

/**
 * 该条发送是否进历史：空白不发、`!` 开头的 shell 快捷命令不进历史
 * （历史导航回填的是 prompt，回填 shell 命令会造成误执行）。
 */
export function shouldRecordPrompt(text: string): boolean {
	return Boolean(text.trim()) && !text.startsWith("!");
}

/**
 * 记录一条已发送 prompt：同文本去重后置顶（再次发送同一句应上移而不是出现两份），
 * 结果受上限约束。返回新数组，调用方负责落库。
 */
export function recordPromptHistory(
	existing: readonly string[] | undefined,
	text: string,
	limit: number = PROMPT_HISTORY_LIMIT,
): string[] {
	const trimmed = text.trim();
	const deduped = (existing ?? []).filter((entry) => entry !== trimmed);
	return mergePromptHistory(undefined, [trimmed, ...deduped], limit);
}

/** 会话路径键一定包含路径分隔符；agentId（UUID / pending-*）永不含分隔符。 */
export function isSessionPathKey(key: string): boolean {
	return key.includes("/") || key.includes("\\");
}

/**
 * 历史记录的稳定键：优先 sessionPath（跨重启/重开稳定），否则退回 agentId
 * （匿名会话；agentId 每次打开随机生成，仅本次进程内有意义）。
 */
export function historyKeyForAgent(
	agentId: string,
	agents: readonly { id: string; sessionPath?: string }[],
): string {
	const agent = agents.find((candidate) => candidate.id === agentId);
	return agent?.sessionPath ?? agentId;
}

/** 历史导航状态：index = -1 且 navigating=false 即「未在导航」。 */
export type PromptHistoryNavigation = {
	index: number;
	navigating: boolean;
	/** 开始导航前的实时草稿；导航退回原位时原样恢复。 */
	savedPrompt: string;
};

export const IDLE_PROMPT_HISTORY_NAVIGATION: PromptHistoryNavigation = Object.freeze({
	index: -1,
	navigating: false,
	savedPrompt: "",
});

export type PromptHistoryStep = {
	state: PromptHistoryNavigation;
	/** 需要写回草稿的文本；缺省表示本次按键不改变草稿（已到列表尽头）。 */
	text?: string;
};

/**
 * 上下键历史导航的单步转移。
 *
 * 规则（与原 App 内联实现逐点等价，改顺序会改行为）：
 * - ↑：未导航时先快照实时草稿并回到最新一条；导航中一路上移，到顶不再变化；
 * - ↓：未导航时不动；导航中下移一条，从最旧一条再 ↓ 恢复原始草稿；
 * - 历史数组变短（切会话/替换 agent）导致索引越界时安全退出导航，不改草稿。
 *
 * 返回值 null 表示该方向不适用（无历史 / 未在导航），调用方不得 preventDefault。
 */
export function stepPromptHistoryNavigation(params: {
	state: PromptHistoryNavigation;
	direction: "up" | "down";
	history: readonly string[];
	draft: string;
}): PromptHistoryStep | null {
	const { state, direction, history, draft } = params;
	if (direction === "up") {
		if (history.length === 0) return null;
		if (!state.navigating) {
			return { state: { index: 0, navigating: true, savedPrompt: draft }, text: history[0] };
		}
		const nextIndex = Math.min(state.index + 1, history.length - 1);
		if (nextIndex === state.index) return null;
		return { state: { ...state, index: nextIndex }, text: history[nextIndex] };
	}
	if (!state.navigating) return null;
	if (state.index > 0) {
		const nextIndex = state.index - 1;
		if (nextIndex >= history.length) {
			// 越界保护：切 agent 后历史更短，直接退出导航而不是读到 undefined。
			return { state: IDLE_PROMPT_HISTORY_NAVIGATION };
		}
		return { state: { ...state, index: nextIndex }, text: history[nextIndex] };
	}
	return { state: IDLE_PROMPT_HISTORY_NAVIGATION, text: state.savedPrompt };
}

/** ESC 退出导航：恢复导航前的实时草稿；未在导航时返回 null（调用方转去关建议面板）。 */
export function cancelPromptHistoryNavigation(
	state: PromptHistoryNavigation,
): PromptHistoryStep | null {
	if (!state.navigating) return null;
	return { state: IDLE_PROMPT_HISTORY_NAVIGATION, text: state.savedPrompt };
}

/* ── 3. 建议框索引（slash / @ 文件 / & 会话） ──────────────────────────── */

/** 把建议索引钳制到 [0, length-1]；空列表统一为 0（面板不渲染，值无意义）。 */
export function clampSuggestionIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

/** 上下键移动建议索引：到边界后停住（与列表滚动行为一致，不循环）。 */
export function stepSuggestionIndex(index: number, length: number, delta: number): number {
	if (length <= 0) return 0;
	return clampSuggestionIndex(index + delta, length);
}

/* ── 4. 发送路线：空闲直发 / 运行中 steer / 显式 followUp ──────────────── */

/** steer = 注入当前轮；followUp = 排到下一轮；send = 空闲直发。 */
export type ComposerSendRoute = "send" | "steer" | "followUp";
/** 传给 pi 的 streamingBehavior：空闲直发不带该字段。 */
export type StreamingBehavior = "steer" | "followUp" | undefined;

/**
 * 发送路线判定。
 *
 * 运行中的默认语义是 steer（omp 在工具结束后、下次 LLM 调用前注入），
 * 显式入口（↓+Enter / 菜单）才走 followUp 排队；空闲时两者都不传。
 * 只有「发送目标就是当前活跃且忙碌的 agent」才算运行中——后台 agent 的发送
 * 不应借用前台 agent 的忙碌态。
 */
export function resolveComposerSendRoute(params: {
	explicit?: "steer" | "followUp" | null;
	agentId: string;
	activeAgentId: string | null | undefined;
	busy: boolean;
}): ComposerSendRoute {
	if (params.explicit === "followUp") return "followUp";
	if (params.explicit === "steer") return "steer";
	return params.busy && params.agentId === params.activeAgentId ? "steer" : "send";
}

/** 路线 → 传给主进程的 streamingBehavior（send 不带字段）。 */
export function streamingBehaviorForRoute(route: ComposerSendRoute): StreamingBehavior {
	return route === "send" ? undefined : route;
}

/* ── 5. 队列行投影（omp 队列 + 本地未知投递提示） ──────────────────────── */

/** 本地「投递结果未知」提示：omp 可能已接收，不能重试也不能伪造撤回。 */
export type UncertainPrompt = {
	id: string;
	text: string;
	error: string;
};

/** 待发送区的一行：服务端队列 chip，或本地未知投递提示。 */
export type QueuePanelRow =
	| { kind: "queued"; key: string; queue: "steering" | "followUp"; text: string }
	| { kind: "uncertain"; key: string; id: string; text: string; error: string };

/**
 * 面板行 = omp 队列（steering 在前、followUp 在后，各自保序）+ 本地未知投递提示。
 * 队列文本允许重复（omp 也按首条匹配撤回），key 必须带下标避免碰撞。
 */
export function buildQueueRows(
	queued: AgentQueuedMessages | undefined,
	uncertain?: readonly UncertainPrompt[],
): QueuePanelRow[] {
	const rows: QueuePanelRow[] = [];
	const pushQueue = (
		queue: "steering" | "followUp",
		messages: string[] | undefined,
	) => {
		for (const [index, text] of (messages ?? []).entries()) {
			rows.push({ kind: "queued", key: `${queue}:${index}:${text}`, queue, text });
		}
	};
	pushQueue("steering", queued?.steering);
	pushQueue("followUp", queued?.followUp);
	for (const item of uncertain ?? []) {
		rows.push({
			kind: "uncertain",
			key: `uncertain:${item.id}`,
			id: item.id,
			text: item.text,
			error: item.error,
		});
	}
	return rows;
}

/* ── 6. 草稿文本编辑（统一的光标意图） ─────────────────────────────────── */

/**
 * 在光标处插入文本（@path 引用等），必要时补一个分隔空格：
 * 紧贴前一字符插入 `@src` 会与正文粘连，RichInput 的 chip 规则就认不出来了。
 * 返回新文本与新光标位置，调用方负责预览光标落点。
 */
export function insertTextAtCaret(
	text: string,
	cursor: number,
	insert: string,
): { text: string; cursor: number } {
	// 钳制：DOM 测量与受控 state 之间可能出现瞬态越界。
	const safeCursor = Math.max(0, Math.min(cursor, text.length));
	const prev = safeCursor > 0 ? text[safeCursor - 1] : "";
	const spacer = prev && prev !== " " && prev !== "\n" ? " " : "";
	const nextText = text.slice(0, safeCursor) + spacer + insert + text.slice(safeCursor);
	return { text: nextText, cursor: safeCursor + spacer.length + insert.length };
}

/**
 * 把恢复/撤回的草稿拼到现有草稿前面（文字在更前，用空行分隔）。
 * 任何一侧为空时只保留另一侧，避免留下多余空行。
 */
export function prependDraftText(current: string, incoming: string): string {
	return [incoming, current].filter((text) => text.trim()).join("\n\n");
}

/** 撤回的队列消息 → 草稿文本与图片（恢复/撤回共用同一投影）。 */
export function collectRestoredDraft(messages: readonly RestoredQueuedMessage[]): {
	text: string;
	images: NonNullable<RestoredQueuedMessage["images"]>;
} {
	return {
		text: messages
			.map((item) => item.text)
			.filter((text) => text.trim())
			.join("\n\n"),
		images: messages.flatMap((item) => item.images ?? []),
	};
}

/** 常见图片扩展名：粘贴/拖拽时决定「附件」还是「@路径引用」。 */
export function isImagePath(path: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
}

/* ── 7. 状态展示（bang/plan 归一） ────────────────────────────────────── */

export type ComposerStatusMode = "silent-shell" | "shell" | "plan" | null;

/**
 * 底栏状态语义：bang 优先于 plan（`!` 显式指定的执行方式必须压过模式开关），
 * 两者都没有时返回 null，由调用方决定展示文件/会话等弱提示。
 */
export function resolveComposerStatusMode(
	bang: ComposerBangMode,
	agentMode: ComposerAgentMode,
): ComposerStatusMode {
	if (bang === "bang-bang") return "silent-shell";
	if (bang === "bang") return "shell";
	return agentMode === "plan" ? "plan" : null;
}
