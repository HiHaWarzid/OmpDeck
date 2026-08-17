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
	 * AFK 专用 worktree 创建：分支 afk-{ticketId}-{slug}（- 分隔，slug 取自 issue title）。
	 * 与 create() 不同：目录/分支碰撞时**复用**而非抛错（重跑从 [afk-wip] commit 继续，见 CONTEXT.md）。
	 *
	 * 复用语义（精确）：
	 * - git 里已有该分支的 worktree → 返回它的实际路径（可能不在目标目录）；
	 * - 分支已存在但未挂 worktree → 复用分支（重新挂载到目标目录，或直接复用已存在的老目录）；
	 * - 目录已存在但 git 无登记、分支也不存在 → 复用老目录路径；
	 * - 以上皆否 → 全新创建（git worktree add --no-checkout -b + reset --hard）。
	 * 目标目录已被登记成其他分支的 worktree 时无法复用，明确报错。
	 */
	async createAfk(
		projectPath: string,
		ticketId: number,
		title: string,
	): Promise<{ path: string; branch: string; reused: boolean }> {
		const slug = this.slugify(title);
		const branch = `afk-${ticketId}-${slug}`;
		// worktree 放在项目目录同级：{dirname(projectPath)}/{branch}，目录名与分支名一致。
		const worktreeDir = join(resolve(projectPath, ".."), branch);

		const entries = await this.list(projectPath);

		// 分支已挂在某个 worktree 上（含上次超时/崩溃残留、或挂在其他路径的情况）：
		// 直接复用其实际路径，重跑从该分支的 [afk-wip] commit 继续（ADR-0003）。
		const existing = entries.find(entry => entry.branch === branch);
		if (existing) {
			return { path: existing.path, branch, reused: true };
		}

		// 目标目录已是 worktree 但挂的是别的分支：不能复用（会跑错分支），明确报错而非静默错用。
		const dirOccupied = entries.find(entry => this.samePath(entry.path, worktreeDir));
		if (dirOccupied) {
			throw new Error(`AFK 目录已被其他分支占用：${worktreeDir}（${dirOccupied.branch}）`);
		}

		const branchExists = await execFileAsync(
			"git",
			["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
			{ cwd: projectPath },
		)
			.then(() => true)
			.catch(() => false);

		if (branchExists) {
			// 分支存在但未挂任何 worktree（如上次 remove() 清了目录但分支保留，或创建中断残留）：
			// 复用分支。老目录已存在则直接复用目录路径；否则重新挂载 worktree 指向该分支
			// （分支已存在，不能加 -b，与新建路径不同）。
			if (existsSync(worktreeDir)) {
				return { path: worktreeDir, branch, reused: true };
			}
			await execFileAsync("git", ["worktree", "add", "--no-checkout", worktreeDir, branch], { cwd: projectPath });
			try {
				await execFileAsync("git", ["reset", "--hard"], { cwd: worktreeDir });
			} catch (error) {
				// 挂载失败：只摘除 worktree、不删分支——分支上可能有 [afk-wip] WIP，
				// 不能走 remove()（其 branch === 目录名 判定会 branch -D 抹掉 WIP，违反 ADR-0003）。
				await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: projectPath }).catch(() => undefined);
				await rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
			return { path: worktreeDir, branch, reused: true };
		}

		// 老目录：目录存在但 git 无登记、分支也不存在（上次创建中断残留）→ 按复用语义直接返回目录路径。
		if (existsSync(worktreeDir)) {
			return { path: worktreeDir, branch, reused: true };
		}

		// 全新创建：复用现有 create 的步骤（--no-checkout -b + reset --hard）。
		// 不能走 allocateWorktreeTarget——它目录/分支碰撞即抛错，与 AFK 的复用语义冲突。
		await execFileAsync("git", ["worktree", "add", "--no-checkout", "-b", branch, worktreeDir], { cwd: projectPath });
		try {
			await execFileAsync("git", ["reset", "--hard"], { cwd: worktreeDir });
		} catch (error) {
			// reset 失败时清理刚创建的 worktree（与 create() 一致；此分支是本方法刚建的，无 WIP 可丢）。
			await this.remove(worktreeDir, projectPath).catch(() => false);
			throw error;
		}
		return { path: worktreeDir, branch, reused: false };
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
	 * AFK 删除前保留 WIP：git add -A && git commit -m "[afk-wip] #{ticketRef}"（无变更跳过），
	 * 再调 remove()。永不裸删抹工作树（ADR-0003）。
	 * 返回值透传 remove()：worktree 未登记时返回 false。
	 */
	async removeWithWip(worktreePath: string, projectPath: string, ticketRef: number): Promise<boolean> {
		// ADR-0003：删 worktree 前必须先把未提交改动快照成 [afk-wip] commit，留在 afk 分支供重跑复用。
		// 工作树干净时跳过（无变更不产生 commit）；快照失败则中止删除——宁可保留 worktree
		// 等重跑复用，也不裸删抹掉进度（崩溃/超时场景，见 CONTEXT.md Retry）。
		const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: worktreePath });
		if (stdout.trim()) {
			await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
			// commit 失败忽略（无变更 / 钩子拦截 / 作者配置缺失）：WIP 快照 best-effort，
			// 不因快照失败阻塞删除流程。
			await execFileAsync("git", ["commit", "-m", `[afk-wip] #${ticketRef}`], { cwd: worktreePath })
				.catch(() => undefined);
		}
		// 快照完成后才允许裸删：remove() 内部就是 worktree remove --force + rm -rf + branch -D
		// （afk 分支名 === 目录名，命中 branch -D，本地分支随 remove 删除）。
		return this.remove(worktreePath, projectPath);
	}

	/**
	 * PR 合并后删除远程 afk 分支（P0 半人工：UI「已合并」触发；本地分支随 remove 已删，见 ADR-0006）。
	 */
	async gcBranch(projectPath: string, branch: string): Promise<void> {
		// ADR-0006 分支 GC：PR 合并由人确认后删除远程分支；分支可能已被别人删过 → 失败忽略。
		await execFileAsync("git", ["push", "origin", "--delete", branch], { cwd: projectPath })
			.catch(() => undefined);
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