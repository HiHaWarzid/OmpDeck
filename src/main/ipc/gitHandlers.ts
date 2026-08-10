/**
 * Git IPC handler：分支/提交/暂存/差异/worktree/push/pull/fetch/init 等，
 * 以及依赖 QuickGen 持久化 RPC 进程的 gitGenerateCommitMessage。
 */
import { ipcMain } from "electron";
import { resolve } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { AppSettings, GitWorkspaceDiffGroup } from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";
import type { GitService } from "../git/GitService";
import type { WorktreeService } from "../git/WorktreeService";
import type { AppLogger } from "../logging/AppLogger";
import type { QuickGenProcess } from "../pi/QuickGenProcess";

interface GitHandlerDeps {
	projectStore: ProjectStore;
	gitService: GitService;
	settingsStore: { get(): AppSettings };
	worktreeService: WorktreeService;
	appLogger: AppLogger;
	/** 持久化轻量 pi RPC 进程，用于 commit message 等快速文本生成 */
	quickGen: QuickGenProcess;
}

export function registerGitHandlers(deps: GitHandlerDeps) {
	const { projectStore, gitService, settingsStore, worktreeService, appLogger, quickGen } = deps;

	ipcMain.handle(ipcChannels.gitBranches, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return gitService.getBranches(project.path);
	});

	ipcMain.handle(ipcChannels.gitCheckout, async (_event, projectId: string, branch: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return gitService.checkout(project.path, branch);
	});

	ipcMain.handle(ipcChannels.gitCreateBranch, async (_event, projectId: string, branchName: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return gitService.createBranch(project.path, branchName);
	});

	// 差异查看需要文件的 Git HEAD 原始内容作为对比基准；参数是绝对文件路径，后端自行定位仓库根。
	ipcMain.handle(ipcChannels.gitOriginalContent, async (_event, filePath: string) => {
		const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
		return gitService.getOriginalContent(filePath, maxBytes);
	});

	ipcMain.handle(ipcChannels.gitWorktreeList, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const entries = await worktreeService.list(project.path);
		// 每次扫描都同步注册外部新增 worktree，保证侧栏数据和 git 状态一致。
		for (const wt of entries) {
			await projectStore.add(wt.path, projectId);
		}
		return entries;
	});

	ipcMain.handle(ipcChannels.gitWorktreeCreate, async (_event, projectId: string, branchName: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const info = await worktreeService.create(project.path, projectId, branchName);
		await projectStore.add(info.path, projectId);
		return info;
	});

	ipcMain.handle(ipcChannels.gitWorktreeRemove, async (_event, projectId: string, worktreePath: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const ok = await worktreeService.remove(worktreePath, project.path);
		const normalizeForCompare = (value: string) => {
			const resolved = resolve(value);
			return process.platform === "win32" ? resolved.toLowerCase() : resolved;
		};
		const normalizedTarget = normalizeForCompare(worktreePath);
		const stillInGit = (await worktreeService.list(project.path)).some(
			(entry) => normalizeForCompare(entry.path) === normalizedTarget,
		);
		// 如果 git 已经没有该 worktree（包括用户在外部删过导致 remove 返回 false），
		// 也要清理 OmpDeck 项目记录，否则重启后会从 projects.json 恢复成"删不掉"。
		if (ok || !stillInGit) {
			const child = projectStore.findByPath(worktreePath);
			if (child) await projectStore.remove(child.id);
			return true;
		}
		return false;
	});

	// -- Git 增强：提交历史 / 分支对比 / Graph
	ipcMain.handle(
		ipcChannels.gitCommitLog,
		async (
			_event,
			projectId: string,
			options?: { maxEntries?: number; ref?: string; path?: string; allBranches?: boolean },
		) => {
			const project = projectStore.get(projectId);
			if (!project) return [];
			return gitService.getCommitLog(project.path, options);
		},
	);

	ipcMain.handle(ipcChannels.gitRefs, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) return [];
		return gitService.getRefs(project.path);
	});

	ipcMain.handle(ipcChannels.gitBranchCompare, async (_event, projectId: string, base: string, target: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return gitService.compareBranches(project.path, base, target);
	});

	ipcMain.handle(ipcChannels.gitCommitDetail, async (_event, projectId: string, ref: string) => {
		const project = projectStore.get(projectId);
		if (!project) return null;
		return gitService.getCommitDetail(project.path, ref);
	});

	ipcMain.handle(
		ipcChannels.gitCommitFileDiff,
		async (_event, projectId: string, ref: string, filePath: string, originalPath?: string) => {
			const project = projectStore.get(projectId);
			if (!project) return null;
			const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
			return gitService.getCommitFileDiff(project.path, ref, filePath, originalPath, maxBytes);
		},
	);

	ipcMain.handle(
		ipcChannels.gitDiffFileBetween,
		async (_event, projectId: string, ref1: string, ref2: string, filePath: string) => {
			const project = projectStore.get(projectId);
			if (!project) return "";
			return gitService.diffFileBetweenRefs(project.path, ref1, ref2, filePath);
		},
	);

	// Git 工作区状态 + Stage/Unstage
	ipcMain.handle(ipcChannels.gitStatus, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) return { merge: [], index: [], workingTree: [], untracked: [] };
		return gitService.getStatus(project.path);
	});

	ipcMain.handle(
		ipcChannels.gitWorkspaceFileDiff,
		async (_event, projectId: string, group: GitWorkspaceDiffGroup, filePath: string) => {
			const project = projectStore.get(projectId);
			if (!project) return null;
			const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
			return gitService.getWorkspaceFileDiff(project.path, group, filePath, maxBytes);
		},
	);

	ipcMain.handle(ipcChannels.gitStage, async (_event, projectId: string, paths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.stageFiles(project.path, paths);
	});

	ipcMain.handle(ipcChannels.gitUnstage, async (_event, projectId: string, paths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.unstageFiles(project.path, paths);
	});

	ipcMain.handle(
		ipcChannels.gitDiscard,
		async (_event, projectId: string, group: "workingTree" | "untracked", filePath: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.discardFile(project.path, group, filePath);
		},
	);

	ipcMain.handle(ipcChannels.gitCommit, async (_event, projectId: string, message: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.commit(project.path, message);
	});

	ipcMain.handle(ipcChannels.gitCherryPick, async (_event, projectId: string, hash: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.cherryPick(project.path, hash);
	});

	ipcMain.handle(ipcChannels.gitRevert, async (_event, projectId: string, hash: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.revertCommit(project.path, hash);
	});

	ipcMain.handle(
		ipcChannels.gitReset,
		async (_event, projectId: string, hash: string, mode: "soft" | "mixed" | "hard") => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			await gitService.resetToCommit(project.path, hash, mode);
		},
	);

	ipcMain.handle(ipcChannels.gitDropCommit, async (_event, projectId: string, hash: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.dropCommit(project.path, hash);
	});

	// ── push / pull / fetch / init ──

	/**
	 * 基于 staged diff 生成 commit message。
	 * 通过 QuickGen 持久化 RPC 进程调用 pi，避免每次启动新进程的开销。
	 * 提示词模板可在设置中自定义，{diff} 占位符会被替换为 staged diff（截断到 8000 字符）。
	 */
	ipcMain.handle(
		ipcChannels.gitGenerateCommitMessage,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) return "";

			const diff = await gitService.getStagedDiff(project.path, 10000);
			if (!diff.trim()) return "";

			const promptTemplate = settingsStore.get().gitCommitMessagePrompt ||
				"请根据以下 git diff 生成一条中文 git commit message。\n\n{diff}\n\n直接输出 commit 消息。";
			const prompt = promptTemplate.replace("{diff}", diff.slice(0, 8000));

			try {
				const result = await quickGen.generate(project.path, prompt);
				void appLogger.warn("git", "Generate commit message result", {
					length: result.length,
					text: result.slice(0, 100),
				});
				return result.trim();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				void appLogger.warn("git", "Generate commit message failed", { error: msg });
				throw err;
			}
		},
	);

	ipcMain.handle(ipcChannels.gitPush, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.push(project.path);
	});

	ipcMain.handle(ipcChannels.gitPull, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.pull(project.path);
	});

	ipcMain.handle(ipcChannels.gitFetch, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		await gitService.fetch(project.path);
	});

	ipcMain.handle(ipcChannels.gitInit, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		// 初始化仓库并创建 main 分支，生成一个初始空提交
		await execFileAsync("git", ["init"], { cwd: project.path });
		try {
			await execFileAsync("git", ["checkout", "-b", "main"], { cwd: project.path });
		} catch {
			// 部分 git 版本在无提交时 checkout -b 可能失败，改用 branch -M
			await execFileAsync("git", ["branch", "-M", "main"], { cwd: project.path });
		}
		await execFileAsync("git", ["commit", "--allow-empty", "-m", "Initial commit"], {
			cwd: project.path,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "PiDeck",
				GIT_AUTHOR_EMAIL: "pideck@local",
				GIT_COMMITTER_NAME: "PiDeck",
				GIT_COMMITTER_EMAIL: "pideck@local",
			},
		});
	});
}
