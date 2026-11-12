import type {
	AgentRuntimeState,
	AgentStatus,
	AgentSubagent,
	AgentTab,
	AgentUiAskAnswer,
	AgentUiBatchQuestion,
	AgentUiRequest,
} from "../../shared/types/agent";
import type { ChatMessage } from "../../shared/types/message";
import type { PiCommand } from "../../shared/types";

/**
 * AgentManager 的语义出口（deep module 接缝）。
 *
 * 领域只回答「发生了什么」，不关心给谁：桌面主窗、手机端、AFK 编排器都是消费者。
 * 历史教训：AgentManager 曾直接持有 `webContents.send` + 11 个通道名，导致
 * 「事件有哪些语义」与「哪个窗口怎么序列化」绑死——测试必须伪造 BrowserWindow
 * 才能观察事件，新增消费者（手机端）只能另起一套快照轮询。
 *
 * 不变量：
 *   1. `publish` 永不抛错；单个消费者失败不影响其它消费者与领域逻辑。
 *   2. 领域侧不出现通道名；通道名只在 Electron 适配器里映射。
 *   3. 合并窗口（消息 50ms / 思考 50ms / 状态 50ms / 运行态 150ms）留在领域，
 *      语义事件是合并后的结果，不是每个 RPC delta。
 */

/** 工具运行态边沿：完整 get_state 到达前先让渲染层确定性看到 true → false。 */
export type AgentToolRuntimeEdge = Pick<
	AgentRuntimeState,
	"isExecutingTool" | "executingToolName" | "toolStateSequence"
>;

/**
 * 运行态推送：工具边沿只带三字段（不等待 RPC），完整快照带全部字段。
 * 渲染层按 `toolStateSequence` / `runtimeStateSeq` 丢弃乱序到达的旧值。
 */
export type AgentRuntimeStatePatch = AgentRuntimeState | AgentToolRuntimeEdge;

/**
 * Extension UI 帧：即可能是完整请求（select/ask/batch_ask），也可能只是收尾帧
 * （`completed` / `cancelled`，不重复携带 method/title）。渲染层历史上就按
 * 「先有完整请求、后到收尾帧」消费，这里把两种形状如实收进一个类型。
 */
export type AgentUiRequestFrame = Pick<AgentUiRequest, "agentId" | "requestId"> &
	Partial<Omit<AgentUiRequest, "value" | "batchQuestions">> & {
		/** extension_ui_response 原值：confirm 是布尔，select 取消是 null。 */
		value?: string | boolean | null;
		/** 扩展 envelope 解析后的问题（未归一化，原样透传给渲染层）。 */
		batchQuestions?: AgentUiBatchQuestion[] | Record<string, unknown>[];
		/** 原生 ask 的答案回显（仅收尾帧携带）。 */
		answers?: AgentUiAskAnswer[];
	};

/** 主进程 → 渲染层的轻量 toast 语义（不写入会话时间线）。 */
export type AgentNotice = {
	agentId: string;
	message: string;
	i18nKey: string;
	kind: "info" | "warning";
	/** 展示时长（毫秒）；由消费者决定是否使用。 */
	durationMs: number;
};

/**
 * 语义事件全集。
 *
 * `message-appended` 是 50ms 合并后的增量：`replaceFrom === 0` 表示全量基线，
 * 否则渲染层以 `slice(0, replaceFrom) + messages` 合并。AFK 等增量消费者从批里取
 * 最后一条即可（与旧 `messageAppended` 单条事件等价）。
 *
 * `settled` / `status-changed` 是进程内消费用的信号（完成/失败判定），
 * 不是 IPC 负载——桌面渲染层从 `tabs-changed` 已能拿到状态。
 */
