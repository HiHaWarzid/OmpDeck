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
	/**
	 * 任务登记时间戳（claim 成功后立即登记；时间线「已创建」节点）。
	 * 可选：兼容旧 afk-state.json（缺省时渲染层回落 startedAt）。
	 */
	createdAt?: number;
	/** 认领时间戳（ticket 认领成功后记录；时间线起点） */
	claimedAt?: number;
	/** worktree 创建完成时间戳（时间线「worktree」节点） */
	worktreeAt?: number;
	/**
	 * 工单 Web 地址（https://github.com/{owner}/{repo}/issues/{n}）。
	 * Orchestrator 在 dispatch/恢复时从 git remote 反查仓库基址拼装（Project 无 remote 字段），
	 * 旧数据或 remote 缺失时回落从 prUrl 反推；面板不再用正则自行推导。
	 */
	ticketUrl?: string;
	/**
	 * 来源项目 id（B 方案多项目轮转：任务与项目绑定，后续 worktree 定位/push/PR/
	 * 崩溃恢复都从本字段解析项目，而非当前配置的目标项目）。
	 * 可选：兼容旧 afk-state.json（恢复时缺失 → 回落当前目标项目列表）。
	 */
	projectId?: string;
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
	/**
	 * 目标项目 id 列表（B 方案多项目轮转）：工单来自各项目 git remote（gh 自动推断仓库）。
	 * 轮询按列表顺序扫描，全局仍一次只派发一个任务（P0 串行）。
	 */
	targetProjectIds: string[];
	/** 轮询间隔 ms（gh issue list 扫描频率） */
	pollIntervalMs: number;
	/** 单 agent 任务预算 ms（默认 30min，超时 → failed） */
	timeoutMs: number;
};
