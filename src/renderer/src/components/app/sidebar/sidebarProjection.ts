import type {
	AgentTab,
	Project,
	SessionSummary,
	WorktreeEntry,
} from "../../../../../shared/types";
import {
	getProjectAgentSessionDisplay,
	type ProjectAgentSessionDisplay,
} from "../../../agentListDisplay";
import { matches } from "../AppUtils";

/**
 * 侧栏行投影（批次 5c）：搜索/来源过滤、会话分组排序、worktree 行解析全部收敛到这里，
 * 组件只按 projectId 查表渲染，渲染期不再做任何 filter/find/分组。
 *
 * 迁移前 worktree 分支在渲染体内联重算：每个项目 `projects.filter` 找子项目、
 * 每个 worktree 行 `projects.find` 按路径找项目、每行 `filteredAgents.filter` +
 * `getProjectAgentSessionDisplay`，整体约 O(P² + P·A + P·W·S log S)，且随 App 根
 * 每次渲染（流式 20Hz）重跑。现在：索引一次（O(P)）+ 按输入依赖 memo（O(1) 查表）。
 *
 * 纯函数、零 React，便于单测；调用方负责 memo。
 */

/** 会话来源过滤集合：null 或缺键 = 显示全部来源。 */
export type SessionSource = NonNullable<SessionSummary["source"]>;

/** 折叠时子工作区最多展示的会话条数（展开后展示全部），沿用迁移前内联字面量。 */
export const WORKTREE_COLLAPSED_SESSION_LIMIT = 3;

/** 侧栏主列表每页子项数（「查看更多」每次追加一页）。 */
export const SIDEBAR_PROJECT_CHILD_PAGE_SIZE = 5;

// 共享空值：投影表用不到的键 / 空会话列表兜底，避免每次 .get() miss 都新建引用。
export const EMPTY_AGENTS: AgentTab[] = Object.freeze([]) as unknown as AgentTab[];
// 无会话项目的共享空数组；冻结防止任何路径写坏这份共享默认值。
const EMPTY_SESSIONS: SessionSummary[] = Object.freeze([]) as unknown as SessionSummary[];
export const EMPTY_PROJECT_DISPLAY: ProjectAgentSessionDisplay = Object.freeze({
	children: [],
	visibleChildren: [],
	hiddenChildCount: 0,
	piSubagentsByParent: new Map(),
});

/** 一个 worktree 行（子工作区）：解析后的展示数据，组件不再二次计算。 */
export interface SidebarWorktreeRow {
	/** worktree 路径，兼作行 key。 */
	path: string;
	/** 分支名（可能带 ompdeck/ 前缀，展示时由组件去前缀）。 */
	branch: string;
	/** 已注册的子项目；未注册的外部 worktree 为 undefined（行仍展示，只是不可进入）。 */
	project?: Project;
	/** 子项目会话分组投影；无子项目时为 undefined（无嵌套子树）。 */
	display?: ProjectAgentSessionDisplay;
	/** 是否可折叠：有 agent 或会话才给折叠箭头。 */
	canFold: boolean;
}

/** 一个项目行的全部展示数据。 */
export interface SidebarProjectRow {
	/** 会话 + agent 的分组排序投影（已含搜索/来源过滤结果）。 */
	display: ProjectAgentSessionDisplay;
	/** 子工作区行；非 worktree 项目为空数组。 */
	worktrees: SidebarWorktreeRow[];
}

export interface SidebarProjectDisplayInput {
	/** 全量项目：worktree 子项目查表用（子项目不在主列表里）。 */
	projects: Project[];
	/** 主列表项目（已按搜索过滤，已排除 worktree 子项目）。 */
	visibleProjects: Project[];
	sessionsByProject: Record<string, SessionSummary[]>;
	/** 按 projectId 预分桶的 agent（已按搜索过滤）。 */
	agentsByProject: ReadonlyMap<string, AgentTab[]>;
	/** 原始搜索词（内部 trim 后使用）。 */
	search: string;
	sourceFilter: Record<string, Set<SessionSource> | null>;
	visibleChildCountByProject: Record<string, number>;
	worktreesByProject: Record<string, WorktreeEntry[]>;
	expandedWorktreeSessions: ReadonlySet<string>;
}

