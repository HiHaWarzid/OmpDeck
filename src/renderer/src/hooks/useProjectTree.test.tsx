// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, Project } from "../../../shared/types";
import { useProjectTree, type ProjectTree, type ProjectTreeDeps } from "./useProjectTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXPANDED_KEY = "pid:sidebar-expanded-projects";
const LEGACY_KEY = "pid:sidebar-collapsed-projects";
const SOURCE_FILTER_KEY = "pideck-session-source-filter";
const SUBAGENT_KEY = "pid:sidebar-expanded-subagent-groups";
const CHAT_ID = "builtin-chat";

function project(id: string, patch: Partial<Project> = {}): Project {
  return { id, name: id, path: `/${id}`, ...patch } as Project;
}

let container: HTMLDivElement;
let root: Root;
let latest: ProjectTree;

function Probe({ deps }: { deps: ProjectTreeDeps }) {
  latest = useProjectTree(deps);
  return null;
}

function makeDeps(patch: Partial<ProjectTreeDeps> = {}): ProjectTreeDeps {
  return {
    api: {
      settings: {
        update: vi.fn(async (values: Partial<AppSettings>) => values as AppSettings),
      },
      git: {
        worktreeList: vi.fn(async () => []),
        branches: vi.fn(async () => ({ current: null, branches: [] })),
      },
      projects: { list: vi.fn(async () => []) },
    },
    projects: [project(CHAT_ID), project("p1")],
    sessionsByProject: {},
    refreshProjectSessions: vi.fn(async () => undefined),
    setProjects: vi.fn(),
    onExpandedPersisted: vi.fn(),
    activeProjectId: undefined,
    ...patch,
  };
}

