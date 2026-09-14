/**
 * 按仓库路径串行的命令队列（git 变更命令专用）。
 *
 * 背景：git 写命令（add/commit/checkout/reset/rebase/push/worktree add…）在同一个仓库上
 * 并发执行会争用 `index.lock`，后到者直接失败（"Unable to create '.../index.lock'"）。
 * 主进程里 UI 的 Git 面板与 AFK 编排器会同时对同一仓库动手，仅靠 UI 侧自保挡不住这条路径。
 *
 * 语义：
 * - 同一 cwd 的 task 严格按入队顺序串行，前一个 settle（成功或失败）后才开始下一个；
 * - 不同 cwd 完全并行；
 * - 前序失败不阻塞后继：错误只抛给它自己的调用方，队列链上不留 rejection；
 * - 队列排空后从 Map 中删除该键，避免按仓库路径无限累积。
 *
 * 只读命令（status/branches/log/diff…）不进队列，否则 UI 查询会被写操作堵住。
 */

import { resolve } from "node:path";

export type RepoCommandQueue = {
	/** 在同一 cwd 上串行执行 task，返回 task 的结果或抛出原始错误；不同 cwd 并行。 */
	run: <T>(cwd: string, task: () => Promise<T>) => Promise<T>;
	/** 当前在途/排队的仓库路径数（排空后为 0；测试与诊断用）。 */
	size: () => number;
};

/**
 * cwd → 队列键：先 resolve（消除 "D:/repo" 与 "D:/repo/" 之类的写法差异），
 * Windows 再折大小写（同一目录的不同大小写写法必须命中同一个锁）。
 */
function queueKey(cwd: string): string {
	const resolved = resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function createRepoCommandQueue(): RepoCommandQueue {
	/** 键 → 该仓库队列尾部的 promise（永不 reject：失败只影响各自调用方） */
	const tails = new Map<string, Promise<void>>();

	const run = <T>(cwd: string, task: () => Promise<T>): Promise<T> => {
		const key = queueKey(cwd);
		const previous = tails.get(key) ?? Promise.resolve();
		const result = previous.then(task);
		// tail 吞掉错误：前序失败不能把 rejection 传染给后继任务，也不能变成 unhandledRejection。
		const release = (): void => {
			// 只有当自己仍是队尾时才清理；后继任务已接上时保留键。
			if (tails.get(key) === tail) tails.delete(key);
		};
		const tail = result.then(release, release);
		tails.set(key, tail);
		return result;
	};

	return { run, size: () => tails.size };
}

/** 进程级共享队列：GitService 与 WorktreeService 必须共用同一实例，否则锁形同虚设。 */
export const repoCommandQueue = createRepoCommandQueue();
