import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ExternalLink,
	GitPullRequest,
	LayoutDashboard,
	ListTodo,
	RefreshCw,
	Square,
} from "lucide-react";
import type { AfkState, AfkTask, AfkTaskStatus } from "../../../../shared/types";
import { t, type TranslationKey } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { formatTime } from "./AppUtils";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { CloseIconButton, IconButton } from "../ui/IconButton";
import { Modal } from "../ui/Modal";

export interface AfkPanelProps {
	/** 是否显示全屏弹窗 */
	open: boolean;
	/** 关闭弹窗 */
	onClose: () => void;
	/** 「去配置」：跳转设置页 afk tab（App 接线） */
	onGoConfigure: () => void;
	/** 可选：打开 agent 会话（App 切换 activeAgentId）。未接线时详情抽屉「打开会话」按钮禁用。 */
	onOpenSession?: (agentId: string) => void;
}

type AfkTab = "overview" | "tasks" | "prs";

/** 任务列表筛选：全部 / 活跃（queued+running）/ 完成 / 失败（与统计口径一致） */
type TaskFilter = "all" | "active" | "complete" | "failed";

/** 6 状态文案映射：键已由 preload/i18n 契约锁定（zh/en 成对，不新增） */
const STATUS_LABEL_KEY: Record<AfkTaskStatus, TranslationKey> = {
	queued: "afk.status.queued",
	running: "afk.status.running",
	complete: "afk.status.complete",
	failed: "afk.status.failed",
	"pr-pending": "afk.status.pr-pending",
	"needs-review": "afk.status.needs-review",
};

const TAB_ITEMS: Array<{ id: AfkTab; label: TranslationKey; icon: typeof LayoutDashboard }> = [
	{ id: "overview", label: "afk.tabs.overview", icon: LayoutDashboard },
	{ id: "tasks", label: "afk.tabs.tasks", icon: ListTodo },
	{ id: "prs", label: "afk.tabs.prs", icon: GitPullRequest },
];

const FILTER_OPTIONS: Array<{ value: TaskFilter; label: TranslationKey; dotClass?: string }> = [
	{ value: "all", label: "common.all" },
	{ value: "active", label: "afk.stats.active", dotClass: "afk-status-running" },
	{ value: "complete", label: "afk.stats.complete", dotClass: "afk-status-complete" },
	{ value: "failed", label: "afk.stats.failed", dotClass: "afk-status-failed" },
];

/** 活跃 = queued / running（handoff 定稿口径，用于统计卡与「活跃」筛选） */
function isActiveStatus(status: AfkTaskStatus): boolean {
	return status === "queued" || status === "running";
}

/**
 * 统计卡计数：活跃=queued+running；待合并=pr-pending；needs-review 属 complete 后人审阶段，不落入 4 卡。
 * 列表级聚合（Orchestrator 推送单任务增量，无法代算），保留在面板。
 */
function countByStatus(tasks: AfkTask[]) {
	let active = 0;
	let complete = 0;
	let failed = 0;
	let prPending = 0;
	for (const task of tasks) {
		if (isActiveStatus(task.status)) active += 1;
		else if (task.status === "complete") complete += 1;
		else if (task.status === "failed") failed += 1;
		else if (task.status === "pr-pending") prPending += 1;
	}
	return { active, complete, failed, prPending };
}

/** 排序：活跃置顶（running 先于 queued），组内按创建时间新→旧；无时间戳的排最后 */
function sortTasks(tasks: AfkTask[]): AfkTask[] {
	const taskTime = (task: AfkTask) => task.createdAt ?? task.startedAt ?? task.endedAt ?? 0;
	return [...tasks].sort((a, b) => {
		const aActive = isActiveStatus(a.status);
		const bActive = isActiveStatus(b.status);
		if (aActive !== bActive) return aActive ? -1 : 1;
		if (aActive && bActive && a.status !== b.status) {
			return a.status === "running" ? -1 : 1;
		}
		return taskTime(b) - taskTime(a);
	});
}
/**
 * 耗时展示：h/m/s 缩写，中英文通用（不引入新 i18n 键） */
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const totalSeconds = Math.floor(ms / 1000);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/** 订阅事件推送的单任务更新：按 ticketRef 覆盖/插入（不整体替换，避免列表闪烁） */
function upsertTask(state: AfkState, task: AfkTask): AfkState {
	const exists = state.tasks.some((item) => item.ticketRef === task.ticketRef);
	return {
		...state,
		tasks: exists
			? state.tasks.map((item) => (item.ticketRef === task.ticketRef ? task : item))
			: [task, ...state.tasks],
	};
}

