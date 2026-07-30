import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorktreeEntry } from "../../shared/types";

const execFileAsync = promisify(execFile);

/**
 * 管理 git worktree 的创建、查询、删除。
 *
 * 工作树目录创建在项目目录的同级位置（标准 git worktree 行为）：
 * {dirname(projectPath)}/{slug}，目录名与分支名一致，
 * 用户可以直接在文件管理器中找到 worktree 文件。
 */
export class WorktreeService {
	/**
	 * 获取指定项目仓库的所有 worktree（排除主工作区）。
	 * 使用 git worktree list --porcelain 解析。
	 */
	async list(projectPath: string): Promise<WorktreeEntry[]> {
		try {
			const { stdout } = await execFileAsync(
				"git",
				["worktree", "list", "--porcelain"],
				{ cwd: projectPath },
			);
			return this.parseWorktreeList(stdout, projectPath);
		} catch {
			// 非 git 目录或 git 未安装
			return [];
		}
	}

	/**
	 * 基于当前 HEAD 创建新的 worktree。
	 * 使用 OpenCode 的方式：--no-checkout -b {branch} 创建分支，再 git reset --hard 填充。
	 */
	async create(
		projectPath: string,
		projectId: string,
		branchName: string,
	): Promise<{ path: string; branch: string }> {
		const baseSlug = this.slugify(branchName);
		// worktree 放在项目目录的同级位置：{dirname(projectPath)}/{slug}
		// 这样用户可以在项目同级目录下直接找到 worktree 文件，符合标准 git worktree 习惯。
		const parentDir = resolve(projectPath, "..");

		const { worktreeDir, branch } = await this.allocateWorktreeTarget(projectPath, parentDir, baseSlug);

		// 创建 worktree（仅创建目录结构，不 checkout），再 reset --hard 填充内容。
		await execFileAsync(
			"git",
			["worktree", "add", "--no-checkout", "-b", branch, worktreeDir],
			{ cwd: projectPath },
		);

		try {
			await execFileAsync("git", ["reset", "--hard"], { cwd: worktreeDir });
		} catch (error) {
			// reset 失败时清理刚创建的 worktree，避免残留半初始化目录。
			await this.remove(worktreeDir, projectPath).catch(() => false);
			throw error;
		}

		return { path: worktreeDir, branch };
	}

	/**
	 * 删除指定 worktree。
	 * 先 git worktree remove --force，再清理目录，最后删除对应的分支。
	 */
	async remove(worktreePath: string, projectPath: string): Promise<boolean> {
		const entries = await this.list(projectPath);
		const normalizedTarget = await this.canonical(worktreePath);
		const entry = entries.find(asyncEntry => this.samePath(asyncEntry.path, normalizedTarget));
		if (!entry) return false;
		const branch = entry.branch;

		try {
			await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectPath });
		} catch {
			// git 的记录可能已损坏；后续仍尝试清理目录，但不吞掉路径保护。
		}

		try {
			await rm(worktreePath, { recursive: true, force: true });
		} catch {
			return false;
		}

		// 删除 OmpDeck 创建的分支：旧版本使用 pideck/{slug}，新版本使用 ompdeck/{slug}。
		// 对外部 worktree 尽量保守，只在“分支名等于目录名”时认为是 OmpDeck 创建的同名工作区。
		const worktreeDirName = basename(worktreePath);
		if (branch?.startsWith("ompdeck/") || branch?.startsWith("pideck/") || branch === worktreeDirName) {
			await execFileAsync("git", ["branch", "-D", branch], { cwd: projectPath }).catch(() => undefined);
		}

		return true;
	}

	/**
	 * 生成目标目录名和分支名。
	 * 不再静默追加 -a/-b：用户输入 test 就只尝试创建 test，
	 * 若同级目录或分支已存在则明确报错，避免最终出现非用户预期的 test-a。
	 */
	private async allocateWorktreeTarget(projectPath: string, parentDir: string, baseSlug: string) {
		const slug = baseSlug;
		const worktreeDir = join(parentDir, slug);
		const branch = slug;
		if (existsSync(worktreeDir)) {
			throw new Error(`工作区目录已存在：${worktreeDir}`);
		}
		const ref = await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: projectPath })
			.then(() => true)
			.catch(() => false);
		if (ref) {
			throw new Error(`分支已存在：${branch}`);
		}
		return { worktreeDir, branch };
	}

	/**
	 * 把用户输入转换为合法的 worktree 目录名 / 分支名 slug。
	 * 保留 Unicode 字母与数字（如中文、日文），只把空格、/、~、: 等 git 分支
	 * 非法字符以及文件系统不友好的字符替换为 -，避免中文分支名被吞成 workspace。
	 */
	private slugify(input: string): string {
		return input
			.trim()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "")
			|| "workspace";
	}


	/**
	 * 解析 git worktree list --porcelain 输出。
	 * 过滤掉主工作区（projectPath），只返回其他 worktree。
	 */
	private parseWorktreeList(stdout: string, projectPath: string): WorktreeEntry[] {
		const entries: WorktreeEntry[] = [];
		// 规范化路径用于比较（Windows 忽略大小写）
		const normalizedRoot = this.canonicalSync(projectPath);

		const lines = stdout.split(/\r?\n/);
		let current: Partial<WorktreeEntry> | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				// 空行 = 条目结束
				if (current) {
					const path = current.path ? resolve(current.path) : "";
					if (!this.samePath(path, normalizedRoot)) {
						entries.push({
							path,
							branch: current.branch?.replace(/^refs\/heads\//, "") ?? "detached",
						});
					}
					current = null;
				}
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

		// 处理最后一条（文件可能不以空行结尾）
		if (current) {
			const path = current.path ? resolve(current.path) : "";
			if (!this.samePath(path, normalizedRoot)) {
				entries.push({
					path,
					branch: current.branch?.replace(/^refs\/heads\//, "") ?? "detached",
				});
			}
		}

		return entries;
	}

	private canonicalSync(input: string) {
		const normalized = resolve(input);
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	}

	private async canonical(input: string) {
		const resolved = resolve(input);
		const real = await realpath(resolved).catch(() => resolved);
		return process.platform === "win32" ? real.toLowerCase() : real;
	}

	private samePath(a: string, b: string) {
		return this.canonicalSync(a) === this.canonicalSync(b);
	}
}