import { describe, expect, it } from "vitest";
import { WorktreeService } from "./WorktreeService";

/**
 * WorktreeService 副作用端口（按调用顺序记录 git/目录操作）。
 * 验证"给定状态走哪条路线、按什么顺序调 git"，不碰真实仓库。
 */
function fakeEffects(overrides: {
	listStdout?: string;
	branchExists?: boolean;
	dirExists?: boolean;
	statusPorcelain?: string;
} = {}) {
	const calls: Array<{ cwd: string; args: string[] }> = [];
	const removedDirs: string[] = [];
	return {
		calls,
		removedDirs,
		effects: {
			runGit: async (cwd: string, args: string[]) => {
				calls.push({ cwd, args });
				const cmd = args.join(" ");
				if (cmd.startsWith("worktree list")) {
					return overrides.listStdout ?? "";
				}
				if (cmd.startsWith("show-ref")) {
					if (!overrides.branchExists) throw new Error("no such ref");
					return "";
				}
				if (cmd.startsWith("status")) {
					return overrides.statusPorcelain ?? "";
				}
				return "";
			},
			dirExists: () => overrides.dirExists ?? false,
			removeDir: async (path: string) => {
				removedDirs.push(path);
			},
		},
	};
}

const PORCELAIN = (branch: string, path: string) =>
	["worktree /proj", "branch refs/heads/main", "", `worktree ${path}`, `branch refs/heads/${branch}`, ""].join(
		"\n",
	);

describe("createAfk 路由", () => {
	it("分支已挂 worktree 即复用，不执行任何写操作", async () => {
		const fake = fakeEffects({
			listStdout: PORCELAIN("afk-1-fix", "/elsewhere/afk-1-fix"),
		});
		const svc = new WorktreeService(fake.effects);
		const res = await svc.createAfk("/proj", 1, "fix");
		expect(res.reused).toBe(true);
		expect(res.path).toContain("afk-1-fix");
		// 只有 list + show-ref 两次只读查询，无 add 写入
		expect(fake.calls.map((c) => c.args[0])).toEqual(["worktree", "show-ref"]);
		expect(fake.removedDirs).toEqual([]);
	});

	it("目标目录被别的分支占用即报错", async () => {
		// service 按 {dirname(projectPath)}/{branch} 算目标目录：
		// projectPath=/wt/src 使目标目录恰好命中占用条目 /wt/afk-1-fix
		const fake = fakeEffects({
			listStdout: PORCELAIN("other-branch", "/wt/afk-1-fix"),
		});
		const svc = new WorktreeService(fake.effects);
		await expect(svc.createAfk("/wt/src", 1, "fix")).rejects.toThrow("已被其他分支占用");
	});
});

describe("remove 分支判定", () => {
	it("自建同名分支随 worktree 删除", async () => {
		const fake = fakeEffects({
			listStdout: PORCELAIN("afk-1-fix", "/wt/afk-1-fix"),
		});
		const svc = new WorktreeService(fake.effects);
		expect(await svc.remove("/wt/afk-1-fix", "/proj")).toBe(true);
		const cmds = fake.calls.map((c) => c.args.join(" "));
		expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(true);
		expect(cmds.some((c) => c.includes("branch -D afk-1-fix"))).toBe(true);
	});

	it("外部 worktree 的分支保守保留", async () => {
		const fake = fakeEffects({
			listStdout: PORCELAIN("main", "/wt/other"),
		});
		const svc = new WorktreeService(fake.effects);
		expect(await svc.remove("/wt/other", "/proj")).toBe(true);
		const cmds = fake.calls.map((c) => c.args.join(" "));
		expect(cmds.some((c) => c.includes("branch -D"))).toBe(false);
	});

	it("未登记的 worktree 返回 false，不执行删除", async () => {
		const fake = fakeEffects({ listStdout: "" });
		const svc = new WorktreeService(fake.effects);
		expect(await svc.remove("/wt/ghost", "/proj")).toBe(false);
		expect(fake.removedDirs).toEqual([]);
	});
});

describe("removeWithWip", () => {
	it("工作树干净时跳过快照直接删除", async () => {
		const fake = fakeEffects({
			listStdout: PORCELAIN("afk-1-fix", "/wt/afk-1-fix"),
			statusPorcelain: "",
		});
		const svc = new WorktreeService(fake.effects);
		expect(await svc.removeWithWip("/wt/afk-1-fix", "/proj", 1)).toBe(true);
		const cmds = fake.calls.map((c) => c.args.join(" "));
		expect(cmds.some((c) => c.includes("commit"))).toBe(false);
	});

	it("有未提交改动时先快照再删除", async () => {
		const fake = fakeEffects({
			listStdout: PORCELAIN("afk-1-fix", "/wt/afk-1-fix"),
			statusPorcelain: " M file.ts\n",
		});
		const svc = new WorktreeService(fake.effects);
		expect(await svc.removeWithWip("/wt/afk-1-fix", "/proj", 7)).toBe(true);
		const cmds = fake.calls.map((c) => c.args.join(" "));
		expect(cmds.some((c) => c.includes("[afk-wip] #7"))).toBe(true);
		expect(cmds.some((c) => c.startsWith("worktree remove"))).toBe(true);
	});
});
