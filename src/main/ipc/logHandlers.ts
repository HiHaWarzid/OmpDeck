/**
 * 日志相关 IPC handler：app 日志 + RPC 日志。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册（通道名/协议取自通道表）。
 */
import { app, shell } from "electron";
import { join } from "node:path";
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { AppLogQuery, AppLogLevel } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcLogger } from "../logging/RpcLogger";

interface LogHandlerDeps {
	appLogger: AppLogger;
	rpcLogger: RpcLogger;
}

type LogHandlerMaps = {
	logs: IpcHandlerMap<typeof ipcTable.logs, PiDesktopApi["logs"]>;
	// setLogging/getLogging 依赖 agentManager，由 appHandlers 注册
	rpcLogs: Pick<IpcHandlerMap<typeof ipcTable.rpcLogs, PiDesktopApi["rpcLogs"]>, "getSize" | "get" | "clear" | "openFile">;
	app: Pick<IpcHandlerMap<typeof ipcTable.app, PiDesktopApi["app"]>, "rendererLog">;
};

export function registerLogHandlers(deps: LogHandlerDeps): LogHandlerMaps {
	const { appLogger, rpcLogger } = deps;

	return {
		logs: {
			// logs.list 是 pack 成员：preload 侧打包保证 query 始终是对象（query ?? {}），按已知形状收窄
			list: async (_event, query) => appLogger.list((query ?? {}) as AppLogQuery),
			clear: async () => appLogger.clear(),
			openFolder: async () => appLogger.openFolder(),
			/** 获取 app 日志文件总大小 */
			getSize: async () => appLogger.getSize(),
		},
		rpcLogs: {
			/** 获取 RPC 日志文件总大小，可选按 agentId 过滤 */
			getSize: async (_event, agentId) => rpcLogger.getSize(agentId),
			/** 从文件读取 RPC 日志，可选按 agentId/日期范围过滤 */
			get: async (_event, options) => rpcLogger.getFromFile(options),
			/** 清空 RPC 日志文件，可选按 agentId 过滤 */
			clear: async (_event, agentId) => rpcLogger.clear(agentId),
			/** 用默认编辑器打开某 agent 的 RPC 日志文件 */
			openFile: async (_event, _agentId) => {
				const dir = join(app.getPath("userData"), "logs", "rpc");
				await shell.openPath(dir);
			},
		},
		app: {
			rendererLog: async (_event, level, scope, message, detail) => {
				const safeLevel = ["debug", "info", "warn", "error"].includes(level)
					? level
					: "info";
				await appLogger.log(safeLevel as AppLogLevel, scope, message, detail);
			},
		},
	};
}
