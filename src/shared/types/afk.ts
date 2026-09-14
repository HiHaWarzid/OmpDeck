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
	 *
	 * 可选：仅因旧 afk-state.json 存档缺本字段而保留可选（多项目轮转之前的形状）。
	 * 运行时创建的任务一律写入；旧记录在 loadState 里尽力反推（worktree 子项目记录 /
	 * agent tab），推不出则标 unbound（见下）——不猜项目：猜错会把别的仓库的 worktree
	 * 当成本任务的工作树去删（ADR-0003 工作树永不裸删）。
	 */
	projectId?: string;
	/**
	 * 旧存档无法确定来源项目（缺 projectId 且反推不到）时置位。
	 * 语义 = 不可自动处理：没有项目就无从定位 worktree 所属仓库、无从判 agent 归属、无从回写
	 * issue，所以它不参与派发去重（归属未知的任务按 ticketRef 全局判定会把所有项目的同号工单
	 * 永久锁死），也不参与超时/崩溃恢复/终态收口——活跃态在启动加载时就收口为 failed 并写明原因。
	 * 记录完整保留在状态里供人查看：直接丢弃等于丢工作树与进度（ADR-0003）。
	 */
	unbound?: boolean;
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

/**
 * 任务是否绑定了来源项目（有 projectId 且未被标记 unbound）。
 * 类型谓词：判定后可安全使用 task.projectId（terminate 需要它）。
 * 用途：主进程的派发去重只对绑定任务生效（归属未知的旧任务不能变成全项目级永久锁），
 * 渲染层据此决定「终止」按钮是否可见（没有项目就发不出 terminate 的身份）。
 */
export function isProjectBound(task: AfkTask): task is AfkTask & { projectId: string } {
	return Boolean(task.projectId) && task.unbound !== true;
}

/** 任务身份：AFK 已支持多项目轮转，唯一性由 (projectId, ticketRef) 共同承担。 */
export type AfkTaskIdentity = Pick<AfkTask, "projectId" | "ticketRef">;

/** projectId 缺失（unbound 旧存档）时的键前缀：保证键仍可比较，且不会与真实项目 id 混淆。 */
const UNBOUND_PROJECT_KEY = "\u0000unbound";

/**
 * 任务身份键。ticketRef 只是「项目内的 issue 编号」——两个仓库各有 #42 时它并不唯一，
 * 一切查找/去重/面板行身份都必须带上 projectId（terminate、isClaimable、upsert 共用本函数，
 * 只有一处定义才不会各自漂移）。键只在边界处生成（IPC 调用、React key、行匹配），
 * 轮询热路径直接比字段，不造临时字符串。
 */
export function afkTaskKey(task: AfkTaskIdentity): string {
	return `${task.projectId ?? UNBOUND_PROJECT_KEY}#${task.ticketRef}`;
}

/**
 * 面板增量更新投影：按身份键覆盖/插入单任务（不整体替换，避免列表闪烁）。
 * 纯函数：组件只负责把结果塞进 state，行身份口径由此处单点决定、可直接单测。
 */
export function upsertAfkTask(state: AfkState, task: AfkTask): AfkState {
	const key = afkTaskKey(task);
	const exists = state.tasks.some((item) => afkTaskKey(item) === key);
	return {
		...state,
		tasks: exists
			? state.tasks.map((item) => (afkTaskKey(item) === key ? task : item))
			: [task, ...state.tasks],
	};
}

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
