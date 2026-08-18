/**
 * Git IPC handler：分支/提交/暂存/差异/worktree/push/pull/fetch/init 等，
 * 以及依赖 QuickGen 持久化 RPC 进程的 gitGenerateCommitMessage。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册（通道名/协议取自通道表）。
 * projectId → Project 解析统一走 withProjectGuard（resolveProject / withProject）。
 */
import { resolve } from "node:path";
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { AppSettings, GitWorkspaceDiffGroup } from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";
import type { GitService } from "../git/GitService";
import type { WorktreeService } from "../git/WorktreeService";
import type { AppLogger } from "../logging/AppLogger";
import type { QuickGenProcess } from "../pi/QuickGenProcess";
import { perfEnd, perfStart } from "../perf";
import { createProjectGuard } from "./withProjectGuard";

interface GitHandlerDeps {
	projectStore: ProjectStore;
	gitService: GitService;
	settingsStore: { get(): AppSettings };
	worktreeService: WorktreeService;
	appLogger: AppLogger;
	/** 持久化轻量 pi RPC 进程，用于 commit message 等快速文本生成 */
	quickGen: QuickGenProcess;
}

type GitHandlerMaps = {
	git: IpcHandlerMap<typeof ipcTable.git, PiDesktopApi["git"]>;
};

