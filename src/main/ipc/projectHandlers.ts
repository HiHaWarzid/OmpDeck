/**
 * Project IPC handler：项目列表/添加/删除/排序 + 项目资源（skill/extension）管理 + worktree + 聊天目录。
 * `getVisibleProjects` 随命名空间迁移：WSL 模式下只显示 WSL 项目，Chat 项目始终可见。
 * 注意：`projectsListModels` 依赖 pi 基础设施（piLocator），暂留在 index.ts 待 pi 批次提取。
 */
import { type BrowserWindow, dialog } from "electron";
import { ipcChannels, ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { AppSettings, CreateProjectSkillInput, Project } from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import type { AgentManager } from "../pi/AgentManager";
import type { GitService } from "../git/GitService";
import type { WorktreeService } from "../git/WorktreeService";
import type { AppLogger } from "../logging/AppLogger";
import type { WslEnvironment } from "../wsl/WslPaths";

interface ProjectHandlerDeps {
	projectStore: ProjectStore;
	projectResourceManager: ProjectResourceManager;
	settingsStore: { get(): AppSettings };
	appLogger: AppLogger;
	agentManager: AgentManager;
	gitService: GitService;
	worktreeService: WorktreeService;
	getMainWindow: () => BrowserWindow | null;
	getActiveWslEnvironment: () => WslEnvironment | null;
	syncWslEnvironment: (settings: AppSettings) => Promise<WslEnvironment | null>;
}

type ProjectHandlerMaps = {
	projects: Omit<IpcHandlerMap<typeof ipcTable.projects, PiDesktopApi["projects"]>, "onChanged" | "listModels">;
	projectResources: IpcHandlerMap<typeof ipcTable.projectResources, PiDesktopApi["projectResources"]>;
	dialog: IpcHandlerMap<typeof ipcTable.dialog, PiDesktopApi["dialog"]>;
};

export function registerProjectHandlers(deps: ProjectHandlerDeps): ProjectHandlerMaps {
	const {
		projectStore,
		projectResourceManager,
		settingsStore,
		appLogger,
		agentManager,
		gitService,
		worktreeService,
		getMainWindow,
		getActiveWslEnvironment,
		syncWslEnvironment,
	} = deps;

	// 获取当前环境过滤后的项目列表（WSL 模式只显示 WSL 项目，Chat 始终显示）
	const getVisibleProjects = (): Project[] => {
		const settings = settingsStore.get();
		const all = projectStore.list();
		if (settings.wslEnabled) {
			return all.filter((p) => p.kind === "chat" || p.environment === "wsl");
		}
		return all.filter((p) => p.kind === "chat" || !p.environment || p.environment === "windows");
	};

	return {
		projects: {
			list: async () => getVisibleProjects(),
			add: async () => {
				const settings = settingsStore.get();
				const env = settings.wslEnabled ? ("wsl" as const) : ("windows" as const);
				// 上游将 WSL 初始化移到首帧后的后台任务；用户若立即点击添加项目，按需等待同一环境解析。
				const wslEnvironment =
					env === "wsl" ? (getActiveWslEnvironment() ?? (await syncWslEnvironment(settings))) : null;
				const project = await projectStore.chooseAndAdd(env, wslEnvironment);
				void appLogger.info("project", "Project added", {
					projectId: project?.id,
					path: project?.path,
					environment: env,
				});
				return project;
			},
			remove: async (_event, id: string) => {
				// 删除前拦截：项目仍有运行中的 Agent（pi 子进程）时禁止删除，避免进程悬挂后台继续占用资源。
				if (agentManager.hasAgentForProject(id)) {
					throw new Error("PROJECT_HAS_RUNNING_AGENT");
				}
				await projectStore.remove(id);
				void appLogger.info("project", "Project removed", { projectId: id });
				return getVisibleProjects();
			},
			reorder: async (_event, projectIds: string[]) => {
				const result = await projectStore.reorder(projectIds);
				void appLogger.info("project", "Projects reordered", { count: projectIds.length });
				return getVisibleProjects();
			},

			// ── Worktree 项目管理 ──

			listRoot: async () => {
				return projectStore.listRoot();
			},

			listWorktreeChildren: async (_event, parentId: string) => {
				return projectStore.listWorktreeChildren(parentId);
			},

			toggleWorktreeEnabled: async (_event, projectId: string) => {
				const existing = projectStore.get(projectId);
				if (!existing) throw new Error(`Project not found: ${projectId}`);
				// 即将启用时先校验是否 git 仓库；非 git 项目开启工作区模式没有意义，
				// 只会看到空列表并在创建时报错，这里提前给出明确错误让前端提示用户。
				if (!existing.worktreeEnabled) {
					const isRepo = await gitService.isGitRepo(existing.path);
					if (!isRepo) {
						throw new Error("NOT_A_GIT_REPO");
					}
				}
				const project = await projectStore.toggleWorktreeEnabled(projectId);
				if (!project) throw new Error(`Project not found: ${projectId}`);
				// 开启 worktree 模式时，自动注册已有的 git worktree
				if (project.worktreeEnabled) {
					try {
						const entries = await worktreeService.list(project.path);
						for (const wt of entries) {
							// findByPath 返回 null 表示未注册
							if (!projectStore.findByPath(wt.path)) {
								await projectStore.add(wt.path, projectId);
							}
						}
					} catch {
						// worktree 查询失败不阻塞 toggle
					}
				}
				return project;
			},

			// ── 聊天项目目录设置 ──

			chooseChatPath: async () => {
				// 系统文件选择器，默认定位到当前聊天目录，便于用户就地切换。
				const result = await dialog.showOpenDialog({
					title: "选择聊天记录目录",
					defaultPath: projectStore.getChatProjectPath(),
					properties: ["openDirectory"],
				});
				if (result.canceled || result.filePaths.length === 0) return null;
				return result.filePaths[0];
			},

			setChatPath: async (_event, path: string) => {
				if (typeof path !== "string" || path.length === 0) throw new Error("Invalid chat path");
				const project = await projectStore.setChatProjectPath(path);
				// 路径变更后广播项目列表变化，渲染端据此刷新聊天项目的会话。
				getMainWindow()?.webContents.send(ipcChannels.projectsChanged, getVisibleProjects());
				void appLogger.info("project", "Chat project path updated", { path });
				return project;
			},
		},
		projectResources: {
			list: async (_event, projectId: string) => {
				return projectResourceManager.list(projectId);
			},
			createSkill: async (_event, input: CreateProjectSkillInput) => {
				const result = await projectResourceManager.createSkill(input);
				void appLogger.info("project-resource", "Project skill created", {
					projectId: input.projectId,
					name: result.name,
				});
				return result;
			},
			deleteSkill: async (_event, projectId: string, skillPath: string) => {
				// 项目资源删除由 ProjectResourceManager 再次校验路径归属，避免 renderer 传入任意文件路径。
				await projectResourceManager.deleteSkill(projectId, skillPath);
				void appLogger.info("project-resource", "Project skill deleted", { projectId, skillPath });
			},
			deleteExtension: async (_event, projectId: string, extensionPath: string) => {
				// 项目级 extension 是自动发现的本地文件/目录，删除时仅移除项目 .omp/extensions 下对应资源。
				await projectResourceManager.deleteExtension(projectId, extensionPath);
				void appLogger.info("project-resource", "Project extension deleted", {
					projectId,
					extensionPath,
				});
			},
			toggleSkill: async (_event, projectId: string, skillPath: string, enabled: boolean) => {
				const result = await projectResourceManager.toggleSkill(projectId, skillPath, enabled);
				void appLogger.info("project-resource", "Project skill toggled", {
					projectId,
					skillPath,
					enabled,
				});
				return result;
			},
			toggleExtension: async (_event, projectId: string, extensionPath: string, enabled: boolean) => {
				await projectResourceManager.toggleExtension(projectId, extensionPath, enabled);
				void appLogger.info("project-resource", "Project extension toggled", {
					projectId,
					extensionPath,
					enabled,
				});
			},
			renameSkill: async (_event, projectId: string, skillPath: string, newName: string) => {
				const result = await projectResourceManager.renameSkill(projectId, skillPath, newName);
				void appLogger.info("project-resource", "Project skill renamed", {
					projectId,
					skillPath,
					newName,
				});
				return result;
			},
		},
		dialog: {
			pickFiles: async (_event, options?: { title?: string; includeDirectories?: boolean }) => {
				const result = await dialog.showOpenDialog({
					title: options?.title ?? "选择文件或文件夹",
					// Windows 上 openFile 与 openDirectory 并存会退化为「只选文件夹」（FOS_PICKFOLDERS），
					// 附件引用场景以选文件为主，默认只开文件；目录选择由调用方显式开启。
					properties: options?.includeDirectories
						? ["openFile", "openDirectory", "multiSelections"]
						: ["openFile", "multiSelections"],
				});
				return result.canceled ? [] : result.filePaths;
			},
		},
	};
}
