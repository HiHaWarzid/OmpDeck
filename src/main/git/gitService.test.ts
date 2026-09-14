import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRunner, type Executor, type ExecutorOptions, type RunCommandOptions } from "../utils/CommandRunner";
import { createRepoCommandQueue } from "../utils/repoCommandQueue";
import { GitService } from "./GitService";

type GitCall = { cwd: string; args: string[]; options?: RunCommandOptions };

/**
 * 记录型 fake git 执行器：
 * - events 记录每个子命令的 enter/fail/leave 顺序，用于断言"同仓库串行、不同仓库并行"；
 * - hang(sub) 把该子命令停在在途窗口（entered 在挂起前 resolve，测试可确定性等待）；
 * - fail(sub) 让该子命令抛错；
 * - status/rev-parse 按 fixture 仓库回答，使 stage/unstage 的路径校验能通过。
 */
function createGitFake(repo: string, file: string) {
	const events: string[] = [];
	const calls: GitCall[] = [];
	const hangs = new Map<string, { promise: Promise<void>; entered: () => void }>();
	const failing = new Set<string>();

	// 子命令取第一个非选项 token：["--literal-pathspecs","add","--",…] → "add"
	const subcommandOf = (args: string[]): string => args.find((arg) => !arg.startsWith("-")) ?? "";

	const runGit = async (cwd: string, args: string[], options?: RunCommandOptions): Promise<string> => {
		const sub = subcommandOf(args);
		calls.push({ cwd, args, options });
		events.push(`enter ${sub}`);
		const hang = hangs.get(sub);
		if (hang) {
			hang.entered();
			await hang.promise;
		}
		if (failing.has(sub)) {
			events.push(`fail ${sub}`);
			throw new Error(`git ${sub} failed`);
		}
		events.push(`leave ${sub}`);
		if (sub === "status") return `?? ${basename(file)}\0`;
		if (sub === "rev-parse" && args.includes("--show-toplevel")) return `${repo}\n`;
		if (sub === "rev-parse") return `${"a".repeat(40)}\n`;
		return "";
	};

	return {
		runGit,
		events,
		calls,
		/** 让 sub 子命令抛错 */
		fail: (sub: string) => {
			failing.add(sub);
		},
		/** 让 sub 子命令进入后挂起；返回放行句柄 */
		hang: (sub: string) => {
			const hold = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			hangs.set(sub, { promise: hold.promise, entered: () => entered.resolve() });
			return { entered: entered.promise, release: () => hold.resolve() };
		},
	};
}

