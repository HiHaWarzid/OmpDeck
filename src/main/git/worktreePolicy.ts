import { resolve } from "node:path";
import type { WorktreeEntry } from "../../shared/types";

/**
 * worktree 保留/复用策略（纯函数，与 WorktreeService 的 git 副作用分离）。
 *
 * 背景：AFK 无人值守，删 worktree 前必须保留 WIP（ADR-0003），碰撞必须复用而非抛错
 * （CONTEXT.md Retry）。这些"给定状态定路线"的判定是纯的，先让它们可单测；
 * 查状态（list/show-ref/existsSync）与执行（add/commit/remove）仍留在 service。
 */

function canonicalSync(input: string): string {
	const normalized = resolve(input);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
	return canonicalSync(a) === canonicalSync(b);
}

/**
 * 把用户输入转换为合法的 worktree 目录名 / 分支名 slug。
 * 保留 Unicode 字母与数字（如中文、日文），只把空格、/、~、: 等 git 分支
 * 非法字符以及文件系统不友好的字符替换为 -，避免中文分支名被吞成 workspace。
 */
export function slugifyWorktreeName(input: string): string {
	return (
		input
			.trim()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "") || "workspace"
	);
}

/**
 * 解析 git worktree list --porcelain 输出。
 * 过滤掉主工作区（projectPath），只返回其他 worktree。
 */
export function parseWorktreeList(stdout: string, projectPath: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	const normalizedRoot = canonicalSync(projectPath);

	const lines = stdout.split(/\r?\n/);
	let current: Partial<WorktreeEntry> | null = null;

	const flush = () => {
		if (!current) return;
		const path = current.path ? resolve(current.path) : "";
		if (!samePath(path, normalizedRoot)) {
			entries.push({
				path,
				branch: current.branch?.replace(/^refs\/heads\//, "") ?? "detached",
			});
		}
		current = null;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			flush();
			continue;
		}
		if (trimmed.startsWith("worktree ")) {
			current = { path: trimmed.slice("worktree ".length).trim() };
			continue;
		}
		if (current && trimmed.startsWith("branch ")) {
			current.branch = trimmed.slice("branch ".length).trim();
		}
	}
	// 文件可能不以空行结尾
	flush();

	return entries;
}

/**
 * remove() 的分支删除判定：只删 OmpDeck 创建的分支。
 * 旧版本 pideck/{slug}、新版本 ompdeck/{slug}；外部 worktree 保守处理，
 * 仅当"分支名等于目录名"（同名工作区）时才认为是自建的。
 */
export function shouldDeleteWorktreeBranch(branch: string | undefined, worktreeDirName: string): boolean {
	if (!branch) return false;
	return branch.startsWith("ompdeck/") || branch.startsWith("pideck/") || branch === worktreeDirName;
}

export type AfkReuseDecision =
	/** 分支已挂在某个 worktree 上：复用其实际路径 */
	| { kind: "reuse-path"; path: string }
	/** 目标目录已被其他分支占用：明确报错而非静默错用 */
	| { kind: "error-occupied"; occupyingBranch: string }
	/** 分支存在 + 老目录存在：直接复用目录路径 */
	| { kind: "reuse-branch-dir"; path: string }
	/** 分支存在 + 目录不存在：重新挂载 worktree 指向该分支 */
	| { kind: "mount-branch"; path: string }
	/** 分支不存在 + 老目录存在（上次创建中断残留）：复用老目录 */
	| { kind: "reuse-stale-dir"; path: string }
	/** 全新创建 */
	| { kind: "create-fresh"; path: string };

/**
 * createAfk 的复用分流（对应 service 内联的 if 链，只定路线、不做副作用）。
 *
 * 行顺序即现有语义，改顺序会改行为：
 * 1. 分支已挂 worktree → 复用实际路径（含超时/崩溃残留）；
 * 2. 目标目录被别的分支占用 → 报错；
 * 3. 分支存在：老目录在 → 复用目录，否则重新挂载；
 * 4. 老目录在（分支不存在）→ 复用老目录；
 * 5. 全新创建。
 */
export function decideAfkReuse(params: {
	entries: WorktreeEntry[];
	branch: string;
	worktreeDir: string;
	branchExists: boolean;
	dirExists: boolean;
}): AfkReuseDecision {
	const { entries, branch, worktreeDir, branchExists, dirExists } = params;

	const existing = entries.find((entry) => entry.branch === branch);
	if (existing) {
		return { kind: "reuse-path", path: existing.path };
	}

	const dirOccupied = entries.find((entry) => samePath(entry.path, worktreeDir));
	if (dirOccupied) {
		return { kind: "error-occupied", occupyingBranch: dirOccupied.branch };
	}

	if (branchExists) {
		if (dirExists) {
			return { kind: "reuse-branch-dir", path: worktreeDir };
		}
		return { kind: "mount-branch", path: worktreeDir };
	}

	if (dirExists) {
		return { kind: "reuse-stale-dir", path: worktreeDir };
	}

	return { kind: "create-fresh", path: worktreeDir };
}
