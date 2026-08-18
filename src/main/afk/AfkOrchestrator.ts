/**
 * AFK 编排器（ADR-0001 Orchestrator 模式）：选 ticket → 建 worktree/分支 → spawn agent
 * → 监听 settled/error → 标终态 → 推分支/开 PR → 回写 issue label。
 * 领域规则见 CONTEXT.md 与 docs/adr/0001-0006；AgentManager 仅作"被调用的 spawn 工具"，
 * 不侵入其多 tab 状态机。判定基于 AgentManager 语义事件（settled/statusChanged），
 * 不做 addStateListener 全量快照轮询（#2 杠杆点）。
 *
 * 关键业务规则（实现时逐条落实）：
 * - Selection：一次一个串行；gh issue list → 过滤已 assign 给别人/已有活跃 AfkTask → claim @me
 * - Worktree WIP 保留（ADR-0003）：删 worktree 前必须 [afk-wip] 快照（removeWithWip 内置）
 * - Timeout（30min 可配）：超时 → failed，WIP 快照提交但 worktree 保留，供重跑复用
 * - Failed（ADR-0005）：comment 附原因 + 重标 needs-info，不自动重试
 * - PR 卫生（ADR-0006）：开 PR 前过滤 [afk-wip] 提交；无真实提交不开 PR
 * - 崩溃恢复：重启读 afk-state.json；agent 存活 → needs-review 等人，死亡 → 强清留 WIP → failed
 */
