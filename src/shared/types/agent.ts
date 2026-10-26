import type { ImageContent, WidgetLineItem } from "./message";

export type AgentStatus = "starting" | "idle" | "running" | "error" | "closed";

export type AgentTab = {
	id: string;
	projectId: string;
	cwd: string;
	title: string;
	status: AgentStatus;
	sessionId?: string;
	sessionPath?: string;
	createdAt: number;
	/** 会话累计压缩次数，由主进程解析会话文件得到，用于前端展示"已压缩 N 次"。 */
	compactionCount?: number;
	/** 瞬时会话（--no-session），不保存记录，关闭即丢失 */
	noSession?: boolean;
	/** 最近一次失败原因（error 状态填充，AFK 详情与列表展示用；见 ADR-0005） */
	lastError?: string;
};

/** 斜线命令的子命令（omp `available_commands_update` 的 subcommands 投影）。 */
export type PiCommandSubcommand = {
	name: string;
	description?: string;
};

export type PiCommand = {
	name: string;
	description?: string;
	source?: string;
	/** 参数提示，如 `[on|off|status]`（omp 的 input.hint）；建议列表据此展示用法。 */
	inputHint?: string;
	subcommands?: PiCommandSubcommand[];
};

/**
 * omp 子代理（task 工具派生的子会话）在父会话里的实时投影。
 *
 * 事实源是 omp RPC 的 `subagent_lifecycle` / `subagent_progress` 帧：
 * progress 帧会带上 registry 的完整行（含 status/durationMs/model 等），
 * 而 lifecycle 帧只带身份与终态，所以字段全部可选、按帧合并。
 * 子代理 transcript 不进这里：卡片只展示进度摘要，正文按需从会话文件读取。
 */
export type AgentSubagent = {
	id: string;
	/** 子代理类型（omp agent 名，如 task / scout），不是 UI 角色。 */
	agent?: string;
	description?: string;
	/** omp registry 原始状态：started/running/completed/aborted/failed。 */
	status: string;
	index?: number;
	/** 子会话 JSONL 路径（宿主机路径），用于按需读取 transcript。 */
	sessionFile?: string;
	task?: string;
	assignment?: string;
	/** 子代理最近一次自述意图（progress.lastIntent），用于卡片副标题。 */
	lastIntent?: string;
	recentTools?: AgentSubagentTool[];
	toolCount?: number;
	tokens?: number;
	durationMs?: number;
	resolvedModel?: string;
};

export type AgentSubagentTool = {
	tool: string;
	args?: string;
	isError?: boolean;
};

export type AgentRuntimeState = {
	modelName?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	/** 是否正在执行工具调用（read/write/bash 等） */
	isExecutingTool?: boolean;
	/** 当前正在执行的工具名称，如 read、write、bash */
	executingToolName?: string;
	/** 工具状态事件的单调序号，用于忽略晚到的异步完整状态。 */
	toolStateSequence?: number;
	/** 完整运行态快照的单调序号：渲染层丢弃乱序到达的旧快照。 */
	runtimeStateSeq?: number;
	contextTokens?: number | null;
	contextWindow?: number | null;
	contextPercent?: number | null;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheTotal?: number;
	cacheHitPercent?: number | null;
	cost?: number;
	/**
	 * omp 服务端待投递队列（steering / followUp 的 chip 文本）。
	 * 渲染层必须以它作为队列唯一事实来源；本地只保留投递结果未知的提示。
	 */
	queuedMessages?: AgentQueuedMessages;
};

/** omp `get_state.queuedMessages` / `queue_update` 的投影。 */
export type AgentQueuedMessages = {
	steering: string[];
	followUp: string[];
};

/** `remove_queued_message` / `abort_and_restore_queue` 返回的草稿（含附件）。 */
export type RestoredQueuedMessage = {
	text: string;
	images?: ImageContent[];
};

export type RemoveQueuedMessageResult = {
	removed: boolean;
	/** 撤回消息携带的图片；文本消息、removed:false 时缺省。 */
	images?: ImageContent[];
	/** 图片超出传输上限被省略（消息仍已撤回）。 */
	imagesDropped?: boolean;
};