async function mount(deps: ProjectTreeDeps) {
  await act(async () => {
    root.render(<Probe deps={deps} />);
  });
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useProjectTree", () => {
  it("默认只展开内置 chat；localStorage 有缓存时按缓存还原", async () => {
    await mount(makeDeps());
    expect([...latest.expandedSidebarProjects]).toEqual([CHAT_ID]);

    localStorage.setItem(EXPANDED_KEY, JSON.stringify([CHAT_ID, "p1"]));
    act(() => root.unmount());
    root = createRoot(container);
    await mount(makeDeps());
    expect([...latest.expandedSidebarProjects].sort()).toEqual([CHAT_ID, "p1"]);
  });

  it("切换展开双写 localStorage 与 settings.json，并回灌保存结果", async () => {
    const deps = makeDeps();
    await mount(deps);

    act(() => {
      latest.setProjectSidebarExpanded("p1");
    });

    expect(JSON.parse(localStorage.getItem(EXPANDED_KEY)!)).toEqual([CHAT_ID, "p1"]);
    expect(deps.api.settings.update).toHaveBeenCalledWith({
      sidebarExpandedProjectIds: [CHAT_ID, "p1"],
    });
    await act(async () => {});
    expect(deps.onExpandedPersisted).toHaveBeenCalledWith([CHAT_ID, "p1"]);

    act(() => {
      latest.setProjectSidebarExpanded("p1", true);
    });
    expect([...latest.expandedSidebarProjects]).toEqual([CHAT_ID, "p1"]);
  });

  it("settings 是权威来源；用户点击后迟到的 settings 不再覆盖", async () => {
    await mount(makeDeps());

    act(() => {
      latest.applyExpandedFromSettings(["chat-only-marker"]);
    });
    expect([...latest.expandedSidebarProjects]).toEqual(["chat-only-marker"]);

    act(() => {
      latest.setProjectSidebarExpanded("p1");
    });
    act(() => {
      latest.applyExpandedFromSettings([CHAT_ID]);
    });
    // 权威标记已置位：迟到的 settings 读不能把用户刚展开的 p1 冲掉
    expect(latest.expandedSidebarProjects.has("p1")).toBe(true);
  });

  it("旧折叠 key 在新 key 缺失时一次性迁移为展开集合", async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(["p1"]));
    const deps = makeDeps({ projects: [project(CHAT_ID), project("p1"), project("p2")] });
    await mount(deps);

    expect([...latest.expandedSidebarProjects].sort()).toEqual([CHAT_ID, "p2"]);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(deps.api.settings.update).toHaveBeenCalled();
  });

  it("项目列表刷新时裁剪已删除 id，不自动展开新项目", async () => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([CHAT_ID, "gone"]));
    const deps = makeDeps({ projects: [project(CHAT_ID), project("p1")] });
    await mount(deps);

    expect([...latest.expandedSidebarProjects]).toEqual([CHAT_ID]);
    expect(JSON.parse(localStorage.getItem(EXPANDED_KEY)!)).toEqual([CHAT_ID]);
  });

  it("展开的项目首次进入时补加载会话，已加载的不重复拉取", async () => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([CHAT_ID, "p1"]));
    const deps = makeDeps({
      sessionsByProject: { p1: [] },
      refreshProjectSessions: vi.fn(async () => undefined),
      projects: [project(CHAT_ID), project("p1")],
    });
    await mount(deps);

    expect(deps.refreshProjectSessions).toHaveBeenCalledTimes(1);
    expect(deps.refreshProjectSessions).toHaveBeenCalledWith(CHAT_ID);
  });

  it("显示更多按页大小累加，删除项目时清掉分页行", async () => {
    await mount(makeDeps());

    act(() => latest.noteProjectSessionsChanged("p1"));
    expect(latest.visibleProjectChildCountByProject.p1).toBe(5);
    act(() => latest.showMoreProjectChildren("p1"));
    expect(latest.visibleProjectChildCountByProject.p1).toBe(10);

    act(() => latest.forgetProject("p1"));
    expect(latest.visibleProjectChildCountByProject).not.toHaveProperty("p1");
  });

  it("来源过滤与子会话组展开状态落盘并在重挂后还原", async () => {
    await mount(makeDeps());

    act(() => {
      latest.setSessionSourceFilter({ p1: new Set(["codex"]) });
      latest.toggleSubagentGroup("p1:session.jsonl");
    });
    expect(JSON.parse(localStorage.getItem(SOURCE_FILTER_KEY)!)).toEqual({ p1: ["codex"] });
    expect(JSON.parse(localStorage.getItem(SUBAGENT_KEY)!)).toEqual(["p1:session.jsonl"]);

    act(() => root.unmount());
    root = createRoot(container);
    await mount(makeDeps());
    expect([...(latest.sessionSourceFilter.p1 ?? [])]).toEqual(["codex"]);
    expect([...latest.expandedSubagentGroups]).toEqual(["p1:session.jsonl"]);
  });

  it("worktree 刷新回灌项目列表；失败时清空该项目 worktree", async () => {
    const deps = makeDeps();
    const setProjects = vi.fn();
    const refreshedDeps = { ...deps, setProjects };
    await mount(refreshedDeps);

    const entry = { path: "/wt/p1", branch: "feat" } as never;
    vi.mocked(deps.api.git.worktreeList).mockResolvedValueOnce([entry]);
    vi.mocked(deps.api.git.branches).mockResolvedValueOnce({
      current: "main",
      branches: ["main"],
    });
    vi.mocked(deps.api.projects.list).mockResolvedValueOnce([
      project(CHAT_ID),
      project("p1"),
      project("p1-wt", { worktreeParentId: "p1" }),
    ]);
    await act(async () => {
      await latest.refreshWorktrees("p1");
    });
    expect(latest.worktreesByProject.p1).toEqual([entry]);
    expect(latest.branchInfoByProject.p1).toEqual({ current: "main", branches: ["main"] });
    expect(setProjects).toHaveBeenCalledTimes(1);

    vi.mocked(deps.api.git.worktreeList).mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await latest.refreshWorktrees("p1");
    });
    expect(latest.worktreesByProject.p1).toEqual([]);
  });
});
