/**
 * Session IPC handler：会话列表/重命名/复制/导出/删除/读取 + codex/claude/opencode 会话扫描与导入。
 * 会话读取由 SessionScanner 统一处理本地/WSL 文件；消息转换复用 AgentManager。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { ImportPipeline } from "../sessions/importPipeline";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";

interface SessionHandlerDeps {
	projectStore: ProjectStore;
	sessionScanner: SessionScanner;
	importPipeline: ImportPipeline;
	agentManager: AgentManager;
	appLogger: AppLogger;
}

export function registerSessionHandlers(deps: SessionHandlerDeps) {
	const { projectStore, sessionScanner, importPipeline, agentManager, appLogger } = deps;

	ipcMain.handle(ipcChannels.sessionsList, async (_event, projectId?: string) => {
		const project = projectId ? projectStore.get(projectId) : undefined;
		return sessionScanner.list(project?.path);
	});
	ipcMain.handle(ipcChannels.sessionsRename, async (_event, filePath: string, newName: string) => {
		await sessionScanner.rename(filePath, newName);
		void appLogger.info("session", "Session renamed", { filePath, newName });
	});
	ipcMain.handle(ipcChannels.sessionsCopy, (_event, projectId: string, filePath: string) =>
		agentManager.cloneSessionFile(projectId, filePath),
	);
	ipcMain.handle(ipcChannels.sessionsExportHtml, (_event, projectId: string, filePath: string) =>
		agentManager.exportSessionHtml(projectId, filePath),
	);
	ipcMain.handle(ipcChannels.sessionsDelete, async (_event, filePath: string) => {
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
	});
	ipcMain.handle(ipcChannels.sessionsReadMessages, async (_event, filePath: string) => {
		return sessionScanner.readMessages(filePath);
	});
	ipcMain.handle(ipcChannels.sessionsReadMeta, async (_event, filePath: string) => {
		return sessionScanner.readSessionMeta(filePath);
	});
	ipcMain.handle(ipcChannels.sessionsReadChatMessages, async (_event, filePath: string) => {
		// SessionScanner 统一处理本地/WSL 文件读取；消息转换与压缩归档完全复用 AgentManager。
		const content = await sessionScanner.readSessionRawText(filePath);
		return agentManager.readSessionDisplayMessages(filePath, "_viewer", content);
	});

	// ── Codex / Claude / OpenCode 会话导入 ──
	ipcMain.handle(ipcChannels.codexSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return importPipeline.scan("codex", project.path);
	});
	ipcMain.handle(ipcChannels.codexSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return importPipeline.import("codex", project.path, sourcePaths);
	});
	ipcMain.handle(ipcChannels.claudeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return importPipeline.scan("claude", project.path);
	});
	ipcMain.handle(ipcChannels.claudeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return importPipeline.import("claude", project.path, sourcePaths);
	});
	ipcMain.handle(ipcChannels.openCodeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return importPipeline.scan("opencode", project.path);
	});
	ipcMain.handle(ipcChannels.openCodeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return importPipeline.import("opencode", project.path, sourcePaths);
	});
}
