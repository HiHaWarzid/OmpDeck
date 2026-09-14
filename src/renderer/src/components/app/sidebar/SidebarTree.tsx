import {
	Fragment,
	memo,
	type Dispatch,
	type DragEvent,
	type ReactNode,
	type SetStateAction,
} from "react";
import {
	Bot,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Filter,
	FolderCog,
	FolderPlus,
	GitBranch,
	Globe,
	HatGlasses,
	MessageSquare,
	PanelLeft,
	Play,
	Plus,
	Search,
	Settings,
	Sliders,
	Trash2,
} from "lucide-react";
import type { PiDesktopApi } from "../../../../../shared/api";
import type { AgentTab, GitBranchInfo, Project, SessionSummary } from "../../../../../shared/types";
import {
	getAgentForSessionPath,
	isSameSessionPath,
	isSidebarSessionRowActive,
	normalizeSessionPathForCompare,
} from "../../../agentListDisplay";
import { t } from "../../../i18n";
import { dispatchToAgent } from "../../../workspace/dispatch";
import { rpcLogActions } from "../../../workspace/slices/rpcLogSlice";
import { Badge } from "../../ui/Badge";
import { IconButton } from "../../ui/IconButton";
import { AgentStatusIndicator, BrandLockup, ProjectAvatar } from "../brand/Brand";
import { formatTime } from "../AppUtils";
import {
	displayProjectDirectoryName,
	formatCodexSubagentName,
	formatPiSubagentName,
	isChatProject,
} from "./sidebarDisplay";
import {
	EMPTY_AGENTS,
	EMPTY_PROJECT_DISPLAY,
	SIDEBAR_PROJECT_CHILD_PAGE_SIZE,
	type SessionSource,
	type SidebarProjectRow,
} from "./sidebarProjection";

/**
 * 侧栏树（批次 5c）：从 App 根内联 JSX（约 980 行）抽出的 memo 组件。
 *
 * 为什么抽出来：App 在流式/思考期间以 ~20Hz 重渲染，内联侧栏每次都要重新构造
 * 近千行元素树；抽出后数据面走窄 props（项目列表 / 投影表 / 活动 id / 展开集合 /
 * 回调），展开集合等引用未变时 memo 直接跳过整棵子树。
 *
 * 为什么渲染期不做分组：搜索过滤、会话分组排序、worktree 行解析（原先散在渲染体里
 * 的 `projects.filter` / `projects.find` / `filteredAgents.filter` +
 * `getProjectAgentSessionDisplay`）全部收敛到 sidebarProjection 的纯函数投影，
 * 组件只按 projectId 查表。
 *
 * 可见行为不变：展开/折叠、分页、右键菜单、拖拽/隐藏规则、文案与 aria 属性逐字保留。
 */

/** 侧栏右键菜单锚点：项目菜单。 */
export interface SidebarProjectMenu {
	x: number;
	y: number;
	project: Project;
}

/** 侧栏右键菜单锚点：历史会话菜单。 */
export interface SidebarSessionMenu {
	x: number;
	y: number;
	projectId: string;
	session: SessionSummary;
}

/** 侧栏右键菜单锚点：Agent 菜单。 */
export interface SidebarAgentMenu {
	x: number;
	y: number;
	agent: AgentTab;
}

/** 来源过滤弹窗锚点（带项目归属）。 */
export interface SidebarSessionFilterAnchor {
	x: number;
	y: number;
	projectId: string;
}

export interface SidebarTreeProps {
	/** 主列表项目：已按搜索过滤、已排除 worktree 子项目（子项目在其父项目下展开）。 */
	projects: Project[];
	/** 每项目行投影（与 projects 同源建表，逐项必有条目）：侧栏唯一数据源。 */
	projectDisplayByProject: Record<string, SidebarProjectRow>;
	/** 按 projectId 预分桶的展示用 agent（含搜索过滤，未过滤的全量在 App 侧）。 */
	agentsByProject: ReadonlyMap<string, AgentTab[]>;
	/** 按 projectId 的历史会话；行点击时用于判断是否已加载。 */
	sessionsByProject: Record<string, SessionSummary[]>;
	sessionLoadingByProject: Record<string, boolean>;
	sessionErrorByProject: Record<string, string>;
	branchInfoByProject: Record<string, GitBranchInfo>;
	/** 按项目的会话来源过滤；null = 显示全部。 */
	sessionSourceFilter: Record<string, Set<SessionSource> | null>;
	/** 展开的项目 id 集合（有 id = 展开）。 */
	expandedSidebarProjects: ReadonlySet<string>;
	/** 展开的子会话组 key 集合（codex 子代理 / pi 子会话共用）。 */
	expandedSubagentGroups: ReadonlySet<string>;
	/** 折叠的工作区 key 集合（main:\${projectId} / wt:\${path}）。 */
	collapsedWorktrees: ReadonlySet<string>;
	/** 正在删除的 worktree 路径集合：淡出动画期间保留 DOM。 */
	removingWorktreePaths: ReadonlySet<string>;
	draggingProjectId?: string;
	dragOverProjectId?: string;
	activeProjectId?: string;
	activeAgentId?: string;
	/** 当前会话窗口展示的 session 路径：侧栏行高亮依据。 */
	displayedSidebarSessionPath?: string;
	/** 侧栏是否被折叠（决定折叠按钮的图标与文案）。 */
	listCollapsed: boolean;
	search: string;
	/** 无搜索词时才允许拖拽排序（避免过滤后序号错乱）。 */
	canReorderProjects: boolean;
	/** agent 启停时递增，重播品牌标动画。 */
	brandLogoReplayToken: number;
	/** 局域网 Web 模式：不渲染桌面端专属的底部动作条。 */
	isLanWeb: boolean;
	/** 拖拽刚结束的抑制点击标记：拖放后浏览器会补发 click，用它屏蔽。 */
	projectDragPreventClickRef: { current: boolean };
	/** 桌面 API 单例（预览/浏览器兜底实现在 App 侧统一选择）。 */
	api: PiDesktopApi;

