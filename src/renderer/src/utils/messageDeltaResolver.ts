import type { AgentMessagesDelta, ChatMessage } from "../../../shared/types";

/** 历史条数上限：与 App 的 PROMPT_HISTORY_LIMIT 保持一致（发送保存/基线重建/会话文件补全统一使用）。 */
const PROMPT_HISTORY_LIMIT = 100;

/**
 * prompt 历史重建所需的上下文。原实现（App.rebuildPromptHistory）从组件闭包读取
 * inited 标记、已有历史与上限；这里全部显式参数化，使重建逻辑可脱离 React 与
 * localStorage 测试。
 *
 * 数据来源：messages 来自主进程推送的全量基线（main-sourced）；
 * inited / existingHistory 是渲染层本地派生状态（localStorage / 发送记录，
 * renderer-derived）。
 */
export type PromptHistoryContext = {
	/** 该历史键是否已初始化（对应 App 的 promptHistoryInitedRef）。true 时跳过重建。 */
	inited?: boolean;
	/** 该键已有历史记录（最新在前），缺省视为无。 */
	existingHistory?: string[];
	/** 历史条数上限，默认 100。 */
	limit?: number;
};

export type ResolveDeltaOptions = PromptHistoryContext & {
	/** 该 agent 当前的代数序号（对应 App 的 messageDeltaSeqRef[agentId]），默认 0。 */
	currentSeq?: number;
};

export type ResolveMessagesDeltaResult = {
	/** 合并后的消息数组：全量基线整体替换；增量截断尾部后拼接。 */
	messages: ChatMessage[];
	/**
	 * 本次应用产生的代数序号（= 传入 currentSeq + 1）。调用方保存该值，并在异步
	 * 全量拉取完成时与当前代数比较——不一致说明期间有新 delta 到达，拉取结果是旧
	 * 基线，必须丢弃（对应 App 的 messageDeltaSeqRef 守卫，见 resolveFullPullResult）。
	 */
	seq: number;
	/**
	 * replaceFrom 超出本地消息长度（增量失同步：如渲染层重载后 agent 仍在流式，
	 * 期间只有尾部增量、缺会话头）→ 调用方应异步拉取全量基线自愈。
	 * 拉取结果落地前，本次合并结果已先行应用到 UI，聊天区不空白。
	 */
	needsFullPull: boolean;
	/**
	 * 全量基线（replaceFrom === 0）且可重建时的用户历史 prompt（最新在前、去重、
	 * 限长）；null 表示跳过重建。跳过原因：非全量基线（增量事件只含尾部消息，
	 * 用它重建会得到不完整历史）、该键已初始化、或基线不含有效用户消息（占位/
	 * 空基线——此时故意不置初始化标记，避免稍后到达的真实历史基线被幂等保护挡住）。
	 */
	promptHistory: string[] | null;
};

/**
 * 合并两份“最新在前、各自去重”的历史列表：incoming 是权威较新来源放前面，
 * existing（持久化/发送记录）补充更早的条目；按文本去重（与 App 发送路径一致），
 * 空白条目丢弃，结果限长。
 */
