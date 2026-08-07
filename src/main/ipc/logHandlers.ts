/**
 * 日志相关 IPC handler：app 日志 + RPC 日志。
 * rpcLoggingSet/Get 依赖 agentManager，留在 index.ts 随 agentHandlers 迁移。
 */
import { ipcMain, app, shell } from "electron";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { AppLogQuery, AppLogLevel } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcLogger } from "../logging/RpcLogger";

interface LogHandlerDeps {
	appLogger: AppLogger;
	rpcLogger: RpcLogger;
}

export function registerLogHandlers(deps: LogHandlerDeps) {
	const { appLogger, rpcLogger } = deps;

	ipcMain.handle(ipcChannels.logsList, async (_event, query: AppLogQuery) =>
		appLogger.list(query),
	);
	ipcMain.handle(
		ipcChannels.rendererLog,
		async (
			_event,
			level: AppLogLevel,
			scope: string,
			message: string,
			detail?: unknown,
		) => {
			const safeLevel = ["debug", "info", "warn", "error"].includes(level)
				? level
				: "info";
			await appLogger.log(safeLevel as AppLogLevel, scope, message, detail);
		},
	);
	ipcMain.handle(ipcChannels.logsClear, async () => appLogger.clear());
	ipcMain.handle(ipcChannels.logsOpenFolder, async () => appLogger.openFolder());
	/** 获取 app 日志文件总大小 */
	ipcMain.handle(ipcChannels.logsSize, async () => appLogger.getSize());
	/** 获取 RPC 日志文件总大小，可选按 agentId 过滤 */
	ipcMain.handle(ipcChannels.rpcLogsGetSize, async (_event, agentId?: string) => rpcLogger.getSize(agentId));
	/** 从文件读取 RPC 日志，可选按 agentId/日期范围过滤 */
	ipcMain.handle(ipcChannels.rpcLogsGet, async (_event, options?: { agentId?: string; days?: number; limit?: number }) => rpcLogger.getFromFile(options));
	/** 清空 RPC 日志文件，可选按 agentId 过滤 */
	ipcMain.handle(ipcChannels.rpcLogsClear, async (_event, agentId?: string) => rpcLogger.clear(agentId));
	/** 用默认编辑器打开某 agent 的 RPC 日志文件 */
	ipcMain.handle(ipcChannels.rpcLogsOpenFile, async (_event, _agentId: string) => {
		const dir = join(app.getPath("userData"), "logs", "rpc");
		await shell.openPath(dir);
	});
}