type TimelineStep = {
	key: string;
	label: string;
	time?: string;
	tone: "done" | "current" | "todo";
	failed?: boolean;
};

/**
 * 生命周期时间线。Orchestrator 已按阶段回填真实时间戳（createdAt/claimedAt/worktreeAt/
 * startedAt/endedAt），此处直接取字段；旧 afk-state.json 存档缺新字段（可选）时对应节点
 * 不显示时间，结构不变。
 */
function buildTimeline(task: AfkTask): TimelineStep[] {
	const failed = task.status === "failed";
	const steps: Array<Omit<TimelineStep, "tone">> = [
		{
			key: "created",
			label: t("afk.timeline.created"),
			time: task.claimedAt != null ? formatTime(task.claimedAt) : undefined,
		},
		{
			key: "worktree",
			label: t("afk.timeline.worktree"),
			time: task.worktreeAt != null ? formatTime(task.worktreeAt) : undefined,
		},
		{
			key: "running",
			label: t("afk.timeline.running"),
			time: task.startedAt != null ? formatTime(task.startedAt) : undefined,
		},
		{
			key: "terminal",
			label: failed ? t("afk.timeline.failed") : t("afk.timeline.complete"),
			time: task.endedAt != null ? formatTime(task.endedAt) : undefined,
			failed,
		},
	];
	if (task.prUrl) {
		steps.push({
			key: "pr",
			label: t("afk.timeline.prCreated"),
			time: task.endedAt != null ? formatTime(task.endedAt) : undefined,
		});
	}
	// 当前节点：queued=已认领；running=agent 已启动；终态=terminal（有 PR 则停在 PR 节点）
	const currentIndex =
		task.status === "queued" ? 0 : task.status === "running" ? 2 : task.prUrl ? 4 : 3;
	return steps.map((step, index) => ({
		...step,
		tone: index < currentIndex ? "done" : index === currentIndex ? "current" : "todo",
	}));
}

/** 任务列表行（总览活跃列表与任务 tab 共用） */
function TaskRow(props: {
	task: AfkTask;
	onOpen: (task: AfkTask) => void;
	onOpenPr: (url: string) => void;
}) {
	const { task, onOpen, onOpenPr } = props;
	const prUrl = task.prUrl;
	// running 任务无 endedAt：按当前时刻估算，订阅推送会驱动重渲染刷新；
	// 终态时间戳异常（endedAt < startedAt）时不展示耗时
	const durationMs =
		task.startedAt != null ? (task.endedAt ?? Date.now()) - task.startedAt : null;
	const duration = durationMs != null && durationMs >= 0 ? formatDuration(durationMs) : undefined;
	return (
		<div className="afk-task-row">
			<div className="afk-task-row-line">
				<button
					type="button"
					className="afk-task-row-main"
					onClick={() => onOpen(task)}
					title={task.title}
				>
					<span className={`afk-status-dot afk-status-${task.status}`} aria-hidden="true" />
					<span className="afk-task-ticket">#{task.ticketRef}</span>
					<span className="afk-task-title">{task.title}</span>
					<span className="afk-status-text">{t(STATUS_LABEL_KEY[task.status])}</span>
				</button>
				{task.branch && (
					<span className="afk-task-meta">
						<span className="afk-task-branch">{task.branch}</span>
					</span>
				)}
				{duration != null && (
					<span className="afk-task-meta">
						<span className="afk-task-duration">{duration}</span>
					</span>
				)}
				{prUrl && (
					<IconButton
						label={t("afk.task.pr")}
						buttonSize="sm"
						variant="ghost"
						onClick={() => onOpenPr(prUrl)}
						title={prUrl}
					>
						<ExternalLink size={13} aria-hidden="true" />
					</IconButton>
				)}
			</div>
			{task.status === "failed" && task.errorSummary && (
				<div className="afk-task-error">
					{t("afk.task.error")}: {task.errorSummary}
				</div>
			)}
		</div>
	);
}