export function registerGitHandlers(deps: GitHandlerDeps): GitHandlerMaps {
	const { projectStore, gitService, settingsStore, worktreeService, appLogger, quickGen } = deps;
	const { resolveProject, withProject } = createProjectGuard(projectStore);

	return {
		git: {
			branches: async (_event, projectId: string) =>
				gitService.getBranches(resolveProject(projectId).path),

			checkout: async (_event, projectId: string, branch: string) =>
				gitService.checkout(resolveProject(projectId).path, branch),

			createBranch: async (_event, projectId: string, branchName: string) =>
				gitService.createBranch(resolveProject(projectId).path, branchName),

			// 差异查看需要文件的 Git HEAD 原始内容作为对比基准；参数是绝对文件路径，后端自行定位仓库根。
			originalContent: async (_event, filePath: string) => {
				const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
				return gitService.getOriginalContent(filePath, maxBytes);
			},

			worktreeList: async (_event, projectId: string) =>
				withProject(projectId, async (project) => {
					const entries = await worktreeService.list(project.path);
					// 每次扫描都同步注册外部新增 worktree，保证侧栏数据和 git 状态一致。
					for (const wt of entries) {
						await projectStore.add(wt.path, projectId);
					}
					return entries;
				}),

			worktreeCreate: async (_event, projectId: string, branchName: string) =>
				withProject(projectId, async (project) => {
					const info = await worktreeService.create(project.path, projectId, branchName);
					await projectStore.add(info.path, projectId);
					return info;
				}),

			worktreeRemove: async (_event, projectId: string, worktreePath: string) =>
				withProject(projectId, async (project) => {
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
				}),

			// -- Git 增强：提交历史 / 分支对比 / Graph
			commitLog: async (
				_event,
				projectId: string,
				options?: { maxEntries?: number; ref?: string; path?: string; allBranches?: boolean },
			) => withProject(projectId, (project) => gitService.getCommitLog(project.path, options), []),

			refs: async (_event, projectId: string) =>
				withProject(projectId, (project) => gitService.getRefs(project.path), []),

			branchCompare: async (_event, projectId: string, base: string, target: string) =>
				gitService.compareBranches(resolveProject(projectId).path, base, target),

			commitDetail: async (_event, projectId: string, ref: string) =>
				withProject(projectId, (project) => gitService.getCommitDetail(project.path, ref), null),

			commitFileDiff: async (
				_event,
				projectId: string,
				ref: string,
				filePath: string,
				originalPath?: string,
			) =>
				withProject(
					projectId,
					(project) => {
						const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
						return gitService.getCommitFileDiff(project.path, ref, filePath, originalPath, maxBytes);
					},
					null,
				),

			diffFileBetween: async (
				_event,
				projectId: string,
				ref1: string,
				ref2: string,
				filePath: string,
			) =>
				withProject(
					projectId,
					(project) => gitService.diffFileBetweenRefs(project.path, ref1, ref2, filePath),
					"",
				),

			// Git 工作区状态 + Stage/Unstage
			status: async (_event, projectId: string) =>
				withProject(
					projectId,
					async (project) => {
						const t0 = perfStart("git:status");
						try {
							const status = await gitService.getStatus(project.path);
							perfEnd("git:status", t0, { projectId });
							return status;
						} catch (error) {
							perfEnd("git:status", t0, { projectId, error: true });
							throw error;
						}
					},
					{ merge: [], index: [], workingTree: [], untracked: [] },
				),

			workspaceFileDiff: async (
				_event,
				projectId: string,
				group: GitWorkspaceDiffGroup,
				filePath: string,
			) =>
				withProject(
					projectId,
					(project) => {
						const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
						return gitService.getWorkspaceFileDiff(project.path, group, filePath, maxBytes);
					},
					null,
				),

			stage: async (_event, projectId: string, paths: string[]) => {
				await gitService.stageFiles(resolveProject(projectId).path, paths);
			},

			unstage: async (_event, projectId: string, paths: string[]) => {
				await gitService.unstageFiles(resolveProject(projectId).path, paths);
			},

			discard: async (
				_event,
				projectId: string,
				group: "workingTree" | "untracked",
				filePath: string,
			) => {
				await gitService.discardFile(resolveProject(projectId).path, group, filePath);
			},

			commit: async (_event, projectId: string, message: string) => {
				await gitService.commit(resolveProject(projectId).path, message);
			},

			cherryPick: async (_event, projectId: string, hash: string) => {
				await gitService.cherryPick(resolveProject(projectId).path, hash);
			},

			revert: async (_event, projectId: string, hash: string) => {
				await gitService.revertCommit(resolveProject(projectId).path, hash);
			},

			reset: async (
				_event,
				projectId: string,
				hash: string,
				mode: "soft" | "mixed" | "hard",
			) => {
				await gitService.resetToCommit(resolveProject(projectId).path, hash, mode);
			},

			dropCommit: async (_event, projectId: string, hash: string) => {
				await gitService.dropCommit(resolveProject(projectId).path, hash);
			},

			// ── push / pull / fetch / init ──

			/**
			 * 基于 staged diff 生成 commit message。
			 * 通过 QuickGen 持久化 RPC 进程调用 pi，避免每次启动新进程的开销。
			 * 提示词模板可在设置中自定义，{diff} 占位符会被替换为 staged diff（截断到 8000 字符）。
			 */
			generateCommitMessage: async (_event, projectId: string) =>
				withProject(
					projectId,
					async (project) => {
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
					"",
				),

			push: async (_event, projectId: string) => {
				await gitService.push(resolveProject(projectId).path);
			},

			pull: async (_event, projectId: string) => {
				await gitService.pull(resolveProject(projectId).path);
			},

			fetch: async (_event, projectId: string) => {
				await gitService.fetch(resolveProject(projectId).path);
			},

			init: async (_event, projectId: string) => {
				const project = resolveProject(projectId);
				const { execFile } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const execFileAsync = promisify(execFile);
				// 初始化仓库并创建 main 分支，生成一个初始空提交
				await execFileAsync("git", ["init"], { cwd: project.path });
				// 此前非 git 仓库的失败状态可能还在冷却缓存内，init 后必须失效，否则抽屉仍提示"非 git 项目"。
				gitService.invalidateStatusCache(project.path);
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
						GIT_AUTHOR_NAME: "OmpDeck",
						GIT_AUTHOR_EMAIL: "ompdeck@local",
						GIT_COMMITTER_NAME: "OmpDeck",
						GIT_COMMITTER_EMAIL: "ompdeck@local",
					},
				});
			},
		},
	};
}