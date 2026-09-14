/**
 * git:init 的执行路径。
 *
 * handler 此前在内部动态 import node:child_process 裸调 execFileAsync：无超时、无 maxBuffer、
 * stderr 未归一、env 整体替换 process.env。现在整条链路收在 GitService.initRepo
 * （按仓库串行队列 + CommandRunner 的 30s 超时/32MB 缓冲/非交互 git 环境），
 * 本用例断言 handler 与 GitService 之间的契约：以项目路径调用 initRepo，失败原样上抛。
 */
import { describe, expect, it, vi } from "vitest";
import { registerGitHandlers } from "./gitHandlers";

// 与本用例无关的依赖一律空对象 stub（与 appHandlers.webServiceFallback.test.ts 同风格）
const stubs = {} as never;

function register(initRepo: (cwd: string) => Promise<void>) {
	const projectStore = {
		get: (id: string) => (id === "p1" ? { id: "p1", path: "/repo" } : undefined),
	};
	return registerGitHandlers({
		projectStore,
		gitService: { initRepo },
		settingsStore: stubs,
		worktreeService: stubs,
		appLogger: stubs,
		quickGen: stubs,
	} as never);
}

describe("git:init", () => {
	it("以项目路径调用 GitService.initRepo（handler 内不再自行执行 git）", async () => {
		const initRepo = vi.fn(async () => {});
		const handlers = register(initRepo);

		await handlers.git.init({} as never, "p1");

		expect(initRepo).toHaveBeenCalledTimes(1);
		expect(initRepo).toHaveBeenCalledWith("/repo");
	});

	it("initRepo 失败原样上抛给渲染层", async () => {
		const handlers = register(async () => {
			throw new Error("git init failed");
		});

		await expect(handlers.git.init({} as never, "p1")).rejects.toThrow("git init failed");
	});
});
