/**
 * AFK IPC handler（afk:status / afk:terminate）。
 * subscribe 成员（onStatusChanged）不在此注册——它是主进程主动推送
 * （ipcChannels.afkStatusChanged，由 AfkOrchestrator 经 getMainWindow
 * 推给 renderer），与 feishuHandlers.broadcastBotsChanged 的推送模式一致。
 * 启停走设置（applySettings 热更新），不再暴露 afk:start/afk:stop。
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
			/** 终止单任务（stop agent + failed 收口 + needs-info 回写） */
			terminate: async (_event, taskId: number) => {
				await orchestrator.terminate(taskId);
			},
		},
	};
}