	setSearch: Dispatch<SetStateAction<string>>;
	addProject: () => void;
	toggleListCollapsed: () => void;
	/** 展开/折叠项目；forceExpand=true 时只展开不切换。 */
	setProjectSidebarExpanded: (projectId: string, forceExpand?: boolean) => void;
	handleProjectDragStart: (event: DragEvent<HTMLButtonElement>, projectId: string) => void;
	handleProjectDragOver: (event: DragEvent<HTMLButtonElement>, projectId: string) => void;
	handleProjectDragLeave: (projectId: string) => void;
	handleProjectDrop: (event: DragEvent<HTMLButtonElement>, targetProjectId: string) => void;
	finishProjectDrag: () => void;
	setProjectMenu: Dispatch<SetStateAction<SidebarProjectMenu | null>>;
	setSessionMenu: Dispatch<SetStateAction<SidebarSessionMenu | null>>;
	setAgentMenu: Dispatch<SetStateAction<SidebarAgentMenu | null>>;
	setSessionFilterOpen: Dispatch<SetStateAction<SidebarSessionFilterAnchor | null>>;
	setWorktreeCreateDialog: Dispatch<SetStateAction<{ projectId: string } | null>>;
	setVisibleProjectChildCountByProject: Dispatch<SetStateAction<Record<string, number>>>;
	setCollapsedWorktrees: Dispatch<SetStateAction<Set<string>>>;
	setExpandedWorktreeSessions: Dispatch<SetStateAction<Set<string>>>;
	setActiveProjectId: Dispatch<SetStateAction<string | undefined>>;
	setActiveAgentId: Dispatch<SetStateAction<string | undefined>>;
	setSettingsOpen: Dispatch<SetStateAction<boolean>>;
	setConfigOpen: Dispatch<SetStateAction<boolean>>;
	setFeedbackOpen: Dispatch<SetStateAction<boolean>>;
	setAfkOpen: Dispatch<SetStateAction<boolean>>;
	/** 拉取项目会话；silent 时失败不弹通知。 */
	refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<SessionSummary[] | undefined>;
	/** 确保 agent 的 transcript 条目已加载（打开会话前调用）。 */
	ensureAgentMessagesLoaded: (agentId: string) => void;
	/** 打开历史会话：已有 agent 则切回该 agent，否则新起 agent。 */
	openSidebarSession: (projectId: string, session: SessionSummary) => void;
	createAgent: (projectId?: string, sessionPath?: string, title?: string, noSession?: boolean) => void;
	showToast: (message: string, duration?: number) => void;
	requestRemoveWorktree: (
		parentProjectId: string,
		worktreePath: string,
		childProject: Project | undefined,
	) => void;
	/** 切换子会话组展开状态（父行与孙级 toggle 共用）。 */
	toggleSubagentGroup: (key: string) => void;
	/** 把右键菜单锚点夹回视口内。 */
	adjustMenuPos: (x: number, y: number, width?: number, height?: number) => { x: number; y: number };
}

/**
 * 状态圆点：memo 叶子（不额外包一层组件——memo(Comp) 与 Comp 共用同一 fiber，
 * 少一层元素/组件实例）。侧栏在流式期间 20Hz 重渲染时，只要 status 字符串没变，
 * 这一行圆点的子树就整体跳过，不会顺带重渲染每行的圆点。
 */
const SidebarStatusDot = memo(AgentStatusIndicator);

/** 项目头像：同上，只吃 name/kind 两个原始值。 */
const MemoProjectAvatar = memo(ProjectAvatar);