/**
 * 构建侧栏项目投影：主列表会话过滤 + 分组排序 + worktree 行解析。
 * 索引一次项目表（按路径 / 按父项目），替换原先每行一次的全量 find。
 */
export function buildSidebarProjectDisplay(
	input: SidebarProjectDisplayInput,
): Record<string, SidebarProjectRow> {
	const {
		projects,
		visibleProjects,
		sessionsByProject,
		agentsByProject,
		search,
		sourceFilter,
		visibleChildCountByProject,
		worktreesByProject,
		expandedWorktreeSessions,
	} = input;
	const projectSearch = search.trim();

	const projectsByPath = new Map<string, Project>();
	const childProjectsByParentId = new Map<string, Project[]>();
	for (const project of projects) {
		// 同一路径多个项目时保留先出现的那个：与迁移前的 projects.find 首匹配语义一致
		if (!projectsByPath.has(project.path)) projectsByPath.set(project.path, project);
		if (!project.worktreeParentId) continue;
		const siblings = childProjectsByParentId.get(project.worktreeParentId);
		if (siblings) siblings.push(project);
		else childProjectsByParentId.set(project.worktreeParentId, [project]);
	}

	const result: Record<string, SidebarProjectRow> = {};
	for (const project of visibleProjects) {
		const rawSessions = sessionsByProject[project.id] ?? EMPTY_SESSIONS;
		const projectSessions = (
			projectSearch
				? rawSessions.filter((session) =>
						matches(
							`${session.name ?? ""}${session.preview}${session.filePath}`,
							projectSearch,
						),
					)
				: rawSessions
		).filter((session) => {
			const filter = sourceFilter[project.id] ?? null;
			return filter === null ? true : filter.has(session.source ?? "pi");
		});
		const projectAgents = agentsByProject.get(project.id) ?? EMPTY_AGENTS;
		const visibleChildCount =
			visibleChildCountByProject[project.id] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE;

		const worktrees: SidebarWorktreeRow[] = [];
		if (project.worktreeEnabled) {
			// 合并 git worktree 列表与已注册子项目：外部 worktree 也要有行。
			// 保留 git 列表原样（含重复路径，与原实现一致），只用路径集合去重补录的子项目。
			const entries: WorktreeEntry[] = [...(worktreesByProject[project.id] ?? [])];
			const entryPaths = new Set(entries.map((entry) => entry.path));
			for (const child of childProjectsByParentId.get(project.id) ?? []) {
				if (entryPaths.has(child.path)) continue;
				entryPaths.add(child.path);
				entries.push({ path: child.path, branch: child.name });
			}
			for (const entry of entries) {
				const childProject = projectsByPath.get(entry.path);
				const childSessions = childProject
					? (sessionsByProject[childProject.id] ?? EMPTY_SESSIONS)
					: EMPTY_SESSIONS;
				const childAgents = childProject
					? (agentsByProject.get(childProject.id) ?? EMPTY_AGENTS)
					: EMPTY_AGENTS;
				worktrees.push({
					path: entry.path,
					branch: entry.branch,
					project: childProject,
					display: childProject
						? getProjectAgentSessionDisplay({
								agents: childAgents,
								sessions: childSessions,
								// 折叠只给 3 条 +「查看更多」；展开后一次给全
								visibleChildCount: expandedWorktreeSessions.has(entry.path)
									? Number.MAX_SAFE_INTEGER
									: WORKTREE_COLLAPSED_SESSION_LIMIT,
							})
						: undefined,
					canFold: childAgents.length > 0 || childSessions.length > 0,
				});
			}
		}

		result[project.id] = {
			display: getProjectAgentSessionDisplay({
				agents: projectAgents,
				sessions: projectSessions,
				visibleChildCount,
			}),
			worktrees,
		};
	}
	return result;
}
