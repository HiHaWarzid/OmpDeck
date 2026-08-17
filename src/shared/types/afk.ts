/**
 * AFK（挂机编排）领域类型。
 * 术语见 CONTEXT.md：Ticket（GitHub Issue）→ AfkTask（运行时记录）→ Complete ≠ Success。
 */

/** AFK 任务状态：queued（排队）→ running（agent 工作）→ complete/failed 终态；pr-pending/needs-review 为 complete 后的人审阶段。 */
export type AfkTaskStatus =
	| "queued"
	| "running"
	| "complete"
	| "failed"
	| "pr-pending"
	| "needs-review";

/** AFK 任务运行时记录（持久化于 userData/afk-state.json，见 CONTEXT.md AfkTask）。 */
export type AfkTask = {
	/** GitHub Issue 编号（ticketRef = issue number） */
	ticketRef: number;
	/** Issue title（作为 brief goal 原样派发） */
	title: string;
	/** worktree 绝对路径（创建后填充） */
	worktreePath?: string;
	/** afk-{ticketId}-{slug} 分支名 */
	branch?: string;
	/** spawned agent 的 tab id */
	agentId?: string;
	status: AfkTaskStatus;
	/** running 开始时间戳（超时预算起点） */
	startedAt?: number;
	/** 终态时间戳 */
	endedAt?: number;
	/** PR URL（complete 后 gh pr create 填充） */
	prUrl?: string;
	/** failed 原因摘要（agent error / 超时 / RPC 失败 / orchestrator 异常） */
	errorSummary?: string;
};

/** afk-state.json 持久化形状：运行态 + 历史归档（30 天滚动清理）。 */
export type AfkState = {
	tasks: AfkTask[];
	/** 启用开关持久化：应用启动自动恢复轮询 */
	enabled: boolean;
	lastPollAt?: number;
};

/** AppSettings 中的 AFK 配置（设置页 afk tab 编辑）。 */
export type AfkSettings = {
	enabled: boolean;
	/** 目标项目 id（工单来自该项目 git remote） */
	targetProjectId?: string;
	/** 轮询间隔 ms（gh issue list 扫描频率） */
	pollIntervalMs: number;
	/** 单 agent 任务预算 ms（默认 30min，超时 → failed） */
	timeoutMs: number;
};