export type AgentEvent =
	| { kind: "message-appended"; agentId: string; replaceFrom: number; messages: ChatMessage[] }
	| { kind: "thinking-delta"; agentId: string; thinking: string }
	| { kind: "runtime-changed"; agentId: string; state: AgentRuntimeStatePatch }
	| { kind: "tabs-changed"; tabs: AgentTab[] }
	| { kind: "ui-request"; request: AgentUiRequestFrame }
	| { kind: "trust-request"; requestId: string; cwd: string; projectName: string }
	| { kind: "notice"; notice: AgentNotice }
	| { kind: "log"; agentId: string; text: string }
	| { kind: "subagents-changed"; agentId: string; subagents: AgentSubagent[] }
	| { kind: "command-catalog"; agentId: string; commands: PiCommand[] }
	| { kind: "settled"; agentId: string }
	| { kind: "status-changed"; agentId: string; status: AgentStatus; tab: AgentTab };

/** 新消费者的完整起点：整表 + 每个 agent 的当前运行态、子代理与在途思考。 */
export type AgentSnapshot = {
	tabs: AgentTab[];
	agents: Record<
		string,
		{
			runtime: AgentRuntimeState;
			subagents: AgentSubagent[];
			/** 本轮流式思考的累积文本；思考已结束则为空串。 */
			thinking: string;
		}
	>;
};

export type AgentEventSubscriptionOptions = {
	/**
	 * 该消费者能对交互请求（项目信任确认 / 扩展 UI）当场作答。
	 * 只有这类消费者参与 `hasUiResponders()`；宠物窗、AFK 之类只读消费者不参与，
	 * 否则「主窗已关，只剩宠物/编排器」时信任询问会白等到超时。
	 */
	answersUi?: boolean;
};

export interface AgentEventSink {
	/** 领域 → 出口。永不抛错，消费者异常被隔离。 */
	publish(event: AgentEvent): void;
	/** 订阅语义事件；返回可重复调用的退订函数。 */
	onEvent(listener: (event: AgentEvent) => void, options?: AgentEventSubscriptionOptions): () => void;
	/** 当前完整状态（重新连接的消费者用于对齐基线）。 */
	snapshot(): Promise<AgentSnapshot>;
	/**
	 * 是否有能回应交互请求的消费者在线。
	 * 用途：需要用户当场决策的请求（项目信任确认）在无人作答时直接走安全默认，
	 * 而不是白等超时。消费者必须随窗口/连接生命周期订阅与退订，否则此值会失真。
	 */
	hasUiResponders(): boolean;
}

export type AgentEventSinkOptions = {
	snapshot: () => Promise<AgentSnapshot>;
	/** 消费者抛出的异常（用于记日志；不得反向影响 publish 的调用方）。 */
	onListenerError?: (error: unknown, event: AgentEvent) => void;
};

export function createAgentEventSink(options: AgentEventSinkOptions): AgentEventSink {
	const listeners = new Set<(event: AgentEvent) => void>();
	const uiResponders = new Set<(event: AgentEvent) => void>();
	return {
		publish(event) {
			// 复制一份再遍历：消费者可能在回调里退订（窗口关闭），直接遍历 Set 会漏发。
			for (const listener of [...listeners]) {
				try {
					listener(event);
				} catch (error) {
					try {
						options.onListenerError?.(error, event);
					} catch {
						// 日志消费者自身失败也不能打断事件分发。
					}
				}
			}
		},
		onEvent(listener, subscription) {
			listeners.add(listener);
			if (subscription?.answersUi) uiResponders.add(listener);
			return () => {
				listeners.delete(listener);
				uiResponders.delete(listener);
			};
		},
		snapshot: () => options.snapshot(),
		hasUiResponders: () => uiResponders.size > 0,
	};
}

/**
 * 无人订阅的出口：测试与 headless 场景（没有窗口可推）用它保持构造契约一致。
 * 语义事件照常产生，只是没有消费者——与「窗口还没打开就先启动 agent」同构。
 */
export function createNullAgentEventSink(): AgentEventSink {
	return createAgentEventSink({ snapshot: async () => ({ tabs: [], agents: {} }) });
}
