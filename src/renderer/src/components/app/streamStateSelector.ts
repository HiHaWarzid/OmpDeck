/**
 * 流式/运行中的时间线展示状态：单一 selector 模块。
 *
 * App 侧把全部输入状态聚合成 buildStreamState 的对象（useMemo 缓存引用），
 * MessageListContent 的 memo 比较器按内容比较（areStreamStatesEqual）。
 * 聚合与比较器同处一模块，字段形状、依赖清单与比较逻辑不再跨文件漂移——
 * 新增字段时必须同步更新本模块的三处（Input 类型 / 聚合函数 / 比较器），
 * 避免 App 侧 useMemo 遗漏依赖时字段变化无法触发重渲染。
 */

/** 流式/运行中的时间线展示状态。 */
export type MessageStreamState = {
	/** 正在流式追加的最后一条 assistant 消息 id（见 App.streamingMessageId） */
	streamingMessageId?: string;
	/** Agent 处理中（含多步工具调用之间的短暂间隙，驱动 TurnRow 折叠行为） */
	agentRunning: boolean;
	/** 精确的 activeAgent.status === "running"，驱动响应指示器（与 agentRunning 语义不同） */
	statusRunning: boolean;
	/** 等待首条 assistant 消息时的占位/指示器显示条件 */
	isAwaitingAssistant: boolean;
	showThinking: boolean;
	activeThinking?: string;
	/** 流式思考的开始时间（App 侧 streamingThinkingStartedAt[agentId]，首次 thinking 到达时记录）；
	 *  消息落库后以 message.thinkingStartedAt 为准（见 TurnRow 双来源优先级） */
	thinkingStartedAt?: number;
	isExecutingTool?: boolean;
	isStreaming?: boolean;
	/** 正在取消 ask 响应（发送 cancelled 期间），隐藏响应指示器 */
	cancellingUi: boolean;
	/** 正在用 composer 内联栏回答同一 request 时隐藏时间线 pending 卡 */
	activeUiAskRequestId?: string;
};

/** buildStreamState 的输入：与 MessageStreamState 形状一一对应。 */
export type StreamStateInput = MessageStreamState;

/** 聚合流式/运行展示状态：App 侧用 useMemo 调用，保证只有任一输入真正变化时才重建引用。 */
export function buildStreamState(input: StreamStateInput): MessageStreamState {
	return { ...input };
}

/** MessageStreamState 的内容相等比较：字段全是原始值，逐项 Object.is 比较即可。
 *  相比引用比较更保守——即使 App 侧 useMemo 依赖漏列某个输入，
 *  这里仍能捕获其变化触发重渲染（代价与原先 10 个标量 prop 的逐一比较一致）。 */
export function areStreamStatesEqual(
	previous: MessageStreamState,
	next: MessageStreamState,
): boolean {
	return (
		previous.streamingMessageId === next.streamingMessageId &&
		previous.agentRunning === next.agentRunning &&
		previous.statusRunning === next.statusRunning &&
		previous.isAwaitingAssistant === next.isAwaitingAssistant &&
		previous.showThinking === next.showThinking &&
		previous.activeThinking === next.activeThinking &&
		previous.thinkingStartedAt === next.thinkingStartedAt &&
		previous.isExecutingTool === next.isExecutingTool &&
		previous.isStreaming === next.isStreaming &&
		previous.cancellingUi === next.cancellingUi &&
		previous.activeUiAskRequestId === next.activeUiAskRequestId
	);
}