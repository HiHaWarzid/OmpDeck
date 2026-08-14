/**
 * Session IPC handler：会话列表/重命名/复制/导出/删除/读取 + codex/claude/opencode 会话扫描与导入。
 * 会话读取由 SessionScanner 统一处理本地/WSL 文件；消息转换复用 AgentManager。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册（通道名/协议取自通道表）。
 */
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { ImportPipeline } from "../sessions/importPipeline";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import { perfEnd, perfStart } from "../perf";

interface SessionHandlerDeps {
	projectStore: ProjectStore;
	sessionScanner: SessionScanner;
	importPipeline: ImportPipeline;
	agentManager: AgentManager;
	appLogger: AppLogger;
}

type SessionHandlerMaps = {
	sessions: IpcHandlerMap<typeof ipcTable.sessions, PiDesktopApi["sessions"]>;
	codexSessions: IpcHandlerMap<typeof ipcTable.codexSessions, PiDesktopApi["codexSessions"]>;
	claudeSessions: IpcHandlerMap<typeof ipcTable.claudeSessions, PiDesktopApi["claudeSessions"]>;
	openCodeSessions: IpcHandlerMap<typeof ipcTable.openCodeSessions, PiDesktopApi["openCodeSessions"]>;
};

export function registerSessionHandlers(deps: SessionHandlerDeps): SessionHandlerMaps {
	const { projectStore, sessionScanner, importPipeline, agentManager, appLogger } = deps;

	return {
		sessions: {
			list: async (_event, projectId?: string) => {
				const t0 = perfStart("sessions:list");
				try {
					const project = projectId ? projectStore.get(projectId) : undefined;
					const result = await sessionScanner.list(project?.path);
					perfEnd("sessions:list", t0, { projectId, files: result.length });
					return result;
				} catch (error) {
					perfEnd("sessions:list", t0, { projectId, error: true });
					// 会话列表是核心加载路径，失败时记录错误便于诊断，同时保留 rejection 供 renderer 提示用户。
					void appLogger.error("session", "Failed to list sessions", { projectId, error });
					throw error;
				}
			},
			rename: async (_event, filePath: string, newName: string) => {
				await sessionScanner.rename(filePath, newName);
				void appLogger.info("session", "Session renamed", { filePath, newName });
			},
			copy: (_event, projectId: string, filePath: string) =>
				agentManager.cloneSessionFile(projectId, filePath),
			exportHtml: async (_event, projectId: string, filePath: string) =>
				// pi RPC export_html 返回 { path }（data 未在 AgentManager 侧定型，此处收敛）
				agentManager.exportSessionHtml(projectId, filePath) as Promise<{ path: string }>,
			delete: async (_event, filePath: string) => {
				// 检查是否有活跃 Agent 正在使用该会话文件；如有则拒绝删除，避免 pi 进程访问已删除文件。
				const normalizedTarget = filePath.replace(/\\/g, "/").toLowerCase();
				const activeAgents = agentManager.list();
				const usingAgent = activeAgents.find((agent) => {
					const sessionPath = agent.sessionPath?.replace(/\\/g, "/").toLowerCase();
					return sessionPath === normalizedTarget;
				});
				if (usingAgent) {
					throw new Error(`会话"${usingAgent.title}"正在使用中，请先关闭 Agent 后再删除`);
				}

				await sessionScanner.delete(filePath);
				void appLogger.info("session", "Session deleted", { filePath });
			},
			readMessages: async (_event, filePath: string) => {
				return sessionScanner.readMessages(filePath);
			},
			// 提取会话文件里最近的用户消息文本（最新在前），供渲染层补全上下键 prompt history。
			// 与 readMessages 不同：只读文件尾部窗口 + 纯文本提取，大会话也不会整文件解析。
			readUserPrompts: async (_event, filePath: string, maxCount?: number) =>
				// 内部按 maxCount|0 收敛（undefined→1 条）；传 0 与 undefined 行为等价
				agentManager.readSessionUserPrompts(filePath, maxCount ?? 0),
			readSessionMeta: async (_event, filePath: string) => {
				return sessionScanner.readSessionMeta(filePath);
			},
			readChatMessages: async (_event, filePath: string) => {
				// SessionScanner 统一处理本地/WSL 文件读取；消息转换与压缩归档完全复用 AgentManager。
				const content = await sessionScanner.readSessionRawText(filePath);
				return agentManager.readSessionDisplayMessages(filePath, "_viewer", content);
			},
			readMessageFullText: async (_event, agentId, messageId, entryId?) => {
				// 入参校验在边界（渲染层数据不可信），agentId/messageId 必须为非空字符串
				if (typeof agentId !== "string" || !agentId.trim() || typeof messageId !== "string" || !messageId.trim()) {
					throw new Error("Invalid message full-text request");
				}
				if (entryId !== undefined && (typeof entryId !== "string" || !entryId.trim())) {
					throw new Error("Invalid entryId");
				}
				return agentManager.readMessageFullText(agentId, messageId, entryId as string | undefined);
			},
		},

		// ── Codex / Claude / OpenCode 会话导入 ──
		codexSessions: {
			scan: async (_event, projectId: string) => {
				const project = projectStore.get(projectId);
				if (!project) throw new Error(`Project not found: ${projectId}`);
				return importPipeline.scan("codex", project.path);
			},
			import: async (_event, projectId: string, sourcePaths: string[]) => {
				const project = projectStore.get(projectId);
				if (!project) throw new Error(`Project not found: ${projectId}`);
				return importPipeline.import("codex", project.path, sourcePaths);
			},
		},
		claudeSessions: {
			scan: async (_event, projectId: string) => {
				const project = projectStore.get(projectId);
				if (!project) throw new Error(`Project not found: ${projectId}`);
				return importPipeline.scan("claude", project.path);
			},
			import: async (_event, projectId: string, sourcePaths: string[]) => {
				const project = projectStore.get(projectId);
				if (!project) throw new Error(`Project not found: ${projectId}`);
				return importPipeline.import("claude", project.path, sourcePaths);
			},
		},
		openCodeSessions: {
			scan: async (_event, projectId: string) => {
				const project = projectStore.get(projectId);
				if (!project) throw new Error(`Project not found: ${projectId}`);
				return importPipeline.scan("opencode", project.path);
			},
			import: async (_event, projectId: string, sourcePaths: string[]) => {
				const project = projectStore.get(projectId);
				if (!project) throw new Error(`Project not found: ${projectId}`);
				return importPipeline.import("opencode", project.path, sourcePaths);
			},
		},
	};
}
