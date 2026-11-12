import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "./usePersistedState";
import { SIDEBAR_PROJECT_CHILD_PAGE_SIZE } from "../components/app/sidebar/sidebarProjection";
import type {
  AppSettings,
  GitBranchInfo,
  Project,
  SessionSummary,
  WorktreeEntry,
} from "../../../shared/types";

/**
 * 侧栏项目树状态（Project tree）。
 *
 * 迁出原因：展开集合、worktree 列表/分支、workspace 折叠、会话来源过滤、拖拽与
 * 删除确认原来分散在 App() 的 9k 行函数里；其中「settings.json 是权威来源」「旧
 * collapsed key 一次性迁移」「已删除项目要裁剪」「默认只展开 chat」这些规则
 * 没有测试入口，只能靠手点验证。收进这里后，规则可以用假 api + 假 localStorage 跑。
 *
 * 接口约定：
 * - 展开集合只有三个写入口：`setProjectSidebarExpanded`（用户点击）、
 *   `applyExpandedFromSettings`（settings 加载）、内部裁剪/迁移；避免绕过双写持久化。
 * - `refreshWorktrees` 会回读项目表（worktree 会注册成子项目），通过 `setProjects` 回灌。
 * - 会话列表本身不归本模块所有：展开后补加载走注入的 `refreshProjectSessions`。
 */

const SIDEBAR_EXPANDED_PROJECTS_KEY = "pid:sidebar-expanded-projects";
const SIDEBAR_COLLAPSED_PROJECTS_LEGACY_KEY = "pid:sidebar-collapsed-projects";
const SUBAGENT_GROUPS_STORAGE_KEY = "pid:sidebar-expanded-subagent-groups";
const SESSION_SOURCE_FILTER_KEY = "pideck-session-source-filter";
/** 与主进程 ProjectStore 内置 chat id 保持一致 */
const BUILTIN_CHAT_PROJECT_ID = "builtin-chat";

export type SessionSource = "pi" | "codex" | "claude" | "opencode";
export type SessionSourceFilter = Record<string, Set<SessionSource> | null>;

const isProjectId = (value: unknown): value is string => typeof value === "string";

/** localStorage 里的展开集合/子会话组共享的解析：非数组视为无效存储，回退默认值。 */
function parseIdSet(raw: unknown): Set<string> | undefined {
  if (!Array.isArray(raw)) return undefined;
  return new Set(raw.filter(isProjectId));
}

const serializeIdSet = (ids: Set<string>) => [...ids];

/** 会话来源过滤的存储形状：项目 id → 来源数组（null 表示该项目显式清空过滤）。 */
function parseSourceFilter(raw: unknown): SessionSourceFilter | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: SessionSourceFilter = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val === null) result[key] = null;
    else if (Array.isArray(val)) result[key] = new Set(val.filter(isProjectId) as SessionSource[]);
  }
  return result;
}

function serializeSourceFilter(filter: SessionSourceFilter) {
  const obj: Record<string, string[] | null> = {};
  for (const [key, val] of Object.entries(filter)) {
    obj[key] = val === null ? null : [...val];
  }
  return obj;
}

/** 默认只展开内置 chat，与「启动不全量扫会话」策略一致 */
function defaultExpandedSidebarProjects(): Set<string> {
  return new Set([BUILTIN_CHAT_PROJECT_ID]);
}

/** 旧版折叠 key 存在且新 key 缺失 → 需要反演迁移（缺项目全集时暂不处理）。 */
function readLegacyCollapsedProjectIds(): string[] | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_COLLAPSED_PROJECTS_LEGACY_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isProjectId) : null;
  } catch {
    return null;
  }
}

/** 迁移/写新 key 后清掉旧折叠 key，避免两套数据源互相打架。 */
function clearLegacyCollapsedProjects() {
  try {
    localStorage.removeItem(SIDEBAR_COLLAPSED_PROJECTS_LEGACY_KEY);
  } catch {
    // 忽略：旧 key 残留不影响新 key 的优先级
  }
}

