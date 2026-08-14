import type { WidgetLineItem } from "./message";

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
};

export type PiCommand = {
	name: string;
	description?: string;
	source?: string;
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
};

export type AvailableModel = {
	id: string;
	name?: string;
	provider: string;
	contextWindow?: number;
	reasoning?: boolean;
};

export type CreateAgentInput = {
	projectId: string;
	title?: string;
	sessionPath?: string;
	/** 瞬时会话：不保存 session 文件（对应 pi --no-session） */
	noSession?: boolean;
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
