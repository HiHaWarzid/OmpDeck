/**
 * AFK IPC handler（afk:status / afk:start / afk:stop）。
 * subscribe 成员（onStatusChanged / onTicketCompleted）不在此注册——它们是主进程主动推送
 * （ipcChannels.afkStatusChanged / afkTicketCompleted，由 AfkOrchestrator 经 getMainWindow
 * 推给 renderer），与 feishuHandlers.broadcastBotsChanged 的推送模式一致。
 */
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { AfkOrchestrator } from "./AfkOrchestrator";

export interface AfkHandlerDeps {
	orchestrator: AfkOrchestrator;
}

type AfkHandlerMaps = {
	afk: IpcHandlerMap<typeof ipcTable.afk, PiDesktopApi["afk"]>;
};

export function registerAfkHandlers(deps: AfkHandlerDeps): AfkHandlerMaps {
	const { orchestrator } = deps;
	return {
		afk: {
			/** 快照：运行态 + 历史归档 */
			status: async () => orchestrator.getState(),
			/** 启用/恢复轮询（enabled 持久化在 AppSettings.afk） */
			start: async () => {
				await orchestrator.start();
			},
			/** 停用：停止轮询与新任务派发；已在跑的任务保持运行到终态 */
			stop: async () => {
				await orchestrator.stop();
			},
		},
	};
}
