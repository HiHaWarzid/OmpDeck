/**
 * Skill 管理 IPC handler：创建/开关/删除/重命名/打开目录。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册（通道名/协议取自通道表）。
 */
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { CreatePiSkillInput } from "../../shared/types";
import type { SkillManager } from "../skills/SkillManager";
import type { AppLogger } from "../logging/AppLogger";

interface SkillHandlerDeps {
	skillManager: SkillManager;
	appLogger: AppLogger;
}

type SkillHandlerMaps = {
	skills: IpcHandlerMap<typeof ipcTable.skills, PiDesktopApi["skills"]>;
};

export function registerSkillHandlers(deps: SkillHandlerDeps): SkillHandlerMaps {
	const { skillManager, appLogger } = deps;

	return {
		skills: {
			list: async () => skillManager.list(),
			create: async (_event, input: CreatePiSkillInput) => {
				const result = await skillManager.create(input);
				void appLogger.info("skill", "Skill created", { name: input.name, locationId: input.locationId });
				return result;
			},
			toggle: async (_event, path: string, enabled: boolean) => {
				const result = await skillManager.toggle(path, enabled);
				void appLogger.info("skill", "Skill toggled", { path, enabled });
				return result;
			},
			delete: async (_event, path: string) => {
				const result = await skillManager.delete(path);
				void appLogger.info("skill", "Skill deleted", { path });
				return result;
			},
			openFolder: async (_event, path?: string) => skillManager.openFolder(path),
			rename: async (_event, path: string, newName: string) => {
				const result = await skillManager.rename(path, newName);
				void appLogger.info("skill", "Skill renamed", { path, newName });
				return result;
			},
		},
	};
}