/**
 * AFK 中心页套件：全屏 Modal + 3 tab（总览/任务/PR 待合并）+ 页内详情抽屉。
 * 数据流：打开时拉一次快照，之后订阅 afk:status-changed 增量更新（单订阅通道，终态与
 * PR 完成同走此通道）；手动刷新重新 status()。终止单任务走 afk:terminate
 * （Orchestrator stop agent + failed 收口 + needs-info 回写，取代裸 agents.stop）。
 */
export function AfkPanel({ open, onClose, onGoConfigure, onOpenSession }: AfkPanelProps) {
	const [state, setState] = useState<AfkState>({ tasks: [], enabled: false });
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [tab, setTab] = useState<AfkTab>("overview");
	const [filter, setFilter] = useState<TaskFilter>("all");
	const [detailTicketRef, setDetailTicketRef] = useState<number | null>(null);
	/** 「已合并」两步确认：先点标记，再点确认 */
	const [confirmMergedRef, setConfirmMergedRef] = useState<number | null>(null);
	/** 「终止」两步确认：先点终止武装，3s 内再点确认才 terminate（防误触杀 agent） */
	const [terminateArmed, setTerminateArmed] = useState<number | null>(null);
	const [terminating, setTerminating] = useState(false);

	const refresh = useCallback(async () => {
		setRefreshing(true);
		try {
			// 快照 = 运行态 + 历史归档，整体替换
			const snapshot = await window.piDesktop.afk.status();
			setState(snapshot);
		} catch (error) {
			// 主进程 AFK 未装配时保持旧快照，不打断页面
			showNotice(
				`${t("common.error")}: ${error instanceof Error ? error.message : String(error)}`,
				4000,
				"error",
			);
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		setLoading(true);
		void refresh();
		// 单订阅通道：终态（含 PR 完成）同走 afk:status-changed 增量更新
		const offStatus = window.piDesktop.afk.onStatusChanged((task) => {
			setState((prev) => upsertTask(prev, task));
		});
		return () => {
			offStatus();
		};
	}, [open, refresh]);

	// 详情目标不存在（归档清理等）时自动关抽屉，避免指向幽灵任务
	useEffect(() => {
		if (detailTicketRef != null && !state.tasks.some((t) => t.ticketRef === detailTicketRef)) {
			setDetailTicketRef(null);
		}
	}, [state.tasks, detailTicketRef]);

	const stats = useMemo(() => countByStatus(state.tasks), [state.tasks]);
	const activeTasks = useMemo(
		() => sortTasks(state.tasks.filter((task) => isActiveStatus(task.status))),
		[state.tasks],
	);
	const visibleTasks = useMemo(() => {
		const filtered =
			filter === "all"
				? state.tasks
				: filter === "active"
					? state.tasks.filter((task) => isActiveStatus(task.status))
					: state.tasks.filter((task) => task.status === filter);
		return sortTasks(filtered);
	}, [state.tasks, filter]);
	const prTasks = useMemo(
		() => sortTasks(state.tasks.filter((task) => task.status === "pr-pending")),
		[state.tasks],
	);
	const detailTask = useMemo(
		() =>
			detailTicketRef != null
				? (state.tasks.find((task) => task.ticketRef === detailTicketRef) ?? null)
				: null,
		[state.tasks, detailTicketRef],
	);
	const timeline = useMemo(() => (detailTask ? buildTimeline(detailTask) : []), [detailTask]);

	const openExternal = useCallback((url: string) => {
		void window.piDesktop.app.openExternal(url).catch((error) => {
			showNotice(
				`${t("common.error")}: ${error instanceof Error ? error.message : String(error)}`,
				4000,
				"error",
			);
		});
	}, []);

	const switchTab = useCallback((next: AfkTab) => {
		setTab(next);
		// 切 tab 关闭详情抽屉，避免跨页残留叠层
		setDetailTicketRef(null);
	}, []);

	const handleTerminateClick = useCallback(
		(task: AfkTask) => {
			if (!task.agentId) return;
			if (terminateArmed !== task.ticketRef) {
				setTerminateArmed(task.ticketRef);
				window.setTimeout(() => {
					setTerminateArmed((current) => (current === task.ticketRef ? null : current));
				}, 3000);
				return;
			}
			setTerminating(true);
			void window.piDesktop.afk
				.terminate(task.ticketRef)
				// 终止后的任务状态由 Orchestrator 语义事件（afk:status-changed）推送，无需本地改写
				.catch((error) => {
					showNotice(
						`${t("afk.detail.terminate")} ${t("common.error")}: ${
							error instanceof Error ? error.message : String(error)
						}`,
						5000,
						"error",
					);
				})
				.finally(() => {
					setTerminating(false);
					setTerminateArmed(null);
				});
		},
		[terminateArmed],
	);

	const confirmMerged = useCallback(() => {
		// 「已合并」为 P0 半人工：UI 确认后提示分支 GC（renderer 无 afk 分支 GC 通道，不新增 IPC）
		setConfirmMergedRef(null);
		showNotice(t("afk.prs.gcHint"), 5000, "warning");
	}, []);

	return (
		<Modal open={open} onClose={onClose} title={t("afk.title")} size="full" contentClassName="afk-panel">
			<div className="afk-toolbar">
				<div className="afk-tabs" role="tablist" aria-label={t("afk.title")}>
					{TAB_ITEMS.map((item) => {
						const Icon = item.icon;
						return (
							<button
								key={item.id}
								type="button"
								role="tab"
								aria-selected={tab === item.id}
								className={`afk-tab${tab === item.id ? " active" : ""}`}
								onClick={() => switchTab(item.id)}
							>
								<Icon size={14} aria-hidden="true" />
								{t(item.label)}
							</button>
						);
					})}
				</div>
				<div className="afk-toolbar-actions">
					<IconButton
						label={t("common.refresh")}
						variant="outline"
						buttonSize="sm"
						disabled={refreshing}
						onClick={() => void refresh()}
					>
						<RefreshCw size={14} aria-hidden="true" />
					</IconButton>
				</div>
			</div>

			<div className="afk-body">
				{loading ? (
					<div className="config-empty">{t("common.loading")}</div>
				) : tab === "overview" ? (
					<div className="afk-scroll">
						<div className="afk-stats">
							<div className="afk-stat-card afk-stat-active">
								<span className="afk-stat-value">{stats.active}</span>
								<span className="afk-stat-label">{t("afk.stats.active")}</span>
							</div>
							<div className="afk-stat-card afk-stat-complete">
								<span className="afk-stat-value">{stats.complete}</span>
								<span className="afk-stat-label">{t("afk.stats.complete")}</span>
							</div>
							<div className="afk-stat-card afk-stat-failed">
								<span className="afk-stat-value">{stats.failed}</span>
								<span className="afk-stat-label">{t("afk.stats.failed")}</span>
							</div>
							<div className="afk-stat-card afk-stat-pr-pending">
								<span className="afk-stat-value">{stats.prPending}</span>
								<span className="afk-stat-label">{t("afk.stats.prPending")}</span>
							</div>
						</div>

						<div className="afk-status-line">
							<Badge className={state.enabled ? "afk-badge-enabled" : undefined}>
								<span
									className={
										state.enabled
											? "afk-status-dot afk-status-complete"
											: "afk-status-dot afk-status-queued"
									}
									aria-hidden="true"
								/>
								{state.enabled ? t("common.enabled") : t("common.disabled")}
							</Badge>
							<span className="afk-last-poll">
								{t("afk.lastPollAt")}:{" "}
								{state.lastPollAt != null ? formatTime(state.lastPollAt) : t("afk.neverPolled")}
							</span>
						</div>

						{state.tasks.length === 0 ? (
							// 空状态：未启用 → 引导去配置；已启用 → 轮询等待工单
							<div className="afk-empty">
								<span>{state.enabled ? t("afk.overview.empty") : t("afk.configureHint")}</span>
								{!state.enabled && (
									<Button variant="primary" buttonSize="sm" onClick={onGoConfigure}>
										{t("afk.goConfigure")}
									</Button>
								)}
							</div>
						) : activeTasks.length > 0 ? (
							<>
								<h3 className="afk-section-title">{t("afk.stats.active")}</h3>
								<div className="afk-task-list">
									{activeTasks.map((task) => (
										<TaskRow
											key={task.ticketRef}
											task={task}
											onOpen={(item) => setDetailTicketRef(item.ticketRef)}
											onOpenPr={openExternal}
										/>
									))}
								</div>
							</>
						) : null}
					</div>
				) : tab === "tasks" ? (
					<div className="afk-scroll">
						<div className="afk-list-toolbar">
							<div className="afk-filter" role="group" aria-label={t("afk.tabs.tasks")}>
								{FILTER_OPTIONS.map((option) => (
									<button
										key={option.value}
										type="button"
										className={`afk-filter-btn${filter === option.value ? " active" : ""}`}
										onClick={() => setFilter(option.value)}
									>
										{option.dotClass && (
											<span className={`afk-status-dot ${option.dotClass}`} aria-hidden="true" />
										)}
										{t(option.label)}
									</button>
								))}
							</div>
						</div>
						{visibleTasks.length === 0 ? (
							<div className="config-empty">{t("afk.tasks.empty")}</div>
						) : (
							<div className="afk-task-list">
								{visibleTasks.map((task) => (
									<TaskRow
										key={task.ticketRef}
										task={task}
										onOpen={(item) => setDetailTicketRef(item.ticketRef)}
										onOpenPr={openExternal}
									/>
								))}
							</div>
						)}
					</div>
				) : (
					<div className="afk-scroll">
						{prTasks.length === 0 ? (
							<div className="config-empty">{t("afk.prs.empty")}</div>
						) : (
							<div className="afk-pr-list">
								{prTasks.map((task) => {
									const prUrl = task.prUrl;
									// 契约上 pr-pending 必有 prUrl；数据异常时静默跳过该行
									if (!prUrl) return null;
									return (
									<div className="afk-pr-row" key={task.ticketRef}>
										<div className="afk-pr-main">
											<button
												type="button"
												className="afk-pr-link"
												onClick={() => openExternal(prUrl)}
												title={prUrl}
											>
												<ExternalLink size={13} aria-hidden="true" />
												<span className="afk-pr-link-text">
													{prUrl.replace(/^https?:\/\/(www\.)?/, "")}
												</span>
											</button>
											<span className="afk-pr-ticket">
												<strong>#{task.ticketRef}</strong> {task.title}
											</span>
										</div>
										{task.branch && <span className="afk-pr-meta">{task.branch}</span>}
										{task.endedAt != null && (
											<span className="afk-pr-meta">{formatTime(task.endedAt)}</span>
										)}
										<div className="afk-pr-actions">
											<Button buttonSize="sm" onClick={() => openExternal(prUrl)}>
												{t("afk.detail.openPr")}
											</Button>
											{task.ticketUrl ? (
												<Button
													buttonSize="sm"
													onClick={() => task.ticketUrl && openExternal(task.ticketUrl)}
												>
													{t("afk.detail.openTicket")}
												</Button>
											) : null}
											{confirmMergedRef === task.ticketRef ? (
												<span className="afk-pr-confirm">
													<Button buttonSize="sm" variant="danger" onClick={confirmMerged}>
														{t("common.confirm")}
													</Button>
													<Button
														buttonSize="sm"
														variant="ghost"
														onClick={() => setConfirmMergedRef(null)}
													>
														{t("common.cancel")}
													</Button>
												</span>
											) : (
												<Button
													buttonSize="sm"
													variant="ghost"
													onClick={() => setConfirmMergedRef(task.ticketRef)}
												>
													{t("afk.prs.markMerged")}
												</Button>
											)}
										</div>
									</div>
									);
								})}
							</div>
						)}
					</div>
				)}
			</div>

			{detailTask && (
				<div className="afk-detail-backdrop" onClick={() => setDetailTicketRef(null)}>
					<aside
						className="afk-detail-drawer"
						role="dialog"
						aria-label={t("afk.detail.timeline")}
						onClick={(event) => event.stopPropagation()}
					>
						<header className="afk-detail-header">
							<span className="afk-detail-ticket">#{detailTask.ticketRef}</span>
							<Badge className="afk-detail-status">
								{t(STATUS_LABEL_KEY[detailTask.status])}
							</Badge>
							<CloseIconButton
								label={t("common.close")}
								onClick={() => setDetailTicketRef(null)}
							/>
						</header>

						<div className="afk-detail-body">
							<h3 className="afk-detail-title">{detailTask.title}</h3>

							<div className="afk-detail-meta">
								{detailTask.branch && (
									<div className="afk-detail-meta-row">
										<span>{t("afk.task.branch")}</span>
										<code>{detailTask.branch}</code>
									</div>
								)}
								{detailTask.prUrl && (
									<div className="afk-detail-meta-row">
										<span>{t("afk.task.pr")}</span>
										<code>{detailTask.prUrl}</code>
									</div>
								)}
							</div>

							<section>
								<h4 className="afk-detail-section-title">{t("afk.detail.timeline")}</h4>
								<ol className="afk-timeline">
									{timeline.map((step) => (
										<li
											key={step.key}
											className={`afk-timeline-item ${step.tone}${step.failed ? " failed" : ""}`}
										>
											<span className="afk-timeline-dot" aria-hidden="true" />
											<div className="afk-timeline-body">
												<span className="afk-timeline-label">{step.label}</span>
												{step.time && <span className="afk-timeline-time">{step.time}</span>}
											</div>
										</li>
									))}
								</ol>
							</section>
						</div>

						<footer className="afk-detail-actions">
							{(() => {
								const url = detailTask.ticketUrl;
								return (
									<Button
										buttonSize="sm"
										disabled={!url}
										onClick={() => url && openExternal(url)}
									>
										{t("afk.detail.openTicket")}
									</Button>
								);
							})()}
							<Button
								buttonSize="sm"
								disabled={!detailTask.agentId || !onOpenSession}
								onClick={() =>
									detailTask.agentId &&
									onOpenSession &&
									onOpenSession(detailTask.agentId)
								}
							>
								{t("afk.detail.openSession")}
							</Button>
							<Button
								buttonSize="sm"
								disabled={!detailTask.prUrl}
								onClick={() => detailTask.prUrl && openExternal(detailTask.prUrl)}
							>
								{t("afk.detail.openPr")}
							</Button>
							<Button
								buttonSize="sm"
								disabled={!detailTask.worktreePath}
								onClick={() =>
									detailTask.worktreePath &&
									void window.piDesktop.files.open(detailTask.worktreePath)
								}
							>
								{t("afk.detail.openWorktree")}
							</Button>
							{isActiveStatus(detailTask.status) && detailTask.agentId && (
								<Button
									buttonSize="sm"
									variant="danger"
									loading={terminating}
									onClick={() => handleTerminateClick(detailTask)}
								>
									{terminateArmed === detailTask.ticketRef ? (
										t("common.confirm")
									) : (
										<>
											<Square size={12} aria-hidden="true" />
											{t("afk.detail.terminate")}
										</>
									)}
								</Button>
							)}
						</footer>
					</aside>
				</div>
			)}
		</Modal>
	);
}
