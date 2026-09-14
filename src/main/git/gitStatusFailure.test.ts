/**
 * git:status 的失败分类判断（batch 6a）。
 *
 * fetchStatus 此前用消息正则反推「不是 git 仓库 / git 未安装」；现在直接看命令层的
 * CommandError.kind：命令层已分类的失败一律上抛（渲染层据此分别给出「初始化仓库」、
 * 「安装 git」、「超时重试」提示），非命令错误（fs 抖动、porcelain 解析异常）按「无变更」
 * 吞掉 —— 与历史一致，避免一次抖动把整棵变更树标成失败。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandError } from "../utils/CommandRunner";
import { createRepoCommandQueue } from "../utils/repoCommandQueue";
import { GitService } from "./GitService";

const EMPTY_GROUPS = { merge: [], index: [], workingTree: [], untracked: [] };

/** getStatusContext 会对 cwd 做 realpath，故用真实临时目录做仓库根。 */
async function withRepoFixture(run: (repo: string) => Promise<void>): Promise<void> {
	const repo = await mkdtemp(join(tmpdir(), "ompdeck-git-status-"));
	try {
		await run(repo);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
}

/** service 假件：git 调用一律抛出给定错误，用于断言 fetchStatus 的分类判断。 */
function serviceThrowing(error: unknown): GitService {
	return new GitService({
		runGit: async () => {
			throw error;
		},
		queue: createRepoCommandQueue(),
	});
}

describe("GitService.getStatus 的失败分类（CommandError.kind）", () => {
	it("kind=not-found（git 不在 PATH）→ 上抛，供渲染层展示安装引导", async () => {
		await withRepoFixture(async (repo) => {
			const error = new CommandError(
				"not-found",
				"git status failed: spawn git ENOENT，请检查 PATH 或是否安装 git",
			);
			await expect(serviceThrowing(error).getStatus(repo)).rejects.toBe(error);
		});
	});

	it("kind=command（git 报 fatal: not a git repository）→ 上抛，供渲染层展示初始化仓库", async () => {
		await withRepoFixture(async (repo) => {
			const error = new CommandError(
				"command",
				"git status failed: fatal: not a git repository (or any of the parent directories): .git",
				128,
			);
			await expect(serviceThrowing(error).getStatus(repo)).rejects.toBe(error);
		});
	});

	it("kind=timeout（超时被杀）→ 上抛，不再被消息正则漏判成「无变更」", async () => {
		await withRepoFixture(async (repo) => {
			const error = new CommandError("timeout", "git status timed out after 30000ms: ");
			await expect(serviceThrowing(error).getStatus(repo)).rejects.toBe(error);
		});
	});

	it("非命令错误（fs 抖动）→ 吞掉并返回空分组", async () => {
		await withRepoFixture(async (repo) => {
			const error = new Error("EACCES: permission denied, scandir '/repo'");
			await expect(serviceThrowing(error).getStatus(repo)).resolves.toEqual(EMPTY_GROUPS);
		});
	});
});
