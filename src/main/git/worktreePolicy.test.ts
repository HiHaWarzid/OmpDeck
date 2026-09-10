import { describe, expect, it } from "vitest";
import {
	decideAfkReuse,
	parseWorktreeList,
	shouldDeleteWorktreeBranch,
	slugifyWorktreeName,
} from "./worktreePolicy";

describe("slugifyWorktreeName", () => {
	it("保留中英文与数字，非法字符转连字符", () => {
		expect(slugifyWorktreeName("Fix 登录 bug!")).toBe("Fix-登录-bug");
		expect(slugifyWorktreeName("  a/b:c~d  ")).toBe("a-b-c-d");
	});

	it("空输入兜底 workspace", () => {
		expect(slugifyWorktreeName("   ")).toBe("workspace");
		expect(slugifyWorktreeName("///")).toBe("workspace");
	});
});

describe("parseWorktreeList", () => {
	it("过滤主工作区，只返回其他 worktree", () => {
		const stdout = [
			"worktree /proj",
			"branch refs/heads/main",
			"",
			"worktree /proj-wt/afk-1-fix",
			"branch refs/heads/afk-1-fix",
			"",
		].join("\n");
		const entries = parseWorktreeList(stdout, "/proj");
		expect(entries).toHaveLength(1);
		expect(entries[0].branch).toBe("afk-1-fix");
		expect(entries[0].path).toContain("afk-1-fix");
	});

	it("无 branch 行即 detached；末尾无空行也收尾", () => {
		const stdout = "worktree /proj\nbranch refs/heads/main\n\nworktree /tmp/x";
		const entries = parseWorktreeList(stdout, "/proj");
		expect(entries).toHaveLength(1);
		expect(entries[0].branch).toBe("detached");
		expect(entries[0].path).toMatch(/tmp/);
	});
});

describe("shouldDeleteWorktreeBranch", () => {
	it("只删自建分支：ompdeck/、pideck/ 前缀或分支名等于目录名", () => {
		expect(shouldDeleteWorktreeBranch("ompdeck/abc", "abc")).toBe(true);
		expect(shouldDeleteWorktreeBranch("pideck/abc", "abc")).toBe(true);
		expect(shouldDeleteWorktreeBranch("afk-1-fix", "afk-1-fix")).toBe(true);
	});

	it("外部 worktree 保守保留", () => {
		expect(shouldDeleteWorktreeBranch("main", "afk-1-fix")).toBe(false);
		expect(shouldDeleteWorktreeBranch("feature/x", "other")).toBe(false);
		expect(shouldDeleteWorktreeBranch(undefined, "afk-1-fix")).toBe(false);
	});
});

describe("decideAfkReuse", () => {
	const base = {
		entries: [],
		branch: "afk-1-fix",
		worktreeDir: "/wt/afk-1-fix",
		branchExists: false,
		dirExists: false,
	};

	it("分支已挂 worktree 即复用实际路径（残留重跑）", () => {
		expect(
			decideAfkReuse({
				...base,
				entries: [{ path: "/elsewhere/afk-1-fix", branch: "afk-1-fix" }],
			}),
		).toEqual({ kind: "reuse-path", path: "/elsewhere/afk-1-fix" });
	});

	it("目标目录被别的分支占用即报错", () => {
		expect(
			decideAfkReuse({
				...base,
				entries: [{ path: "/wt/afk-1-fix", branch: "other-branch" }],
			}),
		).toEqual({ kind: "error-occupied", occupyingBranch: "other-branch" });
	});

	it("分支存在：老目录在则复用，否则重新挂载", () => {
		expect(decideAfkReuse({ ...base, branchExists: true, dirExists: true })).toEqual({
			kind: "reuse-branch-dir",
			path: "/wt/afk-1-fix",
		});
		expect(decideAfkReuse({ ...base, branchExists: true, dirExists: false })).toEqual({
			kind: "mount-branch",
			path: "/wt/afk-1-fix",
		});
	});

	it("分支不存在但老目录在：复用残留目录；否则全新创建", () => {
		expect(decideAfkReuse({ ...base, dirExists: true })).toEqual({
			kind: "reuse-stale-dir",
			path: "/wt/afk-1-fix",
		});
		expect(decideAfkReuse(base)).toEqual({ kind: "create-fresh", path: "/wt/afk-1-fix" });
	});
});
