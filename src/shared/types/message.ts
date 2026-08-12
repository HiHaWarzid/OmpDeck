export type ChatRole = "user" | "assistant" | "tool" | "system" | "error";

/** 图片内容格式，与 pi RPC 的 ImageContent 一致 */
export type ImageContent = {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // 如 "image/png", "image/jpeg", "image/gif", "image/webp"
};

export type ChatMessage = {
	id: string;
	agentId: string;
	role: ChatRole;
	text: string;
	timestamp: number;
	meta?: Record<string, unknown>;
	images?: ImageContent[]; // 用户消息中附加的图片
	/** 思考内容：来自 thinking 内容块，用于展示模型推理过程 */
	thinking?: string;
	/** 思考开始时间戳（首次 thinking_delta 到达时记录） */
	thinkingStartedAt?: number;
	/** 思考结束时间戳（thinking_end 到达时记录） */
	thinkingEndedAt?: number;
};

export type SendPromptInput = {
	agentId: string;
	message: string;
	images?: ImageContent[]; // 可选的图片列表
	streamingBehavior?: "steer" | "followUp";
	/** 仅发给 Agent 的内部提示，不显示在聊天 UI 中。 */
	agentMessage?: string;
	/** 提示的简短描述/摘要，发给 pi agent 用于标识本次 prompt 的意图。
	 *  从模板 description、用户输入首行自动提取；飞书/WebService 等外部来源可不传。 */
	description?: string;
};

/** 主进程完成 pi prompt 预检后的明确接收结果。 */
export type SendPromptResult =
	| { accepted: true }
	| { accepted: false; error: string; delivery?: "rejected" }
	| { accepted: false; error: string; delivery: "unknown" };

/** 实时思考内容更新，用于流式展示模型推理过程 */
export type ThinkingUpdate = {
	agentId: string;
	/** 累积的思考文本 */
	thinking: string;
};

/**
 * agents:message 增量推送负载。
 *
 * replaceFrom 语义：渲染层以 `current.slice(0, replaceFrom) + messages` 合并。
 * - replaceFrom === 0 且 messages 为全量 → 全量基线（历史加载/重启重建/首个事件）。
 * - replaceFrom > 0 → 增量：只传输 replaceFrom 之后的变更（含就地更新的消息与追加/删除）。
 * 流式期间每条 text_delta 只改最后一条 assistant 消息，50ms 冲刷时仅序列化该条，
 * 避免整条会话消息数组随 token 增长线性变大。
 */
export type AgentMessagesDelta = {
	agentId: string;
	replaceFrom: number;
	messages: ChatMessage[];
};

/** 输入框发送模式，决定消息直接执行还是以只读方式触发生成计划。 */
export type ComposerAgentMode = "normal" | "plan";

/**
 * TodoWrite 工具单项状态。与 pi RPC 的 TodoWrite 入参一致，
 * 由 AgentManager 从 tool_execution_end 事件派生并维护到 AgentRuntime.currentTodos。
 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** TodoWrite 工具的单项内容。 */
export type TodoItem = {
	content: string;
	status: TodoStatus;
	/** 进行时短语，模型在 in_progress 项上填写，用于折叠态摘要。 */
	activeForm?: string;
};

/**
 * setWidget 协议升级后的结构化行元素。
 * 兼容老协议：widgetLines 元素可以是 string（老扩展）或 WidgetLineItem（todo 等结构化扩展）。
 * 渲染层按 typeof 收窄。
 */
export type WidgetLineItem = {
	content: string;
	status: TodoStatus;
	activeForm?: string;
};