function SidebarTreeView({
	projects,
	projectDisplayByProject,
	agentsByProject,
	sessionsByProject,
	sessionLoadingByProject,
	sessionErrorByProject,
	branchInfoByProject,
	sessionSourceFilter,
	expandedSidebarProjects,
	expandedSubagentGroups,
	collapsedWorktrees,
	removingWorktreePaths,
	draggingProjectId,
	dragOverProjectId,
	activeProjectId,
	activeAgentId,
	displayedSidebarSessionPath,
	listCollapsed,
	search,
	canReorderProjects,
	brandLogoReplayToken,
	isLanWeb,
	projectDragPreventClickRef,
	api,
	setSearch,
	addProject,
	toggleListCollapsed,
	setProjectSidebarExpanded,
	handleProjectDragStart,
	handleProjectDragOver,
	handleProjectDragLeave,
	handleProjectDrop,
	finishProjectDrag,
	setProjectMenu,
	setSessionMenu,
	setAgentMenu,
	setSessionFilterOpen,
	setWorktreeCreateDialog,
	setVisibleProjectChildCountByProject,
	setCollapsedWorktrees,
	setExpandedWorktreeSessions,
	setActiveProjectId,
	setActiveAgentId,
	setSettingsOpen,
	setConfigOpen,
	setFeedbackOpen,
	setAfkOpen,
	refreshProjectSessions,
	ensureAgentMessagesLoaded,
	openSidebarSession,
	createAgent,
	showToast,
	requestRemoveWorktree,
	toggleSubagentGroup,
	adjustMenuPos,
}: SidebarTreeProps) {
	return (
		<aside
			className="chat-list-pane v3-braun"
		>
			<div className="sidebar-body">
				<div className="list-toolbar">
				<div className="app-badge">
					{/* 官方 π 标 + 字标；agent 启停时通过 replayToken 重播动画 */}
					<BrandLockup replayToken={brandLogoReplayToken} />
				</div>
				{/* 左侧工具栏折叠入口：与右侧 header-drawer-toggle 共用 IconButton 尺寸 */}
				<IconButton
					label={t("app.collapseList")}
					variant="outline"
					buttonSize="sm"
					className="list-toggle-native"
					onClick={toggleListCollapsed}
				>
					<PanelLeft size={14} strokeWidth={2} aria-hidden="true" />
				</IconButton>
			</div>
			<button
				className="collapse-button list-collapse"
				title={listCollapsed ? t("app.expandList") : t("app.collapseList")}
				onClick={toggleListCollapsed}
			>
				{listCollapsed ? (
					<ChevronRight size={16} />
				) : (
					<ChevronLeft size={16} />
				)}
			</button>

			<div className="search-row">
				<div className="search-box">
					<span className="search-icon">
						<Search size={14} />
					</span>
					<input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={t("app.search")}
					/>
				</div>
				<button className="round-add" onClick={addProject} title={t("app.addProject")}>
					<FolderPlus size={18} />
				</button>
			</div>

			<div className="conversation-list">
				{projects.map((project) => {
					const projectIsChat = isChatProject(project);
					const projectDirectoryName = projectIsChat
						? t("app.chatProject")
						: displayProjectDirectoryName(project);
					const canDragProject = canReorderProjects && !projectIsChat;
					const allProjectAgents = agentsByProject.get(project.id) ?? EMPTY_AGENTS;
					// 搜索/来源过滤、分组排序、worktree 行解析都由侧栏投影按依赖 memo，
					// 此处 O(1) 查表，渲染期不再逐项目重算。
					const projectDerived = projectDisplayByProject[project.id];
					const projectDisplay = projectDerived?.display ?? EMPTY_PROJECT_DISPLAY;
					const projectSessionsLoading = Boolean(
						sessionLoadingByProject[project.id],
					);
					const hasProjectChildren =
						projectDisplay.children.length > 0 || projectSessionsLoading || !!project.worktreeEnabled;
					const isCollapsed = !expandedSidebarProjects.has(project.id);
					const isDraggingProject = draggingProjectId === project.id;
					const isProjectDropTarget = dragOverProjectId === project.id;
					const projectRowClass = [
						"conversation",
						canDragProject ? "project-draggable" : "",
						projectIsChat ? "chat-project" : "",
						isDraggingProject ? "dragging" : "",
						isProjectDropTarget ? "drag-over" : "",
						projectSessionsLoading ? "project-loading" : "",
					]
						.filter(Boolean)
						.join(" ");
					return (
						<div
							key={project.id}
							className={`project-group${projectIsChat ? " chat-project-group" : ""}${project.worktreeEnabled ? " worktree-enabled" : ""}`}
						>
							<button
								className={projectRowClass}
								draggable={canDragProject}
								onDragStart={(event) =>
									handleProjectDragStart(event, project.id)
								}
								onDragOver={(event) =>
									handleProjectDragOver(event, project.id)
								}
								onDragLeave={() => handleProjectDragLeave(project.id)}
								onDrop={(event) => void handleProjectDrop(event, project.id)}
								onDragEnd={finishProjectDrag}
								onContextMenu={(event) => {
									event.preventDefault();
									setProjectMenu({
										x: event.clientX,
										y: event.clientY,
										project,
									});
								}}
								onClick={(event) => {
									if (projectDragPreventClickRef.current) return;
									// 项目点击脉冲动画：给按钮临时加动画 class，提供即时视觉反馈
									const el = event.currentTarget;
									el.classList.add('click-animating');
									setTimeout(() => el.classList.remove('click-animating'), 400);

									// 点击项目行：普通项目始终「打开」（展开 + 确保加载），收起走行首箭头。
									// 展开集合从 localStorage 恢复，项目默认就是展开态——若行点击仍是 toggle，
									// 用户第一次点击会把已展开的项目收起（历史消失），第二次点击才展开显示，
									// 表现为“需要点击两次才能看到历史记录”。
									const hasLoadedSessions = project.id in sessionsByProject;
									if (!projectIsChat) {
										const wasCollapsed = isCollapsed;
										setProjectSidebarExpanded(project.id, true);
										// 折叠→展开时刷新保证最新；已展开但从未加载成功时补拉列表；
										// 已加载但列表为空也刷新一次（上次扫描可能异常，避免空列表卡死）。
										if (
											wasCollapsed ||
											!hasLoadedSessions ||
											(sessionsByProject[project.id]?.length ?? 0) === 0
										) {
											void refreshProjectSessions(project.id).catch(() => undefined);
										}
									} else {
										const wasCollapsed = isCollapsed;
										setProjectSidebarExpanded(project.id);
										if (wasCollapsed && !(project.id in sessionsByProject)) {
											void refreshProjectSessions(project.id).catch(() => undefined);
										}
									}

									setActiveProjectId(project.id);
									setActiveAgentId(undefined);
								}}
							>
								<span
									className={`project-fold${isCollapsed ? " folded" : ""}${hasProjectChildren ? " has-agents" : ""}`}
									title={
										isCollapsed
											? t("app.projectExpand")
											: t("app.projectCollapse")
									}
									onClick={(e) => {
										// 点击折叠图标仅切换折叠状态；会话由 expanded 变化 effect 补加载
										e.stopPropagation();
										setProjectSidebarExpanded(project.id);
									}}
								>
									<Play size={12} />
								</span>
								<MemoProjectAvatar
									name={projectDirectoryName}
									kind={projectIsChat ? "chat" : "project"}
								/>
								<div className="conversation-body">
									<div className="conversation-title">
										<strong title={project.path}>
											{projectDirectoryName}
										</strong>
										{projectSessionsLoading && (
											<span className="conversation-loading" />
										)}
										{(sessionSourceFilter[project.id] ?? null) !== null && (
											<Filter
												size={12}
												className="filter-indicator"
												onClick={(e) => {
													e.stopPropagation();
													setSessionFilterOpen({
														...adjustMenuPos(e.clientX, e.clientY, 180, 250),
														projectId: project.id,
													});
												}}
											/>
										)}
									</div>
									{projectIsChat && (
										<p className="chat-project-guide">
											{t("app.projectChatGuide")}
										</p>
									)}
								</div>
								<span className="project-row-actions">
									{projectIsChat && (
										<span
											className="project-action"
											title={t("app.chatProjectSettings")}
											onClick={(event) => {
												event.stopPropagation();
												// 打开系统目录选择器（默认定位当前聊天目录），选中后保存并重新加载该目录下的会话。
												void (async () => {
													const picked = await api.projects.chooseChatPath();
													if (!picked || picked === project.path) return;
													await api.projects.setChatPath(picked);
													await refreshProjectSessions(project.id);
													showToast(t("app.chatProjectPathUpdated"), 1800);
												})().catch((err) => console.error("Failed to change chat directory", err));
											}}
										>
											<FolderCog size={14} />
										</span>
									)}
									<span
										className="project-action"
										title={t("app.projectNewAgent")}
										onClick={(event) => {
											event.stopPropagation();
											void createAgent(project.id);
										}}
									>
										<Plus size={14} />
									</span>
									<span
										className="project-action"
										title={t("app.anonymousChat")}
										onClick={(event) => {
											event.stopPropagation();
											void createAgent(project.id, undefined, undefined, true);
										}}
									>
										<HatGlasses size={14} />
									</span>
								</span>
							</button>
							{!isCollapsed && project.worktreeEnabled && (() => {
								const mainWtKey = `main:${project.id}`;
								const mainSessionsExpanded = !collapsedWorktrees.has(mainWtKey);
								const mainCanFold =
									projectDisplay.children.length > 0 ||
									projectDisplay.hiddenChildCount > 0;
								return (
								<div className="worktree-children worktree-main-header-only">
									<button
										type="button"
										// 与子工作区共用 worktree-row 视觉模型，避免 conversation 网格导致标题/分支挤成一行杂讯。
										className={`worktree-row worktree-main-row${
											activeProjectId === project.id ? " active" : ""
										}${mainSessionsExpanded ? "" : " is-folded"}`}
										// 首次点击：选中主工作区并展开会话；再次点击当前主工作区：折叠/展开会话。
										onClick={() => {
											const wasActive = activeProjectId === project.id;
											setActiveProjectId(project.id);
											setActiveAgentId(undefined);
											if (!projectIsChat && !sessionsByProject[project.id]?.length) {
												void refreshProjectSessions(project.id).catch(() => undefined);
											}
											if (!mainCanFold) return;
											setCollapsedWorktrees((prev) => {
												const next = new Set(prev);
												if (wasActive) {
													if (next.has(mainWtKey)) next.delete(mainWtKey);
													else next.add(mainWtKey);
												} else {
													// 切到主工作区时默认展开，避免“选中了却看不到会话”
													next.delete(mainWtKey);
												}
												return next;
											});
										}}
										title={
											mainCanFold
												? mainSessionsExpanded
													? t("app.projectCollapse")
													: t("app.projectExpand")
												: t("app.worktreeMainWorkspace")
										}
									>
										{mainCanFold && (
											<span
												className={`worktree-fold${mainSessionsExpanded ? "" : " folded"}`}
												aria-hidden="true"
											>
												<ChevronDown size={12} strokeWidth={1.8} />
											</span>
										)}
										<span className="worktree-branch-icon" aria-hidden="true">
											<GitBranch size={12} strokeWidth={1.8} />
										</span>
										<span className="worktree-branch-name">
											{t("app.worktreeMainWorkspace")}
										</span>
										<span className="worktree-branch-chip">
											{branchInfoByProject[project.id]?.current ?? t("app.worktreeBranchLoading")}
										</span>
									</button>
								</div>
								);
							})()}
							{/* 历史会话加载中/失败状态行：慢扫描或失败时提供可见反馈与重试入口，
									避免首次点击后长时间无反馈，用户误以为“没反应”而反复点击。 */}
							{!isCollapsed &&
								projectSessionsLoading &&
								projectDisplay.visibleChildren.length === 0 &&
								projectDisplay.hiddenChildCount === 0 &&
								!(project.worktreeEnabled && collapsedWorktrees.has(`main:${project.id}`)) && (
								<div className="session-card sidebar-session-status">
									<div className="sidebar-session-status-row">
										<span className="conversation-loading" aria-hidden="true" />
										<span>{t("app.projectSessionsLoading")}</span>
									</div>
								</div>
							)}
							{!isCollapsed &&
								!projectSessionsLoading &&
								sessionErrorByProject[project.id] &&
								projectDisplay.visibleChildren.length === 0 &&
								projectDisplay.hiddenChildCount === 0 &&
								!(project.worktreeEnabled && collapsedWorktrees.has(`main:${project.id}`)) && (
								<div className="session-card sidebar-session-status">
									<div className="sidebar-session-status-row error">
										<span className="sidebar-session-error-text">
											{t("app.projectSessionsLoadFailed")}
										</span>
										<button
											className="sidebar-session-retry"
											onClick={() => void refreshProjectSessions(project.id).catch(() => undefined)}
										>
											{t("common.refresh")}
										</button>
									</div>
								</div>
							)}
							{!isCollapsed &&
								(projectDisplay.visibleChildren.length > 0 ||
									projectDisplay.hiddenChildCount > 0) &&
								// worktree 模式下主会话可随主工作区折叠隐藏
								!(project.worktreeEnabled && collapsedWorktrees.has(`main:${project.id}`)) && (
								<div
									className={
										project.worktreeEnabled
											? "session-card worktree-main-sessions"
											: "session-card"
									}
								>
									{projectDisplay.visibleChildren.map((child) => {
									const subagentGroupKey = `${project.id}:${child.key}`;
									const subagentsExpanded = expandedSubagentGroups.has(subagentGroupKey);
									const totalSubagentCount = (child.codexSubagents?.length ?? 0) + (child.piSubagents?.length ?? 0);
									const renderSubagentRow = (
										subagent: SessionSummary,
										label: ReactNode,
										toggle?: ReactNode,
									) => {
										const subagentAgent = getAgentForSessionPath(
											allProjectAgents,
											subagent.filePath,
										);
										return (
											<button
												key={subagent.filePath}
												className={`conversation agent-row session-row codex-subagent-sidebar-row${isSameSessionPath(subagent.filePath, displayedSidebarSessionPath) ? " active" : ""}`}
												title={subagent.filePath}
												onContextMenu={async (event) => {
													event.preventDefault();
													if (subagentAgent) {
														const logging = await window.piDesktop.rpcLogs.getLogging(subagentAgent.id);
														dispatchToAgent(subagentAgent.id, rpcLogActions.set(logging));
														setAgentMenu({
															x: event.clientX,
															y: event.clientY,
															agent: subagentAgent,
														});
														return;
													}
													setSessionMenu({
														x: event.clientX,
														y: event.clientY,
														projectId: project.id,
														session: subagent,
													});
												}}
												onClick={() => {
													if (subagentAgent) {
														setActiveProjectId(subagentAgent.projectId);
														setActiveAgentId(subagentAgent.id);
														ensureAgentMessagesLoaded(subagentAgent.id);
														return;
													}
													void openSidebarSession(project.id, subagent);
												}}
											>
												<div className="conversation-body">
													<div className="conversation-title">
														{label}
														{toggle}
														{subagentAgent?.status && (
															<SidebarStatusDot status={subagentAgent.status} />
														)}
													</div>
													{(subagent.preview || subagent.updatedAt > 0) && (
														<div className="subagent-row-meta">
															{subagent.preview && (
																<span className="subagent-row-preview">{subagent.preview}</span>
															)}
															{subagent.updatedAt > 0 && (
																<span className="subagent-row-time">
																	{formatTime(subagent.updatedAt)}
																</span>
															)}
														</div>
													)}
												</div>
											</button>
										);
									};
									const renderCodexSubagents = (subagents: SessionSummary[]) => {
										if (subagents.length === 0 || !subagentsExpanded) return null;
										return (
											<div className="codex-subagent-sidebar-group">
												{subagents.map((subagent) => renderSubagentRow(
													subagent,
													<>
														<strong>{formatCodexSubagentName(subagent)}</strong>
														<span className="session-source-badge codex subagent">
															{t("app.codexSubagent")}
														</span>
													</>,
												))}
											</div>
										);
									};
									// 递归渲染 pi 子会话树（含孙级）：孙级挂在父子会话行下，不再被孤儿恢复平铺到顶层。
									// 根层展开由父行 toggle（subagentGroupKey）控制，孙级由各自的 toggle 控制。
									const renderPiSubagentTree = (
										subagents: SessionSummary[],
										groupKey: string,
										depth: number,
									): ReactNode => {
										if (subagents.length === 0) return null;
										if (depth > 0 && !expandedSubagentGroups.has(groupKey)) return null;
										return (
											<div className={`codex-subagent-sidebar-group${depth > 0 ? " nested" : ""}`}>
												{subagents.map((subagent) => {
													const subagentKey = normalizeSessionPathForCompare(subagent.filePath) ?? subagent.filePath;
													const grandchildren = projectDisplay.piSubagentsByParent.get(subagentKey) ?? [];
													const grandGroupKey = `${groupKey}:${subagentKey}`;
													const grandExpanded = expandedSubagentGroups.has(grandGroupKey);
													return (
														<Fragment key={subagent.filePath}>
															{renderSubagentRow(
																subagent,
																<strong>{formatPiSubagentName(subagent)}</strong>,
																grandchildren.length > 0 ? (
																	<span
																		className="subagent-inline-toggle"
																		onClick={(e) => {
																			e.stopPropagation();
																			toggleSubagentGroup(grandGroupKey);
																		}}
																		title={t("app.piSubagentCount", { count: grandchildren.length })}
																	>
																		<ChevronDown size={10} className={grandExpanded ? "expanded" : ""} />
																		<span className="subagent-inline-count">{grandchildren.length}</span>
																	</span>
																) : null,
															)}
															{renderPiSubagentTree(grandchildren, grandGroupKey, depth + 1)}
														</Fragment>
													);
												})}
											</div>
										);
									};
									const renderPiSubagents = (subagents: SessionSummary[]) => {
										if (subagents.length === 0 || !subagentsExpanded) return null;
										return renderPiSubagentTree(subagents, subagentGroupKey, 0);
									};
									const renderInlineSubagentToggle = totalSubagentCount > 0 ? (
										<span
											className="subagent-inline-toggle"
											onClick={(e) => {
												e.stopPropagation();
												toggleSubagentGroup(subagentGroupKey);
											}}
											title={t("app.piSubagentCount", { count: totalSubagentCount })}
										>
											<ChevronDown size={10} className={subagentsExpanded ? "expanded" : ""} />
											<span className="subagent-inline-count">{totalSubagentCount}</span>
										</span>
									) : null;
									if (child.type === "agent") {
										const agent = child.agent;
										const isActiveAgent = isSidebarSessionRowActive({
											rowSessionPath: agent.sessionPath,
											displayedSessionPath: displayedSidebarSessionPath,
											rowAgentId: agent.id,
											activeAgentId,
										});
										return (
											<Fragment key={child.key}>
											<button
												className={
													isActiveAgent
														? "conversation agent-row active"
														: "conversation agent-row"
												}
												onContextMenu={async (event) => {
													event.preventDefault();
													// 菜单打开时查询 RPC 日志记录状态
													const logging = await window.piDesktop.rpcLogs.getLogging(agent.id);
													dispatchToAgent(agent.id, rpcLogActions.set(logging));
													setAgentMenu({
														x: event.clientX,
														y: event.clientY,
														agent,
													});
												}}
												onClick={() => {
													setActiveProjectId(project.id);
													setActiveAgentId(agent.id);
													ensureAgentMessagesLoaded(agent.id);
												}}
											>
												<span className="agent-node-marker" aria-hidden="true" />
												<div className="conversation-body">
													<div className="conversation-title">
														<strong>{agent.title}</strong>
														{agent.title.startsWith("AFK: #") && (
															<Badge variant="outline" badgeSize="sm" className="afk-sidebar-badge">
																{t("afk.sidebar.badge")}
															</Badge>
														)}
														{child.source && child.source !== "pi" && (
															<span className={`session-source-badge ${child.source}`}>
																{t(`sessionSource.${child.source}`)}
															</span>
														)}
														{renderInlineSubagentToggle}
														{/* 状态圆点放标题行最右侧，对齐最近会话列表风格 */}
														{agent.status && <SidebarStatusDot status={agent.status} />}
													</div>
												</div>
											</button>
											{renderCodexSubagents(child.codexSubagents)}
											{renderPiSubagents(child.piSubagents)}
											</Fragment>
										);
									}

									const session = child.session;
									return (
										<Fragment key={child.key}>
										<button
											className={`conversation agent-row session-row${isSameSessionPath(session.filePath, displayedSidebarSessionPath) ? " active" : ""}`}
											title={session.filePath}
											onContextMenu={(event) => {
												event.preventDefault();
												setSessionMenu({
													x: event.clientX,
													y: event.clientY,
													projectId: project.id,
													session,
												});
											}}
											onClick={() =>
												void openSidebarSession(project.id, session)
											}
										>
											<span
												className="session-node-marker"
												aria-hidden="true"
											/>
											<div className="conversation-body">
												<div className="conversation-title">
													<strong title={session.name || t("common.untitled")}>
														{session.name || t("common.untitled")}
													</strong>
													{session.source && session.source !== "pi" && (
														<span className={`session-source-badge ${session.source}`}>
															{t(`sessionSource.${session.source}`)}
														</span>
													)}
													{renderInlineSubagentToggle}
												</div>
											</div>
										</button>
										{renderCodexSubagents(child.codexSubagents)}
										{renderPiSubagents(child.piSubagents)}
										</Fragment>
									);
								})}

							{!isCollapsed && projectDisplay.hiddenChildCount > 0 && (
								<button
									className="session-more-row"
									onClick={() => {
										setVisibleProjectChildCountByProject((current) => ({
											...current,
											[project.id]:
												(current[project.id] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE) +
												SIDEBAR_PROJECT_CHILD_PAGE_SIZE,
										}));
									}}
								>
									<span className="agent-more-branch" />
									<span>
										{t("app.projectShowMoreChildren", {
											count: projectDisplay.hiddenChildCount,
										})}
									</span>
								</button>
							)}
								</div>
							)}
							{!isCollapsed && project.worktreeEnabled && (
								<div className="worktree-children worktree-sandbox-list">
									<div className="worktree-sandbox-toolbar">
										<span className="worktree-section-label">
											{t("app.worktreeOtherWorkspaces")}
										</span>
										<button
											type="button"
											className="worktree-create-btn"
											title={t("app.worktreeNew")}
											aria-label={t("app.worktreeNew")}
											onClick={() => {
												setWorktreeCreateDialog({ projectId: project.id });
											}}
										>
											<Plus size={12} strokeWidth={1.8} aria-hidden="true" />
											<span>{t("app.worktreeNewShort")}</span>
										</button>
									</div>
									{projectDerived.worktrees.map((wt) => {
										// 会话/agent 分组已在侧栏投影里算好（折叠 3 条、展开全部，见 sidebarProjection）；
										// 这里只查表：渲染期不再 filter/find，也不再调 getProjectAgentSessionDisplay。
										const childProject = wt.project;
										const wtDisplay = wt.display;
										const wtChildren = wtDisplay?.visibleChildren ?? [];
										const hiddenSessionCount = (wtDisplay?.hiddenChildCount ?? 0);
										// OmpDeck 创建的 worktree 分支使用 ompdeck/{slug} 命名；侧栏只展示 slug。
										// 完整路径放 title，不再行内显示目录名——分支与目录名不一致时会参差不齐。
										const displayBranchName = wt.branch.replace(/^ompdeck\//, "");
										const wtKey = `wt:${wt.path}`;
										// worktree 内 pi 子会话递归渲染（含孙级）：与主侧栏 renderPiSubagentTree 同构，
										// 根层展开由父行 toggle 控制，孙级由各自 toggle 控制。
										const renderWtPiSubagentTree = (
											childProjectId: string,
											subagents: SessionSummary[],
											groupKey: string,
											depth: number,
										): ReactNode => {
											if (subagents.length === 0) return null;
											if (depth > 0 && !expandedSubagentGroups.has(groupKey)) return null;
											return (
												<div className={`codex-subagent-sidebar-group${depth > 0 ? " nested" : ""}`}>
													{subagents.map((sa) => {
														const saKey = normalizeSessionPathForCompare(sa.filePath) ?? sa.filePath;
														const grandchildren = wtDisplay?.piSubagentsByParent.get(saKey) ?? [];
														const grandGroupKey = `${groupKey}:${saKey}`;
														const grandExpanded = expandedSubagentGroups.has(grandGroupKey);
														return (
															<Fragment key={sa.filePath}>
																<button
																	className={`conversation agent-row session-row codex-subagent-sidebar-row${isSameSessionPath(sa.filePath, displayedSidebarSessionPath) ? " active" : ""}`}
																	title={sa.filePath}
																	onClick={() => void openSidebarSession(childProjectId, sa)}
																>
																	<div className="conversation-body">
																		<div className="conversation-title">
																			<strong>{formatPiSubagentName(sa)}</strong>
																			{grandchildren.length > 0 && (
																				<span
																					className="subagent-inline-toggle"
																					onClick={(e) => {
																						e.stopPropagation();
																						toggleSubagentGroup(grandGroupKey);
																					}}
																					title={t("app.piSubagentCount", { count: grandchildren.length })}
																				>
																					<ChevronDown size={10} className={grandExpanded ? "expanded" : ""} />
																					<span className="subagent-inline-count">{grandchildren.length}</span>
																				</span>
																			)}
																		</div>
																		{(sa.preview || sa.updatedAt > 0) && (
																			<div className="subagent-row-meta">
																				{sa.preview && <span className="subagent-row-preview">{sa.preview}</span>}
																				{sa.updatedAt > 0 && <span className="subagent-row-time">{formatTime(sa.updatedAt)}</span>}
																			</div>
																		)}
																	</div>
																</button>
																{renderWtPiSubagentTree(childProjectId, grandchildren, grandGroupKey, depth + 1)}
															</Fragment>
														);
													})}
												</div>
											);
										};
										const isChildActive =
											!!childProject && activeProjectId === childProject.id;
										const canFoldWorkspace = wt.canFold;
										const workspaceSessionsOpen = !collapsedWorktrees.has(wtKey);
										// 折叠时不渲染会话树；展开时仍沿用 3 条 +「查看更多」策略
										const hasNestedChildren =
											workspaceSessionsOpen &&
											(wtChildren.length > 0 || hiddenSessionCount > 0);
										return (
											// 每个子工作区自含子树：header + 会话/Agent，避免与兄弟 worktree 扁平混排
											<div
												key={wt.path}
												className={`worktree-group${
													isChildActive ? " is-active-group" : ""
												}${removingWorktreePaths.has(wt.path) ? " worktree-removing" : ""}`}
											>
												<button
													type="button"
													className={`worktree-row${isChildActive ? " active" : ""}${workspaceSessionsOpen ? "" : " is-folded"}`}
													onClick={() => {
														if (!childProject) return;
														const wasActive = activeProjectId === childProject.id;
														setActiveProjectId(childProject.id);
														setActiveAgentId(undefined);
														if (!sessionsByProject[childProject.id]?.length) {
															void refreshProjectSessions(childProject.id).catch(() => undefined);
														}
														// 首次点中：选中并展开；再次点击当前工作区：折叠/展开会话
														if (!canFoldWorkspace) return;
														setCollapsedWorktrees((prev) => {
															const next = new Set(prev);
															if (wasActive) {
																if (next.has(wtKey)) next.delete(wtKey);
																else next.add(wtKey);
															} else {
																next.delete(wtKey);
															}
															return next;
														});
													}}
													onContextMenu={(e) => {
														e.preventDefault();
														if (childProject) {
															setProjectMenu({
																x: e.clientX,
																y: e.clientY,
																project: childProject,
															});
														}
													}}
													title={wt.path}
												>
													{canFoldWorkspace && (
														<span
															className={`worktree-fold${workspaceSessionsOpen ? "" : " folded"}`}
															aria-hidden="true"
														>
															<ChevronDown size={12} strokeWidth={1.8} />
														</span>
													)}
													<span className="worktree-branch-icon" aria-hidden="true">
														<GitBranch size={12} strokeWidth={1.8} />
													</span>
													<span className="worktree-branch-name">{displayBranchName}</span>
													{childProject && (
														// 子工作区直接新建 Agent，免去先选中再从别处创建的绕路操作。
														<span
															className="project-action worktree-new-agent"
															onClick={(e) => {
																e.stopPropagation();
																void createAgent(childProject.id);
															}}
															title={t("app.projectNewAgent")}
														>
															<Plus size={12} strokeWidth={1.8} />
														</span>
													)}
													{childProject && (
														<span
															className="project-action worktree-remove"
															onClick={(e) => {
																e.stopPropagation();
																requestRemoveWorktree(project.id, wt.path, childProject);
															}}
															title={t("menu.removeProject")}
														>
															<Trash2 size={12} strokeWidth={1.8} />
														</span>
													)}
												</button>
												{hasNestedChildren && childProject !== undefined && (
												<div className="worktree-group-body">
												{wtChildren.filter(c => c.type === "agent").map((item) => {
													const agent = item.agent;
													const totalSubagentCount = (item.codexSubagents?.length ?? 0) + (item.piSubagents?.length ?? 0);
													const subagentGroupKey = `wt:${childProject.id}:${item.key}`;
													const subagentExpanded = expandedSubagentGroups.has(subagentGroupKey);
													return (
														<Fragment key={item.key}>
															<button
																className={`conversation agent-row worktree-nested-row${isSidebarSessionRowActive({
																	rowSessionPath: agent.sessionPath,
																	displayedSessionPath: displayedSidebarSessionPath,
																	rowAgentId: agent.id,
																	activeAgentId,
																}) ? " active" : ""}`}
																onContextMenu={async (event) => {
																	event.preventDefault();
																	const logging = await window.piDesktop.rpcLogs.getLogging(agent.id);
																	dispatchToAgent(agent.id, rpcLogActions.set(logging));
																	setAgentMenu({ x: event.clientX, y: event.clientY, agent });
																}}
																onClick={() => { setActiveProjectId(agent.projectId); setActiveAgentId(agent.id); ensureAgentMessagesLoaded(agent.id); }}
															>
																<span className="agent-node-marker" aria-hidden="true" />
																<div className="conversation-body">
																	<div className="conversation-title">
																		<strong>{agent.title}</strong>
																		{agent.title.startsWith("AFK: #") && (
																			<Badge variant="outline" badgeSize="sm" className="afk-sidebar-badge">
																				{t("afk.sidebar.badge")}
																			</Badge>
																		)}
																		{agent.noSession && (
																			<span
																				className="anonymous-indicator"
																				title={t("app.anonymousChat")}
																			>
																				<HatGlasses size={11} />
																			</span>
																		)}
																		{totalSubagentCount > 0 && (
																			<span className="subagent-inline-toggle" onClick={(e) => { e.stopPropagation(); toggleSubagentGroup(subagentGroupKey); }} title={t("app.piSubagentCount", { count: totalSubagentCount })}>
																				<ChevronDown size={10} className={subagentExpanded ? "expanded" : ""} />
																				<span className="subagent-inline-count">{totalSubagentCount}</span>
																			</span>
																		)}
																		{/* 状态圆点放标题行最右侧，对齐最近会话列表风格 */}
																		{agent.status && <SidebarStatusDot status={agent.status} />}
																	</div>
																</div>
															</button>
															{subagentExpanded && item.codexSubagents?.length > 0 && (
																<div className="codex-subagent-sidebar-group">
																	{item.codexSubagents.map((sa) => (
																		<button key={sa.filePath} className={`conversation agent-row session-row codex-subagent-sidebar-row${isSameSessionPath(sa.filePath, displayedSidebarSessionPath) ? " active" : ""}`} title={sa.filePath} onClick={() => void openSidebarSession(childProject.id, sa)}>
																			<div className="conversation-body"><div className="conversation-title"><strong>{formatCodexSubagentName(sa)}</strong><span className="session-source-badge codex subagent">{t("app.codexSubagent")}</span></div></div>
																		</button>
																	))}
																</div>
															)}
															{subagentExpanded && item.piSubagents?.length > 0 && (
																renderWtPiSubagentTree(childProject.id, item.piSubagents, subagentGroupKey, 0)
															)}
														</Fragment>
													);
												})}
												{wtChildren.filter(c => c.type === "session").map((item) => {
													const session = item.session;
													const totalSubagentCount = (item.codexSubagents?.length ?? 0) + (item.piSubagents?.length ?? 0);
													const subagentGroupKey = `wt:${childProject.id}:${item.key}`;
													const subagentExpanded = expandedSubagentGroups.has(subagentGroupKey);
													return (
														<Fragment key={item.key}>
															<button
																className={`conversation agent-row session-row worktree-nested-row${isSameSessionPath(session.filePath, displayedSidebarSessionPath) ? " active" : ""}`}
																title={session.filePath}
																onClick={() => void openSidebarSession(childProject.id, session)}
															>
																<span className="session-node-marker" aria-hidden="true" />
																<div className="conversation-body">
																	<div className="conversation-title">
																		<strong title={session.name || t("common.untitled")}>{session.name || t("common.untitled")}</strong>
																		{totalSubagentCount > 0 && (
																			<span className="subagent-inline-toggle" onClick={(e) => { e.stopPropagation(); toggleSubagentGroup(subagentGroupKey); }} title={t("app.piSubagentCount", { count: totalSubagentCount })}>
																				<ChevronDown size={10} className={subagentExpanded ? "expanded" : ""} />
																				<span className="subagent-inline-count">{totalSubagentCount}</span>
																			</span>
																		)}
																	</div>
																</div>
															</button>
															{subagentExpanded && item.codexSubagents?.length > 0 && (
																<div className="codex-subagent-sidebar-group">
																	{item.codexSubagents.map((sa) => (
																		<button key={sa.filePath} className={`conversation agent-row session-row codex-subagent-sidebar-row${isSameSessionPath(sa.filePath, displayedSidebarSessionPath) ? " active" : ""}`} title={sa.filePath} onClick={() => void openSidebarSession(childProject.id, sa)}>
																			<div className="conversation-body"><div className="conversation-title"><strong>{formatCodexSubagentName(sa)}</strong><span className="session-source-badge codex subagent">{t("app.codexSubagent")}</span></div></div>
																		</button>
																	))}
																</div>
															)}
															{subagentExpanded && item.piSubagents?.length > 0 && (
																renderWtPiSubagentTree(childProject.id, item.piSubagents, subagentGroupKey, 0)
															)}
														</Fragment>
													);
												})}
												{hiddenSessionCount > 0 && (
													<button
														type="button"
														className="worktree-sessions-more"
														onClick={() => {
															setExpandedWorktreeSessions((prev) => {
																const next = new Set(prev);
																next.add(wt.path);
																return next;
															});
														}}
													>
														{t("app.worktreeShowMoreSessions", { count: hiddenSessionCount })}
													</button>
												)}
												</div>
												)}
											</div>
										);
									})}
								</div>
							)}
						</div>
					);
				})}
			</div>
			{!isLanWeb && (
				<div className="toolbar-actions sidebar-bottom-actions">
					<div className="sidebar-bottom-primary-actions">
						<button
							className="icon-button settings-icon"
							title={t("settings.title")}
							onClick={() => setSettingsOpen(true)}
						>
							<Settings size={17} />
						</button>
						<button
							className="icon-button config-icon"
							title={t("config.title")}
							onClick={() => setConfigOpen(true)}
						>
							<Sliders size={17} />
						</button>
						<button
							className="icon-button feedback-icon"
							title={t("feedback.title")}
							onClick={() => setFeedbackOpen(true)}
						>
							<MessageSquare size={17} />
						</button>
						<button
							className="icon-button afk-icon"
							title={t("afk.openCenter")}
							aria-label={t("afk.openCenter")}
							onClick={() => setAfkOpen(true)}
						>
							<Bot size={17} />
						</button>
						<button
							className="icon-button homepage-icon"
							title={t("app.homepage")}
							onClick={() => api.app.openExternal("https://github.com/HiHaWarzid/OmpDeck/")}
						>
							<Globe size={17} />
						</button>
					</div>

				</div>
			)}
			</div>
		</aside>
	);
}

/**
 * 侧栏树：memo 边界。props 引用未变时 React 直接复用上一次的元素树，
 * App 根因抽屉/弹框/输入等无关状态重渲染时不再重算这棵近千行的子树。
 */
export const SidebarTree = memo(SidebarTreeView);
