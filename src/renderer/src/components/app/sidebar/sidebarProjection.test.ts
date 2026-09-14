import { describe, expect, it } from "vitest";
import type { AgentTab, Project, SessionSummary } from "../../../../../shared/types";
import {
	buildSidebarProjectDisplay,
	WORKTREE_COLLAPSED_SESSION_LIMIT,
	type SidebarProjectDisplayInput,
	type SidebarProjectRow,
} from "./sidebarProjection";

/**
 * 侧栏投影契约（批次 5c）。
 *
 * 这些断言冻结的是组件渲染依赖的行为：会话过滤/分页、worktree 行的合并与去重、
 * 折叠态的展示条数。这些原先散落在渲染体内联计算里（每个项目 filter、每个
 * worktree 行 find + 分组），迁移到投影后必须有单测守住，否则回归只能是肉眼可见。
 */

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		filePath: `C:/sessions/${id}.jsonl`,
		preview: id,
		updatedAt: 1,
		messageCount: 1,
		...overrides,
	};
}

function agent(id: string, projectId: string): AgentTab {
	return {
		id,
		projectId,
		cwd: "C:/projects",
		title: id,
		status: "idle",
		createdAt: 1,
	};
}

function project(id: string, overrides: Partial<Project> = {}): Project {
	return {
		id,
		name: id,
		path: `C:/projects/${id}`,
		lastOpenedAt: 1,
		...overrides,
	};
}

function build(overrides: Partial<SidebarProjectDisplayInput> = {}): Record<string, SidebarProjectRow> {
	const projects = overrides.projects ?? [];
	return buildSidebarProjectDisplay({
		projects,
		visibleProjects: projects,
		sessionsByProject: {},
		agentsByProject: new Map(),
		search: "",
		sourceFilter: {},
		visibleChildCountByProject: {},
		worktreesByProject: {},
		expandedWorktreeSessions: new Set(),
		...overrides,
	});
}

describe("buildSidebarProjectDisplay 主列表", () => {
	it("按搜索词与来源过滤会话，并照常生成分组", () => {
		const p1 = project("p1");
		const result = build({
			projects: [p1],
			sessionsByProject: {
				p1: [
					session("alpha", { preview: "alpha", source: "codex", updatedAt: 2 }),
					session("beta", { preview: "beta", source: "codex", updatedAt: 1 }),
					session("gamma", { preview: "gamma", source: "pi", updatedAt: 3 }),
				],
			},
			search: "alpha",
			sourceFilter: { p1: new Set(["codex"]) },
		});
		expect(result.p1.display.children.map((child) => child.key)).toEqual([
			"session:c:/sessions/alpha.jsonl",
		]);
	});

	it("来源过滤缺省为 pi：无 source 字段的会话默认算 pi 来源", () => {
		const p1 = project("p1");
		const result = build({
			projects: [p1],
			sessionsByProject: { p1: [session("plain"), session("imported", { source: "claude" })] },
			sourceFilter: { p1: new Set(["pi"]) },
		});
		expect(result.p1.display.children.map((child) => child.key)).toEqual([
			"session:c:/sessions/plain.jsonl",
		]);
	});

	it("分页：visibleChildCount 决定可见子项与隐藏数，缺省按侧栏页大小", () => {
		const p1 = project("p1");
		const many = Array.from({ length: 6 }, (_, index) =>
			session(`s${index}`, { updatedAt: index }),
		);
		const paged = build({
			projects: [p1],
			sessionsByProject: { p1: many },
			visibleChildCountByProject: { p1: 2 },
		});
		expect(paged.p1.display.visibleChildren).toHaveLength(2);
		expect(paged.p1.display.hiddenChildCount).toBe(4);

		const byDefault = build({ projects: [p1], sessionsByProject: { p1: many } });
		expect(byDefault.p1.display.visibleChildren).toHaveLength(5);
		expect(byDefault.p1.display.hiddenChildCount).toBe(1);
	});

	it("非 worktree 项目不产生 worktree 行", () => {
		const p1 = project("p1");
		const result = build({
			projects: [p1],
			sessionsByProject: { p1: [session("s1")] },
			worktreesByProject: { p1: [{ path: "C:/wt/a", branch: "ompdeck/a" }] },
		});
		expect(result.p1.worktrees).toEqual([]);
	});
});