import { app, type BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { AfkState, AfkTask, AfkTaskStatus, AppSettings, Project } from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import { AFK_WIP_PREFIX, type WorktreeService } from "../git/WorktreeService";
import { runGit } from "../utils/CommandRunner";
import { GhTicketSource, type AfkTicket, type TicketSource } from "./ticketSources";

/** 历史归档保留 30 天（handoff：afk-state.json 滚动清理） */
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type AfkOrchestratorDeps = {
	agentManager: AgentManager;
	worktreeService: WorktreeService;
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	getMainWindow: () => BrowserWindow | null;
	/** 工单源（gh CLI 实现）；测试注入 FakeTicketSource 驱动状态机（ADR-0001 可测试性） */
	ticketSource?: TicketSource;
};

/** 状态为活跃（不可再派发同 ticket）的任务状态集合 */
const ACTIVE_STATUSES: ReadonlySet<AfkTaskStatus> = new Set(["queued", "running", "needs-review", "pr-pending"]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class AfkOrchestrator {
	private readonly agentManager: AgentManager;
	private readonly worktreeService: WorktreeService;
	private readonly projectStore: ProjectStore;
	private readonly settingsStore: SettingsStore;
	private readonly getMainWindow: () => BrowserWindow | null;
	private readonly ticketSource: TicketSource;
	/** 持久化文件 userData/afk-state.json（同 SettingsStore 的 userData 获取方式） */
	private readonly stateFilePath = join(app.getPath("userData"), "afk-state.json");

	/** 内存运行态：tasks + enabled + lastPollAt（与 AfkState 持久化形状一致） */
	private state: AfkState = { tasks: [], enabled: false };
	private pollTimer: NodeJS.Timeout | null = null;
	/** poll 防重入锁：并发 ≤1，避免轮询周期短于 gh list 耗时导致重叠扫描 */
	private polling = false;
	/** 构造即启动的恢复初始化；start/stop/poll 先等它完成，避免与用户操作竞争 */
	private readonly initPromise: Promise<void>;

	constructor(deps: AfkOrchestratorDeps) {
		this.agentManager = deps.agentManager;
		this.worktreeService = deps.worktreeService;
		this.projectStore = deps.projectStore;
		this.settingsStore = deps.settingsStore;
		this.getMainWindow = deps.getMainWindow;
		// 缺省 gh 实现：main/index.ts 的构造入参不变（新增字段可选）
		this.ticketSource = deps.ticketSource ?? GhTicketSource;

		// 语义事件订阅（#2 杠杆点）：settled = agent 停止工作的权威完成信号；
		// statusChanged === "error" = 失败信号。不轮询 addStateListener 快照。
		this.agentManager.onAgentEvent((event) => {
			if (event.type === "settled") {
				void this.handleSettled(event.agentId);
			} else if (event.type === "statusChanged") {
				this.handleStatusChanged(event);
			}
		});

		this.initPromise = this.init();
	}

	// ── 对外 IPC 面 ──

	/** 快照（afk:status）：返回副本，renderer 读取后不能反向改主进程内存态。 */
	getState(): AfkState {
		return { ...this.state, tasks: [...this.state.tasks] };
	}

	/**
	 * 启用/恢复轮询：持久化 enabled 到 AppSettings.afk，立即扫一次 + 定时轮询。
	 * 不再暴露为 IPC（afk:start 已删）：启动自动恢复（index.ts）与测试直接调用；
	 * 运行期启停统一走 applySettings（settings-save 热更新）。
	 */
	async start(): Promise<void> {
		await this.initPromise;
		// 设置形状已由 SettingsStore 归一化（迁移/校验/默认补齐），直接读权威值
		const afk = this.settingsStore.get().afk;
		// 启用开关持久化：设置页与中心页共用 AppSettings.afk.enabled 同一事实源
		if (!afk.enabled) {
			await this.settingsStore.update({ afk: { ...afk, enabled: true } });
		}
		this.state.enabled = true;
		await this.saveState();
		this.schedulePolling();
		void this.poll(); // 启动立即扫一次，不等第一个 interval
	}

	/** 停用：停止轮询与新任务派发；已在跑的任务保持到终态（事件路径仍收口）。 */
	async stop(): Promise<void> {
		await this.initPromise;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.state.enabled = false;
		const afk = this.settingsStore.get().afk;
		if (afk.enabled) {
			await this.settingsStore.update({ afk: { ...afk, enabled: false } });
		}
		await this.saveState();
	}

	/**
	 * 设置热更新（settings-save 路径调用，见 appHandlers settings.update 的 afk 分支）：
	 * - enabled 置位 → 按最新 pollIntervalMs 重排定时器并立即扫一轮
	 * - enabled 清除 → 停表（已在跑任务保持运行，事件路径照常收口）
	 * - targetProjectIds 变更 → 下一轮 poll 生效（targetProjects 每轮读设置）
	 * 与 start()/stop() 的差别：设置已由调用方落库，这里不写盘、不重复持久化。
	 */
	async applySettings(settings: Pick<AppSettings, "afk">): Promise<void> {
		await this.initPromise;
		const afk = settings.afk;
		this.state.enabled = afk.enabled;
		if (afk.enabled) {
			this.schedulePolling(afk.pollIntervalMs);
			void this.poll();
		} else if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		await this.saveState();
	}

	/**
	 * 终止单任务（afk:terminate，面板「终止」按钮，取代裸 agents.stop）：
	 * 停止 agent → failed 收口（ADR-0005 needs-info 回写）+ WIP 快照提交、worktree 保留
	 * （ADR-0003，等同超时路径：人工终止不丢工作成果，供重跑复用）。
	 * 幂等：非 queued/running 任务直接返回（settled/error 路径可能已抢先收口）。
	 */
	async terminate(taskId: number): Promise<void> {
		await this.initPromise;
		const task = this.state.tasks.find((item) => item.ticketRef === taskId);
		if (!task || (task.status !== "queued" && task.status !== "running")) return;
		await this.failTask(task, "用户终止：手动停止了 AFK 任务", { keepWorktree: true });
	}

	// ── 初始化 / 崩溃恢复 / 持久化 ──

	/**
	 * 启动初始化：加载 afk-state.json → 30 天归档滚动清理 → 崩溃恢复（CONTEXT.md Crash Recovery）：
	 * - running/queued 且 agent 存活（agentManager.list() 能查到）→ 标 needs-review 等人，不判死
	 * - running/queued 且 agent 不存在 → 强清 worktree（removeWithWip 留 WIP per ADR-0003）→ failed
	 * - 终态任务直接进入归档（30 天滚动清理）
	 * 最后按持久化的 enabled 恢复轮询（启动自动恢复）。
	 */
	private async init(): Promise<void> {
		await this.loadState();
		this.rollArchive();
		await this.recoverInterruptedTasks();
		this.state.enabled = this.settingsStore.get().afk.enabled;
		await this.saveState();
		if (this.state.enabled) {
			this.schedulePolling();
			void this.poll();
		}
	}

	private async loadState(): Promise<void> {
		try {
			const raw = await readFile(this.stateFilePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<AfkState>;
			this.state = {
				tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
				enabled: parsed.enabled === true,
				lastPollAt: typeof parsed.lastPollAt === "number" ? parsed.lastPollAt : undefined,
			};
		} catch {
			// 文件缺失/损坏：全新状态；损坏文件不阻断启动
			this.state = { tasks: [], enabled: false };
		}
	}

	private async saveState(): Promise<void> {
		try {
			await mkdir(dirname(this.stateFilePath), { recursive: true });
			await writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), "utf8");
		} catch (error) {
			// 持久化失败不阻断主流程（内存态仍有效），仅留痕
			console.error("[AFK] 状态持久化失败:", errorMessage(error));
		}
	}

	/** 30 天归档滚动清理：终态且超期任务移除；活跃任务（无 endedAt）保留。 */
	private rollArchive(): void {
		const cutoff = Date.now() - ARCHIVE_RETENTION_MS;
		this.state.tasks = this.state.tasks.filter((task) => !task.endedAt || task.endedAt >= cutoff);
	}

	private async recoverInterruptedTasks(): Promise<void> {
		for (const task of this.state.tasks) {
			if (task.status !== "running" && task.status !== "queued") continue;
			const alive = task.agentId
				? this.agentManager.list().some((tab) => tab.id === task.agentId)
				: false;
			const project = this.resolveProject(task);
			if (alive) {
				// agent 进程存活（如 orchestrator 重载而 agentManager 未重启）：标 needs-review 等人，
				// 不判死、不动 worktree——agent 仍在工作，终态由后续事件路径（settled/error）收口
				task.status = "needs-review";
				task.ticketUrl = await this.computeTicketUrl(task, project);
				this.pushStatusChanged(task);
				continue;
			}
			// agent 不存在（应用重启）或 queued 未派发：强清 worktree 留 WIP，issue 回写 needs-info
			task.errorSummary = "崩溃恢复：应用重启时任务未完成";
			// 项目按任务绑定解析（多项目下每个任务可属不同项目，不能用单一当前目标项目）
			if (project && task.worktreePath) {
				await this.worktreeService
					.removeWithWip(task.worktreePath, project.path, task.ticketRef)
					.catch(() => undefined);
				await this.removeChildProjectRecord(task.worktreePath, project.id);
			}
			if (project) {
				try {
					await this.ticketSource.failIssue(project.path, task.ticketRef, task.errorSummary);
				} catch (error) {
					console.error("[AFK] 崩溃恢复回写 issue 失败:", errorMessage(error));
				}
			}
			task.status = "failed";
			task.endedAt = Date.now();
			task.ticketUrl = await this.computeTicketUrl(task, project);
			this.pushStatusChanged(task);
		}
	}

	// ── 主循环：poll → selection → claim → dispatch ──

	/**
	 * 单轮轮询：并发 ≤1（polling 锁）。先查超时（poll 时检查，不挂 per-task 定时器，简单不泄漏），
	 * 已有活跃任务则跳过 selection（P0 单项目串行）；否则扫描 ready-for-agent 并派发第一个可认领的。
	 */
	private async poll(): Promise<void> {
		if (this.polling) return;
		if (!this.state.enabled) return;
		this.polling = true;
		try {
			this.state.lastPollAt = Date.now();
			await this.checkTimeouts();
			if (this.hasActiveTask()) return;
			// B 方案多项目轮转：按设置顺序扫描各项目，认领第一个可认领的 ticket；
			// 全局仍一次只派一个任务（hasActiveTask 串行锁在轮询入口，跨项目共享）。
			const projects = this.targetProjects();
			if (projects.length === 0) return;
			for (const project of projects) {
				const tickets = await this.ticketSource.listReadyForAgent(project.path);
				// 认领基准 = gh 认证账户 @me（AFK Identity）；gh api user 失败时保守跳过所有已认领 ticket
				const me = await this.ticketSource.getCurrentUser(project.path).catch(() => null);
				for (const ticket of tickets) {
					if (!this.isClaimable(ticket, me)) continue;
					try {
						await this.ticketSource.claim(project.path, ticket.number);
					} catch (error) {
						// 认领失败（网络/权限/未认证）：本轮跳过该 ticket，不派发
						console.warn("[AFK] 认领 ticket 失败:", ticket.number, errorMessage(error));
						continue;
					}
					// 认领时间戳：任务时间线起点（dispatch 内同时登记 createdAt/startedAt）
					await this.dispatch(ticket, project, Date.now());
					return; // 派发完成即结束本轮（串行：一次只派一个）
				}
			}
		} catch (error) {
			// 轮询异常（gh 未装/未认证/网络）：不崩溃，保留 lastPollAt，下轮重试
			console.error("[AFK] poll 失败:", errorMessage(error));
		} finally {
			this.polling = false;
			void this.saveState();
		}
	}

	/**
	 * Selection 过滤：跳过已 assign 给别人（me 未知时保守跳过一切已认领 ticket），
	 * 跳过已有活跃 AfkTask（queued/running/needs-review/pr-pending）的 ticket，防同 ticket 双跑。
	 */
	private isClaimable(ticket: AfkTicket, me: string | null): boolean {
		if (ticket.assignees.length > 0) {
			if (me === null) return false;
			if (ticket.assignees.some((login) => login !== me)) return false;
		}
		return !this.state.tasks.some(
			(t) => t.ticketRef === ticket.number && ACTIVE_STATUSES.has(t.status),
		);
	}

	/**
	 * 派发：建 worktree/分支（碰撞复用继续）→ 显式登记子项目记录（绕 IPC，防孤儿记录泄漏）
	 * → spawn agent（cwd 指向 worktree，瞬时会话）→ sendPrompt（brief 原样）。
	 * 链路任一步失败 → 统一 failed（failTask 内 best-effort 回写 needs-info）。
	 */
	private async dispatch(ticket: AfkTicket, project: Project, claimedAt: number): Promise<void> {
		const task: AfkTask = {
			ticketRef: ticket.number,
			title: ticket.title,
			projectId: project.id,
			status: "running",
			createdAt: claimedAt,
			claimedAt,
			startedAt: claimedAt,
		};
		this.state.tasks.push(task);
		// 工单地址：git remote 反查仓库基址拼装（Project 无 remote 字段）。网络失败或
		// 缺 remote → undefined（面板「打开工单」禁用，与旧 prUrl 反推不可用时的行为一致）。
		task.ticketUrl = await this.computeTicketUrl(task, project);
		this.pushStatusChanged(task);
		try {
			// ADR-0003：保证 [afk-wip] commit 可提交——目标项目缺 git author 时写 repo local config
			await this.worktreeService.ensureGitAuthor(project.path);
			const created = await this.worktreeService.createAfk(project.path, ticket.number, ticket.title);
			task.worktreePath = created.path;
			task.branch = created.branch;
			task.worktreeAt = Date.now();
			// 显式 projectStore.add 登记子项目；复用同路径时 add 幂等（path 查重更新）
			await this.projectStore.add(created.path, project.id);
			const tab = await this.agentManager.create({
				projectId: project.id,
				title: `AFK: #${ticket.number}`,
				noSession: true,
				cwd: created.path,
			});
			task.agentId = tab.id;
			const body = await this.ticketSource.getIssueBody(project.path, ticket.number);
			const result = await this.agentManager.sendPrompt({
				agentId: tab.id,
				message: this.buildBrief(ticket, body),
				description: `AFK #${ticket.number}: ${ticket.title}`,
			});
			if (!result.accepted) {
				// RPC 预检失败 → failed（ADR-0005 Failed 条件枚举），错误摘要来自预检返回
				await this.failTask(task, `RPC 预检失败：${result.error}`, { keepWorktree: false });
				return;
			}
			this.pushStatusChanged(task);
		} catch (error) {
			// 派发链异常（worktree/agent 创建失败等）：failed + needs-info，不自动重试
			await this.failTask(task, `派发失败：${errorMessage(error)}`, { keepWorktree: false });
		}
		void this.saveState();
	}

	/** Brief 原样派发（CONTEXT.md）：title 作 goal、body 作 brief 原文、workflow:* 标签作工作流提示。 */
	private buildBrief(ticket: AfkTicket, body: string): string {
		const parts = [`# Goal\n${ticket.title}`, `# Brief\n${body}`];
		const workflowHints = ticket.labels.filter((label) => label.startsWith("workflow:"));
		if (workflowHints.length > 0) parts.push(`# Workflow\n${workflowHints.join(", ")}`);
		return parts.join("\n\n");
	}

	// ── 完成 / 失败判定（语义事件） ──

	/**
	 * settled → 完成路径（ADR-0004/0006）：
	 * PR 卫生先查真实提交（过滤 [afk-wip]）；无真实提交 → 不开 PR，标 complete + issue 注释说明；
	 * 有真实提交 → push -u origin branch → removeWithWip → createPr → 重标 ready-for-human + comment PR。
	 * 顺序必须 push → removeWithWip：remove() 对 afk 分支命中 branch===目录名 判定会删本地分支，
	 * 先推远程保证 createPr 有 src refspec；removeWithWip 的最终 [afk-wip] 快照不进 PR（ADR-0006）。
	 */
	private async handleSettled(agentId: string): Promise<void> {
		const task = this.findTaskByAgentId(agentId);
		// 幂等：settled 可能迟到/重复；needs-review/pr-pending 等非 running 态不重复处理
		if (!task || task.status !== "running") return;
		const project = this.resolveProject(task);
		const projectPath = project?.path;
		try {
			if (!projectPath || !task.worktreePath || !task.branch) {
				// 防御：缺项目/缺 worktree（异常状态）——不留 PR，直接 complete 收口，避免卡 running
				task.status = "complete";
			} else {
				// ADR-0006：分支相对 main 的真实提交（过滤 [afk-wip] 快照）
				const realCommits = await this.listRealCommits(projectPath, task.branch);
				if (realCommits.length === 0) {
					// 无真实提交：不开 PR，标 complete + issue 注释说明（重标 ready-for-human 由 completeIssue 完成）
					await this.worktreeService
						.removeWithWip(task.worktreePath, projectPath, task.ticketRef)
						.catch(() => undefined);
					await this.removeChildProjectRecord(task.worktreePath, project.id);
					await this.ticketSource.completeIssue(projectPath, task.ticketRef, undefined);
					task.status = "complete";
				} else {
					await this.pushBranch(projectPath, task.branch);
					await this.worktreeService
						.removeWithWip(task.worktreePath, projectPath, task.ticketRef)
						.catch(() => undefined);
					await this.removeChildProjectRecord(task.worktreePath, project.id);
					const pr = await this.ticketSource.createPr(
						projectPath,
						task.branch,
						this.prTitle(task),
						this.buildPrBody(task, realCommits),
					);
					task.prUrl = pr.url;
					await this.ticketSource.completeIssue(projectPath, task.ticketRef, pr.url);
					task.status = "pr-pending";
				}
			}
			task.endedAt = Date.now();
			// 完成即一次状态变更推送：prUrl 已回填，pushStatusChanged 内顺带兜底 ticketUrl
			this.pushStatusChanged(task);
		} catch (error) {
			// 完成路径异常（push/PR/重标失败）：failed + needs-info（failTask 内 best-effort 回写），
			// 避免 ticket 滞留 ready-for-agent 被下轮 poll 循环重派
			await this.failTask(task, `完成路径失败：${errorMessage(error)}`, { keepWorktree: false });
		} finally {
			// 终态后 stop agent + 关 tab 防泄漏（CONTEXT.md AfkTask Lifecycle）
			await this.agentManager.stop(agentId).catch(() => undefined);
		}
		void this.saveState();
	}

	/** statusChanged === "error" → 失败路径（errorSummary 取自 tab.lastError，ADR-0005）。 */
	private handleStatusChanged(event: {
		agentId: string;
		status: string;
		tab: { lastError?: string };
	}): void {
		if (event.status !== "error") return;
		const task = this.findTaskByAgentId(event.agentId);
		if (!task || task.status !== "running") return;
		const errorSummary = event.tab.lastError?.trim() || "Agent 进入 error 状态";
		void this.failTask(task, errorSummary, { keepWorktree: false });
	}

	/**
	 * 统一失败路径（ADR-0005 Failed 条件枚举）：agent error / 超时 / RPC 预检失败 / orchestrator 异常。
	 * - keepWorktree=false（默认）：removeWithWip 先 [afk-wip] 快照再删 worktree
	 * - keepWorktree=true（超时）：WIP 快照提交但 worktree 保留，供重跑复用（ADR-0003）
	 * - best-effort 回写 issue（needs-info + 失败原因 comment），不自动重试
	 */
	private async failTask(
		task: AfkTask,
		errorSummary: string,
		opts: { keepWorktree: boolean },
	): Promise<void> {
		task.errorSummary = errorSummary;
		const project = this.resolveProject(task);
		try {
			// 先停 agent 再动工作树：避免停止过程中 agent 继续写文件产生脏快照
			if (task.agentId) {
				await this.agentManager.stop(task.agentId).catch(() => undefined);
			}
			if (opts.keepWorktree) {
				// 超时路径：WIP 快照提交、worktree 保留（ADR-0003），等重跑复用或 TTL 后 GC
				if (project && task.worktreePath) {
					await this.worktreeService.commitWip(task.worktreePath, task.ticketRef);
				}
			} else if (project && task.worktreePath) {
				await this.worktreeService
					.removeWithWip(task.worktreePath, project.path, task.ticketRef)
					.catch(() => undefined);
				await this.removeChildProjectRecord(task.worktreePath, project.id);
			}
			if (project) {
				// best-effort：回写失败不阻断终态；needs-info 防循环重派（ADR-0005）
				try {
					await this.ticketSource.failIssue(project.path, task.ticketRef, errorSummary);
				} catch (error) {
					console.error("[AFK] 回写 issue 失败:", errorMessage(error));
				}
			}
		} finally {
			task.status = "failed";
			task.endedAt = Date.now();
			this.pushStatusChanged(task);
			void this.saveState();
		}
	}

	/** 超时检查（poll 内调用，不挂 per-task 定时器）：startedAt + timeoutMs 过期 → failed（保留 WIP）。 */
	private async checkTimeouts(): Promise<void> {
		const afk = this.settingsStore.get().afk;
		const now = Date.now();
		for (const task of this.state.tasks) {
			if (task.status !== "running" || !task.startedAt) continue;
			if (now - task.startedAt > afk.timeoutMs) {
				await this.failTask(task, `超时：超过 ${Math.round(afk.timeoutMs / 60_000)} 分钟未完成`, {
					keepWorktree: true,
				});
			}
		}
	}

	// ── git 操作（统一经 CommandRunner.runGit：超时 30s 默认/缓冲 32MB/stderr 归一化/ENOENT 归类） ──

	/** 推分支并设上游：git push -u origin {branch}（cwd 为项目主工作区）；网络大调用覆盖 120s 超时。 */
	private async pushBranch(projectPath: string, branch: string): Promise<void> {
		await runGit(projectPath, ["push", "-u", "origin", branch], { timeoutMs: 120_000 });
	}

	/**
	 * ADR-0006 PR 卫生：分支相对 main 的提交列表，过滤 [afk-wip] WIP 快照（AFK_WIP_PREFIX 见 WorktreeService）。
	 * 返回真实提交的 subject 列表（供 PR body 引用）；空数组 = 无真实提交 → 不开 PR。
	 */
	private async listRealCommits(projectPath: string, branch: string): Promise<string[]> {
		const stdout = await runGit(projectPath, ["log", "main..branch", "--format=%s"]);
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith(AFK_WIP_PREFIX));
	}

	// ── 工具 ──

	/**
	 * 目标项目列表（B 方案多项目轮转）：按设置顺序返回存在的项目。
	 * 工单扫描按列表顺序进行，认领第一个可认领的（全局仍一次一个任务）。
	 */
	private targetProjects(): Project[] {
		const ids = this.settingsStore.get().afk.targetProjectIds;
		const projects: Project[] = [];
		for (const id of ids) {
			const project = this.projectStore.get(id);
			if (project) projects.push(project);
		}
		return projects;
	}

	/**
	 * 从任务解析其来源项目：优先 task.projectId（dispatch 时绑定），
	 * 缺失（旧 afk-state.json 存档）时回落当前目标项目列表第一个。
	 */
	private resolveProject(task: AfkTask): Project | undefined {
		if (task.projectId) {
			const project = this.projectStore.get(task.projectId);
			if (project) return project;
		}
		return this.targetProjects()[0];
	}

	/**
	 * 目标项目列表由 SettingsStore 归一化后的 afk 配置驱动（形状保证，见 normalizeAfkSettings）。
	 * intervalMs 缺省读设置（start/init 路径）；applySettings 传最新值（设置已落库，避免时序依赖）。
	 */
	private schedulePolling(intervalMs?: number): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = setInterval(() => {
			void this.poll();
		}, intervalMs ?? this.settingsStore.get().afk.pollIntervalMs);
		this.pollTimer.unref?.();
	}

	private hasActiveTask(): boolean {
		return this.state.tasks.some((task) => task.status === "queued" || task.status === "running");
	}

	private findTaskByAgentId(agentId: string): AfkTask | undefined {
		return this.state.tasks.find((task) => task.agentId === agentId);
	}

	/**
	 * 清理时显式移除子项目记录（handoff 明确：不显式 remove 会孤儿记录泄漏）。
	 * 按路径找子项目（findByPath 做归一化比较），并校验 worktreeParentId 防止误删父记录。
	 */
	private async removeChildProjectRecord(
		worktreePath: string,
		parentProjectId: string | undefined,
	): Promise<void> {
		if (!parentProjectId) return;
		const child = this.projectStore.findByPath(worktreePath);
		if (!child || child.worktreeParentId !== parentProjectId) return;
		await this.projectStore.remove(child.id).catch(() => undefined);
	}

	private prTitle(task: AfkTask): string {
		return `AFK #${task.ticketRef}: ${task.title}`;
	}

	private buildPrBody(task: AfkTask, realCommits: string[]): string {
		return [
			`AFK 自动完成 #${task.ticketRef}：${task.title}`,
			"",
			`相关 Issue: #${task.ticketRef}`,
			"",
			"真实提交:",
			...realCommits.map((subject) => `- ${subject}`),
			"",
			`> \`${AFK_WIP_PREFIX}\` 为 WIP 快照提交（ADR-0003），非本次功能改动。`,
		].join("\n");
	}

	private pushStatusChanged(task: AfkTask): void {
		// 兜底：旧存档/remote 缺失时从 prUrl 反推工单地址（面板不再自行推导）
		this.attachTicketUrl(task);
		const win = this.getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.webContents.send(ipcChannels.afkStatusChanged, task);
	}

	// ── 工单地址（ticketUrl）──

	/**
	 * 计算并回填 task.ticketUrl：已有值直接复用；否则从 git remote 反查仓库基址拼
	 * {webBase}/issues/{ticketRef}。Project 类型无 remote 字段（类型见 shared/types/project.ts），
	 * 仓库定位经 git remote get-url origin 读取；失败/缺 remote → undefined（面板禁用按钮）。
	 */
	private async computeTicketUrl(
		task: AfkTask,
		project: Project | undefined,
	): Promise<string | undefined> {
		if (task.ticketUrl) return task.ticketUrl;
		if (task.prUrl) {
			this.attachTicketUrl(task);
			return task.ticketUrl;
		}
		if (!project) return undefined;
		const remote = await runGit(project.path, ["remote", "get-url", "origin"], {
			timeoutMs: 10_000,
		}).catch(() => "");
		const webBase = remoteToWebBase(remote);
		if (!webBase) return undefined;
		task.ticketUrl = `${webBase}/issues/${task.ticketRef}`;
		return task.ticketUrl;
	}

	/** 同步兜底：prUrl 已存在时从 PR 地址反推工单地址（旧面板 deriveTicketUrl 的等价物）。 */
	private attachTicketUrl(task: AfkTask): void {
		if (task.ticketUrl || !task.prUrl) return;
		const match = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(task.prUrl);
		if (match) task.ticketUrl = `${match[1]}/issues/${task.ticketRef}`;
	}
}

/** git remote 归一化为 Web 仓库基址（https://host/owner/repo）。支持 https、git@、ssh:// 形态；其余返回 undefined。 */
function remoteToWebBase(remote: string): string | undefined {
	const trimmed = remote.trim().replace(/\.git$/, "");
	if (!trimmed) return undefined;
	const https = /^https?:\/\/(.+)$/.exec(trimmed);
	if (https) return `https://${https[1]}`;
	const ssh = /^(?:ssh:\/\/)?git@([^/:]+)[:/](.+)$/.exec(trimmed);
	if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
	return undefined;
}