export type PromoteQueuedMessageResult = { promoted: boolean };

export type AbortAndRestoreQueueResult = {
	steering: RestoredQueuedMessage[];
	followUp: RestoredQueuedMessage[];
	imagesDropped?: boolean;
	truncated?: boolean;
};

export type AvailableModel = {
	id: string;
	name?: string;
	provider: string;
	contextWindow?: number;
	reasoning?: boolean;
	/** 是否支持图片输入（pi --list-models 的 images 列）。缺省 = 能力未知（目录未收录/未上报）。 */
	supportsImages?: boolean;
};

export type CreateAgentInput = {
	projectId: string;
	title?: string;
	sessionPath?: string;
	/** 瞬时会话：不保存 session 文件（对应 pi --no-session） */
	noSession?: boolean;
	/**
	 * 覆盖 agent 工作目录（默认 project.path）。AFK 编排器把 agent 派到
	 * 独立 worktree 时需要 cwd 指向 worktree；双穿 tab.cwd 与 PiProcess。
	 */
	cwd?: string;
};

export type ForkMessage = {
	entryId: string;
	text: string;
};

/** 批量问卷：扩展把 questions JSON 塞进 input title，桌面端解析后渲染 Tab 问卷。 */
export type AgentUiBatchQuestion = {
	id: string;
	type: "select" | "confirm" | "input" | "editor";
	question: string;
	options?: Array<string | { label: string; value?: string; description?: string }>;
	allowOther?: boolean;
	placeholder?: string;
	prefill?: string;
};

/**
 * omp 原生 ask 对话框选项：label 是回传给 pi 的精确值，description/preview 仅用于展示。
 * 与 batch_ask（扩展把 JSON 塞进 input title）不同，这套结构来自 pi 的 `method: "ask"` 协议。
 */
export type AgentUiAskOption = {
	label: string;
	description?: string;
	preview?: string;
};

/** omp 原生 ask 协议的单个问题（method 为 ask）。 */
export type AgentUiAskQuestion = {
	id: string;
	question: string;
	header?: string;
	options: AgentUiAskOption[];
	/** true 时允许勾选多个选项；false/省略为单选。 */
	multi?: boolean;
	/** 推荐选项下标；pi 超时会自动选择它。 */
	recommended?: number;
};

/** omp ask 的回答项，必须与请求中的 questions 顺序、id 一一对应。 */
export type AgentUiAskAnswer = {
	id: string;
	selectedOptions: string[];
	customInput?: string;
};

/**
 * Agent 扩展 UI 请求（ctx.ui.select/confirm/input/editor/notify/setWidget）。
 * 主进程 AgentManager 发出、preload 原样透传、渲染层渲染卡片——三侧共用同一类型，
 * 避免各自内联声明导致字段漂移（历史教训：batchQuestions/widgetLines 曾只存在于渲染层）。
 */
export type AgentUiRequest = {
	agentId: string;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
	/** 批量问卷：扩展 envelope 解析后的问题列表（method 为 batch_ask） */
	batchQuestions?: AgentUiBatchQuestion[];
	/** 批量是否强制 Submit 审阅 tab */
	batchReview?: boolean;
	/** omp 原生 ask（method === "ask"）的问题列表；与 batch_ask 的扩展 envelope 不同。 */
	askQuestions?: AgentUiAskQuestion[];
	/** pi 侧超时（毫秒）：超时后自动选择 recommended，桌面端仅用于提示。 */
	timeout?: number;
	completed?: boolean;
	value?: string;
	cancelled?: boolean;
	message?: string;
	notifyType?: "info" | "warning" | "error";
	text?: string;
	widgetKey?: string;
	/** widget 行元素：兼容老协议的 string 和新协议的 WidgetLineItem（结构化三态）。 */
	widgetLines?: Array<string | WidgetLineItem>;
	widgetPlacement?: "aboveEditor" | "belowEditor";
};
