/**
 * 终端 IPC handler：list/ensure/create/input/resize/close/shells。
 *
 * ensure/create 对 pending-* 占位 id 软失败返回空列表，
 * 避免渲染层 pending→real 切换瞬间 IPC reject 导致 unhandledrejection。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册。
 */
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { TerminalShell } from "../../shared/types";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { AppLogger } from "../logging/AppLogger";

interface TerminalHandlerDeps {
	terminalManager: TerminalSessionManager;
	appLogger: AppLogger;
}

type TerminalHandlerMaps = {
	terminal: IpcHandlerMap<typeof ipcTable.terminal, PiDesktopApi["terminal"]>;
};

export function registerTerminalHandlers(deps: TerminalHandlerDeps): TerminalHandlerMaps {
	const { terminalManager, appLogger } = deps;

	return {
		terminal: {
			list: async (_event, agentId: string) => terminalManager.list(agentId),
			/**
			 * terminal ensure 依赖 agentManager.getCwd(agentId)。
			 * 渲染层 pending-* 占位 id 或 agent 刚销毁时会抛 Agent not found；
			 * 这里软失败返回空列表，避免 IPC reject → renderer unhandledrejection
			 * （Mac 上用户感知为「一启动 agent 就闪退/报错」）。
			 */
			ensure: async (_event, agentId: string, cwd?: string) => {
				if (typeof agentId === "string" && agentId.startsWith("pending-")) return [];
				try {
					return terminalManager.ensure(agentId, cwd);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (/Agent not found/i.test(message)) {
						void appLogger.warn("terminal", "terminal:ensure skipped, agent not ready", {
							agentId,
							error: message,
						});
						return [];
					}
					throw error;
				}
			},
			create: async (_event, agentId: string, shell?: string, cwd?: string) => {
				if (typeof agentId === "string" && agentId.startsWith("pending-")) {
					throw new Error("Terminal is not ready while agent is still starting");
				}
				try {
					const result = terminalManager.create(agentId, shell as TerminalShell | undefined, cwd);
					void appLogger.info("terminal", "Terminal created", { agentId, tabId: result.id, shell });
					return result;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (/Agent not found/i.test(message)) {
						throw new Error("Terminal is not ready: agent not found");
					}
					throw error;
				}
			},
			input: async (_event, tabId: string, data: string) => {
				terminalManager.input(tabId, data);
			},
			resize: async (_event, tabId: string, cols: number, rows: number) => {
				terminalManager.resize(tabId, cols, rows);
			},
			close: async (_event, tabId: string) => {
				terminalManager.close(tabId);
				void appLogger.info("terminal", "Terminal closed", { tabId });
			},
			shells: async () => {
				return terminalManager.listShells();
			},
		},
	};
}