/** 建一个真实临时目录做仓库根：getStatusContext 会对 cwd 做 realpath，路径必须真实存在。 */
async function makeRepoFixture() {
	const repo = await mkdtemp(join(tmpdir(), "ompdeck-git-"));
	const file = join(repo, "a.txt");
	await writeFile(file, "x");
	return { repo, file, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe("GitService 变更命令串行", () => {
	it("同一仓库并发 stage + commit：commit 等 stage 结束才开始，严格串行", async () => {
		const fixture = await makeRepoFixture();
		try {
			const fake = createGitFake(fixture.repo, fixture.file);
			const hold = fake.hang("add");
			const service = new GitService({ runGit: fake.runGit, queue: createRepoCommandQueue() });

			const stage = service.stageFiles(fixture.repo, [fixture.file]);
			await hold.entered;
			const commit = service.commit(fixture.repo, "msg");
			await Promise.resolve();

			// add 还在途：commit 的 git 调用不得出现（并发的两条变更落在同一仓库上）
			expect(fake.events).not.toContain("enter commit");
			hold.release();
			await Promise.all([stage, commit]);

			expect(fake.events.indexOf("leave add")).toBeLessThan(fake.events.indexOf("enter commit"));
			expect(fake.events).toContain("leave commit");
			// 两条写命令的 cwd 都是该仓库
			const writes = fake.calls.filter((call) => call.args.includes("add") || call.args.includes("commit"));
			expect(writes.map((call) => call.cwd)).toEqual([fixture.repo, fixture.repo]);
		} finally {
			await fixture.cleanup();
		}
	});

	it("不同仓库的变更同时在途（串行只按 cwd 生效）", async () => {
		const fake = createGitFake("/repo-a", "/repo-a/a.txt");
		const service = new GitService({ runGit: fake.runGit, queue: createRepoCommandQueue() });
		const holdCommit = fake.hang("commit");
		const holdCherry = fake.hang("cherry-pick");

		const commit = service.commit("/repo-a", "msg");
		const cherryPick = service.cherryPick("/repo-b", "b".repeat(40));
		// 两条都进入各自的 git 调用：若队列按全局串行，后者永远进不来
		await Promise.all([holdCommit.entered, holdCherry.entered]);
		holdCommit.release();
		holdCherry.release();
		await Promise.all([commit, cherryPick]);

		expect(fake.calls.map((call) => call.cwd)).toEqual(["/repo-a", "/repo-b"]);
	});

	it("前一个变更失败不阻塞后继变更", async () => {
		const fake = createGitFake("/repo", "/repo/a.txt");
		fake.fail("commit");
		const service = new GitService({ runGit: fake.runGit, queue: createRepoCommandQueue() });

		const failed = service.commit("/repo", "boom");
		const next = service.resetToCommit("/repo", "c".repeat(40), "hard");

		await expect(failed).rejects.toThrow("git commit failed");
		await expect(next).resolves.toBeUndefined();
		expect(fake.events.indexOf("fail commit")).toBeLessThan(fake.events.indexOf("enter reset"));
	});

	it("只读命令不排在在途变更后面", async () => {
		const fake = createGitFake("/repo", "/repo/a.txt");
		const hold = fake.hang("commit");
		const service = new GitService({ runGit: fake.runGit, queue: createRepoCommandQueue() });

		const commit = service.commit("/repo", "msg");
		await hold.entered;
		// 只读查询与在途写命令无关：必须在 commit 释放前就完成
		await expect(service.getCommitLog("/repo")).resolves.toEqual([]);
		expect(fake.events.indexOf("leave log")).toBeGreaterThanOrEqual(0);
		expect(fake.events).not.toContain("leave commit");

		hold.release();
		await commit;
	});
});

describe("GitService.initRepo", () => {
	it("经 CommandRunner 执行（30s 超时 / 32MB 缓冲 / 非交互环境），命令顺序与 handler 原实现一致", async () => {
		const execCalls: Array<{ bin: string; args: string[]; options: ExecutorOptions }> = [];
		const exec: Executor = async (bin, args, options) => {
			execCalls.push({ bin, args, options });
			return { stdout: "" };
		};
		const runner = createCommandRunner({ exec });
		const service = new GitService({ runGit: runner.runGit, queue: createRepoCommandQueue() });

		await service.initRepo("/repo");

		expect(execCalls.map((call) => call.bin)).toEqual(["git", "git", "git"]);
		expect(execCalls.map((call) => call.args.join(" "))).toEqual([
			"init",
			"checkout -b main",
			"commit --allow-empty -m Initial commit",
		]);
		for (const call of execCalls) {
			expect(call.options.cwd).toBe("/repo");
			expect(call.options.timeout).toBe(30_000);
			expect(call.options.maxBuffer).toBe(32 * 1024 * 1024);
			expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe("0");
		}
		// 初始提交只补 author/committer：继承环境（PATH 等）必须保留
		expect(execCalls[2].options.env?.GIT_AUTHOR_NAME).toBe("OmpDeck");
		expect(execCalls[2].options.env?.PATH).toBe(process.env.PATH);
	});

	it("checkout -b 失败时回退 branch -M", async () => {
		const fake = createGitFake("/repo", "/repo/a.txt");
		fake.fail("checkout");
		const service = new GitService({ runGit: fake.runGit, queue: createRepoCommandQueue() });

		await service.initRepo("/repo");

		expect(fake.calls.map((call) => call.args[0])).toEqual(["init", "checkout", "branch", "commit"]);
		expect(fake.calls[2].args).toEqual(["branch", "-M", "main"]);
	});

	it("init 后失效 status 冷却缓存（否则抽屉仍提示非 git 项目）", async () => {
		const fixture = await makeRepoFixture();
		try {
			const fake = createGitFake(fixture.repo, fixture.file);
			const service = new GitService({ runGit: fake.runGit, queue: createRepoCommandQueue() });
			const countStatus = () => fake.events.filter((event) => event === "enter status").length;

			await service.getStatus(fixture.repo);
			const before = countStatus();
			await service.initRepo(fixture.repo);
			await service.getStatus(fixture.repo);

			expect(countStatus()).toBe(before + 1);
		} finally {
			await fixture.cleanup();
		}
	});
});