type ProjectTreeApi = {
  settings: { update: (patch: Partial<AppSettings>) => Promise<AppSettings> };
  git: {
    worktreeList: (projectId: string) => Promise<WorktreeEntry[]>;
    branches: (projectId: string) => Promise<GitBranchInfo>;
  };
  projects: { list: () => Promise<Project[]> };
};

export interface ProjectTreeDeps {
  api: ProjectTreeApi;
  projects: Project[];
  /** 已按项目分组的会话：展开项目时用它判断是否需要补加载。 */
  sessionsByProject: Record<string, SessionSummary[]>;
  refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<unknown>;
  setProjects: (next: Project[]) => void;
  /** settings.update 成功后的字段回灌（只合并 sidebarExpandedProjectIds）。 */
  onExpandedPersisted: (ids: string[]) => void;
  activeProjectId: string | undefined;
}

export interface ProjectTree {
  // 展开集合
  expandedSidebarProjects: Set<string>;
  setProjectSidebarExpanded: (
    projectId: string,
    forceExpand?: boolean,
  ) => Set<string>;
  /** settings 加载完成后调用：settings.json 为权威来源，覆盖 localStorage 首屏值。 */
  applyExpandedFromSettings: (ids: string[]) => void;
  /** 读取当前展开集合的权威值（供流式回调等非 React 路径使用，避免陈旧闭包）。 */
  getExpandedProjectIds: () => Set<string>;
  // worktree / 分支
  worktreesByProject: Record<string, WorktreeEntry[]>;
  branchInfoByProject: Record<string, GitBranchInfo>;
  /** 写入某项目的分支快照（checkout/createBranch 的返回值直接落地）。 */
  setBranchInfo: (projectId: string, info: GitBranchInfo) => void;
  /** 拉取并落地某项目的分支列表；失败落空信息，返回值可直接用。 */
  refreshBranchInfo: (projectId: string) => Promise<GitBranchInfo>;
  /** 无活动项目时清空分支 store。 */
  resetBranchInfo: () => void;
  refreshWorktrees: (projectId: string) => Promise<void>;
  // 侧栏折叠与拖拽
  collapsedWorktrees: Set<string>;
  setCollapsedWorktrees: React.Dispatch<React.SetStateAction<Set<string>>>;
  expandedWorktreeSessions: Set<string>;
  setExpandedWorktreeSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  removingWorktreePaths: Set<string>;
  setRemovingWorktreePaths: React.Dispatch<React.SetStateAction<Set<string>>>;
  draggingProjectId: string | undefined;
  setDraggingProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  dragOverProjectId: string | undefined;
  setDragOverProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  // 分页 / 过滤 / 子会话组
  visibleProjectChildCountByProject: Record<string, number>;
  noteProjectSessionsChanged: (projectId: string) => void;
  /** 「显示更多」：按固定页大小追加侧栏可见子项数。 */
  showMoreProjectChildren: (projectId: string) => void;
  /** 项目被删除时立即清掉它的分页/可见子项行（不必等项目列表回推）。 */
  forgetProject: (projectId: string) => void;
  sessionSourceFilter: SessionSourceFilter;
  setSessionSourceFilter: React.Dispatch<React.SetStateAction<SessionSourceFilter>>;
  expandedSubagentGroups: Set<string>;
  toggleSubagentGroup: (key: string) => void;
  // 确认弹框
  sidebarDeleteConfirm: { session: SessionSummary; childCount: number } | null;
  setSidebarDeleteConfirm: React.Dispatch<
    React.SetStateAction<{ session: SessionSummary; childCount: number } | null>
  >;
  worktreeCreateDialog: { projectId: string } | null;
  setWorktreeCreateDialog: React.Dispatch<
    React.SetStateAction<{ projectId: string } | null>
  >;
  worktreeCreating: boolean;
  setWorktreeCreating: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useProjectTree(deps: ProjectTreeDeps): ProjectTree {
  const {
    api,
    projects,
    sessionsByProject,
    refreshProjectSessions,
    setProjects,
    onExpandedPersisted,
    activeProjectId,
  } = deps;

  const [worktreesByProject, setWorktreesByProject] = useState<
    Record<string, WorktreeEntry[]>
  >({});
  // 统一分支信息 store（按 projectId）：合并原 gitInfo（当前项目全量）与
  // branchByProject（各项目 current）两个平行切片；composer 分支展示、worktree
  // 分支 chip 统一读取，GitPanel 面板分支由面板自持（initialBranchInfo 种子）。
  const [branchInfoByProject, setBranchInfoByProject] = useState<
    Record<string, GitBranchInfo>
  >({});
  const [draggingProjectId, setDraggingProjectId] = useState<string>();
  const [dragOverProjectId, setDragOverProjectId] = useState<string>();
  const [visibleProjectChildCountByProject, setVisibleProjectChildCountByProject] =
    useState<Record<string, number>>({});
  // 侧栏展开集合：有 id = 展开。localStorage 首屏缓存 + settings.json 可靠落盘（dev 强杀也不丢）。
  // usePersistedState 提供同步 ref 镜像：IPC 回调/迁移逻辑可立即读到最新值，不等渲染。
  const [expandedSidebarProjects, setExpandedSidebarProjects, expandedSidebarProjectsRef] =
    usePersistedState<Set<string>>(
      SIDEBAR_EXPANDED_PROJECTS_KEY,
      defaultExpandedSidebarProjects(),
      { parse: parseIdSet, serialize: serializeIdSet },
    );
  /** settings.json 是否已成为展开集合的权威写入（防止迟到的启动读覆盖用户点击） */
  const expandedSidebarFromSettingsRef = useRef(false);

  const [sidebarDeleteConfirm, setSidebarDeleteConfirm] = useState<{
    session: SessionSummary;
    childCount: number;
  } | null>(null);
  const [worktreeCreateDialog, setWorktreeCreateDialog] = useState<{
    projectId: string;
  } | null>(null);
  const [worktreeCreating, setWorktreeCreating] = useState(false);
  /** 展开会话的 worktree 路径集合：默认子工作区只展示 3 条会话，展开后显示全部 */
  const [expandedWorktreeSessions, setExpandedWorktreeSessions] = useState<
    Set<string>
  >(() => new Set());
  /**
   * 折叠的工作区 key 集合（main:${projectId} / wt:${path}）。
   * 默认展开；再次点击当前工作区时切换折叠，切换到其他工作区时自动展开目标。
   */
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(
    () => new Set(),
  );
  /** 正在被删除的 worktree 路径集合：触发淡出动画期间保留 DOM，动画结束后才移除。 */
  const [removingWorktreePaths, setRemovingWorktreePaths] = useState<Set<string>>(
    () => new Set(),
  );
  /** 历史会话来源过滤（按项目）：Record 含项目ID对应 Set；null = 该项目的过滤被清空 */
  const [sessionSourceFilter, setSessionSourceFilter] = usePersistedState<SessionSourceFilter>(
    SESSION_SOURCE_FILTER_KEY,
    {},
    { parse: parseSourceFilter, serialize: serializeSourceFilter },
  );
  /** 侧栏子会话展开状态（统一管理 Codex 子代理和 pi 子会话），localStorage 持久化 */
  const [expandedSubagentGroups, setExpandedSubagentGroups] = usePersistedState<Set<string>>(
    SUBAGENT_GROUPS_STORAGE_KEY,
    new Set<string>(),
    { parse: parseIdSet, serialize: serializeIdSet },
  );

  /**
   * 更新侧栏展开集合并双写持久化：
   * 1) localStorage：同步，首屏可读
   * 2) settings.json：主进程 writeFile，dev 强杀/重启也不丢
   */
  const commitExpandedSidebarProjects = useCallback(
    (next: Set<string>) => {
      // 标记已有权威写入，防止启动时迟到的 settings.get 用旧值覆盖用户刚点的展开
      expandedSidebarFromSettingsRef.current = true;
      setExpandedSidebarProjects(next);
      clearLegacyCollapsedProjects();
      void api.settings
        .update({ sidebarExpandedProjectIds: [...next] })
        .then((saved) => {
          onExpandedPersisted(saved.sidebarExpandedProjectIds ?? [...next]);
        })
        .catch(() => undefined);
    },
    [api, onExpandedPersisted],
  );

  /** 展开/折叠某个项目；forceExpand=true 时只展开不切换 */
  const setProjectSidebarExpanded = useCallback(
    (projectId: string, forceExpand?: boolean) => {
      const prev = expandedSidebarProjectsRef.current;
      const next = new Set(prev);
      const shouldExpand = forceExpand ?? !next.has(projectId);
      if (shouldExpand) next.add(projectId);
      else next.delete(projectId);
      const unchanged = next.size === prev.size && [...next].every((id) => prev.has(id));
      if (unchanged) return next;
      commitExpandedSidebarProjects(next);
      return next;
    },
    [commitExpandedSidebarProjects],
  );

  const applyExpandedFromSettings = useCallback((ids: string[]) => {
    if (expandedSidebarFromSettingsRef.current) return;
    expandedSidebarFromSettingsRef.current = true;
    const fromSettings = new Set(ids.filter(isProjectId));
    setExpandedSidebarProjects(fromSettings);
    clearLegacyCollapsedProjects();
  }, []);

  const getExpandedProjectIds = useCallback(
    () => expandedSidebarProjectsRef.current,
    [],
  );

  const setBranchInfo = useCallback((projectId: string, info: GitBranchInfo) => {
    setBranchInfoByProject((prev) => ({ ...prev, [projectId]: info }));
  }, []);

  const refreshBranchInfo = useCallback(
    async (projectId: string) => {
      const info = await api.git
        .branches(projectId)
        .catch(() => ({ current: null, branches: [] }));
      setBranchInfoByProject((prev) => ({ ...prev, [projectId]: info }));
      return info;
    },
    [api],
  );

  const resetBranchInfo = useCallback(() => setBranchInfoByProject({}), []);

  /** worktree 刷新：条目 + 分支一起取；失败时清空该项目的 worktree 列表。 */
  const refreshWorktrees = useCallback(
    async (projectId: string) => {
      try {
        const [entries, branchInfo] = await Promise.all([
          api.git.worktreeList(projectId),
          api.git.branches(projectId).catch(() => ({ current: null, branches: [] })),
        ]);
        setWorktreesByProject((prev) => ({ ...prev, [projectId]: entries }));
        setBranchInfoByProject((prev) => ({ ...prev, [projectId]: branchInfo }));
        // 刷新项目列表（可能已有新注册的 worktree 子项目）
        setProjects(await api.projects.list());
      } catch {
        setWorktreesByProject((prev) => ({ ...prev, [projectId]: [] }));
      }
    },
    [api, setProjects],
  );

  /** 项目会话变化后确保侧栏可见子项数存在（分页「显示更多」的当前页大小）。 */
  const noteProjectSessionsChanged = useCallback((projectId: string) => {
    setVisibleProjectChildCountByProject((current) => ({
      ...current,
      [projectId]: current[projectId] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE,
    }));
  }, []);

  const showMoreProjectChildren = useCallback((projectId: string) => {
    setVisibleProjectChildCountByProject((current) => ({
      ...current,
      [projectId]:
        (current[projectId] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE) +
        SIDEBAR_PROJECT_CHILD_PAGE_SIZE,
    }));
  }, []);

  const forgetProject = useCallback((projectId: string) => {
    setVisibleProjectChildCountByProject((current) => {
      if (!(projectId in current)) return current;
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  }, []);

  const toggleSubagentGroup = useCallback(
    (key: string) => {
      setExpandedSubagentGroups((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [setExpandedSubagentGroups],
  );

  const projectIdsKey = useMemo(
    () => projects.map((project) => project.id).join("\n"),
    [projects],
  );
  const sessionsByProjectRef = useRef(sessionsByProject);
  sessionsByProjectRef.current = sessionsByProject;
  const refreshProjectSessionsRef = useRef(refreshProjectSessions);
  refreshProjectSessionsRef.current = refreshProjectSessions;

  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    setVisibleProjectChildCountByProject((current) => {
      // 无键被删时返回原引用：项目列表刷新（内容未变）不触发侧栏重渲染。
      let changed = false;
      const next: Record<string, number> = {};
      for (const [key, value] of Object.entries(current)) {
        if (projectIds.has(key)) next[key] = value;
        else changed = true;
      }
      return changed ? next : current;
    });

    if (projects.length === 0) return;

    // 旧版 collapsed key → expanded 迁移（仅一次）
    const legacyCollapsed = readLegacyCollapsedProjectIds();
    const hasExpandedCache =
      localStorage.getItem(SIDEBAR_EXPANDED_PROJECTS_KEY) !== null;
    if (legacyCollapsed && !hasExpandedCache && !expandedSidebarFromSettingsRef.current) {
      const migrated = new Set(
        projects
          .map((project) => project.id)
          .filter((id) => !legacyCollapsed.includes(id)),
      );
      // 至少保留 chat，避免迁移后侧栏全空
      if (projectIds.has(BUILTIN_CHAT_PROJECT_ID)) migrated.add(BUILTIN_CHAT_PROJECT_ID);
      commitExpandedSidebarProjects(migrated);
      return;
    }

    // 修剪已删除项目 id，不自动展开新建项目，也不把用户主动折叠的 chat 加回来
    const prev = expandedSidebarProjectsRef.current;
    const pruned = new Set([...prev].filter((id) => projectIds.has(id)));
    if (pruned.size !== prev.size) setExpandedSidebarProjects(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdsKey, commitExpandedSidebarProjects]);

  // 按展开状态补加载会话：冷扫描只回部分摘要，展开的项目首次进入时才拉列表。
  useEffect(() => {
    const loaded = sessionsByProjectRef.current;
    for (const project of projects) {
      if (!expandedSidebarProjects.has(project.id)) continue;
      if (project.id in loaded) continue;
      void refreshProjectSessionsRef.current(project.id).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedSidebarProjects, projectIdsKey]);

  // activeProject 分支轮询：窗口可见时每 10s；最小化/隐藏时停掉 IPC 开销。
  useEffect(() => {
    if (!activeProjectId) return;
    let stopped = false;
    let timer: number | undefined;
    const refreshGitInfo = async () => {
      try {
        const next = await api.git.branches(activeProjectId);
        if (stopped) return;
        // 分支可能在外部终端/IDE 中切换,轮询只在状态真的变化时更新,避免不必要重渲染。
        setBranchInfoByProject((current) => {
          const prev = current[activeProjectId] ?? { current: null, branches: [] };
          return prev.current === next.current &&
            prev.branches.join("\n") === next.branches.join("\n")
            ? current
            : { ...current, [activeProjectId]: next };
        });
      } catch {
        if (!stopped) {
          setBranchInfoByProject((current) => ({
            ...current,
            [activeProjectId]: { current: null, branches: [] },
          }));
        }
      }
    };
    const start = () => {
      if (timer) return;
      void refreshGitInfo();
      timer = window.setInterval(refreshGitInfo, 10_000);
    };
    const stop = () => {
      if (timer) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeProjectId, api]);

  return {
    expandedSidebarProjects,
    setProjectSidebarExpanded,
    applyExpandedFromSettings,
    getExpandedProjectIds,
    worktreesByProject,
    branchInfoByProject,
    setBranchInfo,
    refreshBranchInfo,
    resetBranchInfo,
    refreshWorktrees,
    collapsedWorktrees,
    setCollapsedWorktrees,
    expandedWorktreeSessions,
    setExpandedWorktreeSessions,
    removingWorktreePaths,
    setRemovingWorktreePaths,
    draggingProjectId,
    setDraggingProjectId,
    dragOverProjectId,
    setDragOverProjectId,
    visibleProjectChildCountByProject,
    noteProjectSessionsChanged,
    showMoreProjectChildren,
    forgetProject,
    sessionSourceFilter,
    setSessionSourceFilter,
    expandedSubagentGroups,
    toggleSubagentGroup,
    sidebarDeleteConfirm,
    setSidebarDeleteConfirm,
    worktreeCreateDialog,
    setWorktreeCreateDialog,
    worktreeCreating,
    setWorktreeCreating,
  };
}