describe("buildSidebarProjectDisplay worktree 行", () => {
	const p1 = project("p1", { worktreeEnabled: true, path: "C:/projects/p1" });

	it("合并 git worktree 列表与已注册子项目，按路径去重", () => {
		const child = project("c1", {
			name: "feature-a",
			path: "C:/wt/a",
			worktreeParentId: "p1",
		});
		const result = build({
			projects: [p1, child],
			sessionsByProject: { p1: [], c1: [session("s1")] },
			worktreesByProject: {
				p1: [
					{ path: "C:/wt/a", branch: "ompdeck/a" },
					{ path: "C:/wt/b", branch: "ompdeck/b" },
				],
			},
		});
		expect(result.p1.worktrees.map((row) => row.path)).toEqual(["C:/wt/a", "C:/wt/b"]);
		// 已注册子项目取 git 分支名，不重复追加；未注册的外部 worktree 只有行没有子项目
		expect(result.p1.worktrees[0].branch).toBe("ompdeck/a");
		expect(result.p1.worktrees[0].project?.id).toBe("c1");
		expect(result.p1.worktrees[1].project).toBeUndefined();
		expect(result.p1.worktrees[1].display).toBeUndefined();
		expect(result.p1.worktrees[1].canFold).toBe(false);
	});

	it("git 列表缺失时补录已注册子项目（外部 worktree 与本地创建共用一条路径）", () => {
		const child = project("c1", {
			name: "feature-a",
			path: "C:/wt/a",
			worktreeParentId: "p1",
		});
		const result = build({
			projects: [p1, child],
			sessionsByProject: { p1: [], c1: [] },
		});
		expect(result.p1.worktrees).toHaveLength(1);
		expect(result.p1.worktrees[0].path).toBe("C:/wt/a");
		expect(result.p1.worktrees[0].branch).toBe("feature-a");
	});

	it("折叠时只给 3 条会话，展开后给全部", () => {
		const child = project("c1", {
			name: "feature-a",
			path: "C:/wt/a",
			worktreeParentId: "p1",
		});
		const sessions = Array.from({ length: 4 }, (_, index) =>
			session(`s${index}`, { updatedAt: index }),
		);
		const collapsed = build({
			projects: [p1, child],
			sessionsByProject: { p1: [], c1: sessions },
			worktreesByProject: { p1: [{ path: "C:/wt/a", branch: "ompdeck/a" }] },
		});
		expect(collapsed.p1.worktrees[0].display?.visibleChildren).toHaveLength(
			WORKTREE_COLLAPSED_SESSION_LIMIT,
		);
		expect(collapsed.p1.worktrees[0].display?.hiddenChildCount).toBe(
			sessions.length - WORKTREE_COLLAPSED_SESSION_LIMIT,
		);

		const expanded = build({
			projects: [p1, child],
			sessionsByProject: { p1: [], c1: sessions },
			worktreesByProject: { p1: [{ path: "C:/wt/a", branch: "ompdeck/a" }] },
			expandedWorktreeSessions: new Set(["C:/wt/a"]),
		});
		expect(expanded.p1.worktrees[0].display?.visibleChildren).toHaveLength(sessions.length);
		expect(expanded.p1.worktrees[0].display?.hiddenChildCount).toBe(0);
	});

	it("子工作区分组只吃该子项目的 agent，可折叠性由 agent 或会话决定", () => {
		const child = project("c1", {
			name: "feature-a",
			path: "C:/wt/a",
			worktreeParentId: "p1",
		});
		const result = build({
			projects: [p1, child],
			sessionsByProject: { p1: [session("parent")], c1: [] },
			agentsByProject: new Map([["c1", [agent("a1", "c1")]]]),
			worktreesByProject: { p1: [{ path: "C:/wt/a", branch: "ompdeck/a" }] },
		});
		// 主列表只看到父项目会话；子项目会话不会串到父项目行
		expect(result.p1.display.children.map((item) => item.key)).toEqual([
			"session:c:/sessions/parent.jsonl",
		]);
		expect(result.p1.worktrees[0].canFold).toBe(true);
		expect(result.p1.worktrees[0].display?.children.map((item) => item.key)).toEqual([
			"agent:a1",
		]);
	});

	it("worktree 行不套用搜索过滤（未命中的子项目仍要能进入）", () => {
		const child = project("c1", {
			name: "unrelated",
			path: "C:/wt/a",
			worktreeParentId: "p1",
		});
		const result = build({
			projects: [p1, child],
			sessionsByProject: { p1: [], c1: [session("sub", { preview: "内层会话" })] },
			worktreesByProject: { p1: [{ path: "C:/wt/a", branch: "ompdeck/a" }] },
			search: "父项目",
		});
		expect(result.p1.display.children).toEqual([]);
		expect(result.p1.worktrees[0].display?.children.map((item) => item.key)).toEqual([
			"session:c:/sessions/sub.jsonl",
		]);
	});
});