function mergePromptHistory(
	existing: string[] | undefined,
	incoming: string[],
	limit: number,
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
 * 与 App.rebuildPromptHistory 的用户消息提取一致：只取 user 角色、非空文本、
 * 不以 "!" 开头的消息（bash 快捷命令与 sendPrompt 保存路径保持一致，不进历史）。
 */
function collectUserPrompts(messages: ChatMessage[]): string[] {
	return messages
		.filter(
			(m) => m.role === "user" && m.text?.trim() && !m.text.trim().startsWith("!"),
		)
		.map((m) => m.text.trim());
}

/** 在全量基线上重建 prompt 历史：已初始化或无有效用户消息时返回 null（幂等/占位跳过）。 */
function computePromptHistory(
	messages: ChatMessage[],
	context: PromptHistoryContext | undefined,
): string[] | null {
	if (context?.inited) return null;
	const userPrompts = collectUserPrompts(messages);
	if (userPrompts.length === 0) return null;
	// 消息按时间正序，历史记录需要“最新在前”→ 反转；新记录放前面合并。
	return mergePromptHistory(
		context?.existingHistory,
		userPrompts.reverse(),
		context?.limit ?? PROMPT_HISTORY_LIMIT,
	);
}

/**
 * 解析一次 agents:message 增量推送。主进程语义（AgentMessagesDelta 文档）：
 * replaceFrom === 0 且 messages 为全量 → 全量基线（历史加载/重启重建/首个事件），
 * 整体替换；replaceFrom > 0 → 增量，只传输 replaceFrom 之后的变更（含就地更新的
 * 消息与追加/删除），渲染层以 `slice(0, replaceFrom) + messages` 合并。
 *
 * 从 App.onMessages 处理器原样迁出（见 src/renderer/src/App.tsx onMessages）：
 * 合并、失同步自愈标记、全量基线 prompt 历史重建耦合一并收敛于此。
 * 注意：delta 按到达顺序应用、本身不做丢弃（事件流天然有序）；“陈旧丢弃”只发生在
 * 异步全量拉取结果上（代数序号守卫，见 resolveFullPullResult）。
 */
export function resolveIncomingMessagesDelta(
	prev: ChatMessage[] | undefined,
	delta: AgentMessagesDelta,
	options?: ResolveDeltaOptions,
): ResolveMessagesDeltaResult {
	const prevMessages = prev ?? [];
	// 增量失同步（渲染层重载后 agent 仍在流式，期间只有尾部增量、缺会话头）：
	// replaceFrom 引用本地不存在的下标 → 标记调用方异步拉全量基线补平。
	const needsFullPull = delta.replaceFrom > prevMessages.length;
	// replaceFrom === 0 即全量基线（历史加载/重启重建），整体替换；
	// 否则只替换 replaceFrom 之后的尾部，replaceFrom 之前保持原数组引用以利 diff；
	// 越界位置按 Math.min 钳制到本地长度——此时 needsFullPull 已另行触发自愈，
	// 本合并结果仅作过渡显示。
	const merged =
		delta.replaceFrom === 0
			? delta.messages
			: [
					...prevMessages.slice(0, Math.min(delta.replaceFrom, prevMessages.length)),
					...delta.messages,
				];
	// prompt 历史只在全量基线上重建——增量事件可能只含尾部消息，用它重建会得到不完整历史。
	const promptHistory =
		delta.replaceFrom === 0 ? computePromptHistory(delta.messages, options) : null;

	return { messages: merged, seq: (options?.currentSeq ?? 0) + 1, needsFullPull, promptHistory };
}

export type ResolveFullPullResult = {
	/** 全量基线消息，调用方直接整体替换缓存。 */
	messages: ChatMessage[];
	/** 与 resolveIncomingMessagesDelta 同语义的 prompt 历史重建结果。 */
	promptHistory: string[] | null;
} | null;

/**
 * 应用一次异步全量拉取结果（对应 App.onMessages 内 getMessages().then 回调）。
 * 拉取期间若有新 delta 到达（当前代数 != 捕获代数），该结果是旧基线，直接返回
 * null 丢弃，避免旧基线覆盖新消息（App 的 messageDeltaSeqRef 守卫的纯函数形态）。
 * 非陈旧时整体替换消息，并在全量基线上重建 prompt 历史（自愈路径与 replaceFrom=0
 * 基线一样调用 rebuildPromptHistory）。
 */
export function resolveFullPullResult(
	capturedSeq: number,
	currentSeq: number,
	full: ChatMessage[],
	context?: PromptHistoryContext,
): ResolveFullPullResult {
	if (currentSeq !== capturedSeq) return null;
	return {
		messages: full,
		promptHistory: computePromptHistory(full, context),
	};
}