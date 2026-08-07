/**
 * Skill 管理 IPC handler：创建/开关/删除/重命名/打开目录。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { CreatePiSkillInput } from "../../shared/types";
import type { SkillManager } from "../skills/SkillManager";
import type { AppLogger } from "../logging/AppLogger";

interface SkillHandlerDeps {
	skillManager: SkillManager;
	appLogger: AppLogger;
}

export function registerSkillHandlers(deps: SkillHandlerDeps) {
	const { skillManager, appLogger } = deps;

	ipcMain.handle(ipcChannels.skillsList, () => skillManager.list());
	ipcMain.handle(ipcChannels.skillsCreate, async (_event, input: CreatePiSkillInput) => {
		const result = await skillManager.create(input);
		void appLogger.info("skill", "Skill created", { name: input.name, locationId: input.locationId });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsToggle, async (_event, path: string, enabled: boolean) => {
		const result = await skillManager.toggle(path, enabled);
		void appLogger.info("skill", "Skill toggled", { path, enabled });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsDelete, async (_event, path: string) => {
		const result = await skillManager.delete(path);
		void appLogger.info("skill", "Skill deleted", { path });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsOpenFolder, (_event, path?: string) =>
		skillManager.openFolder(path),
	);
	ipcMain.handle(ipcChannels.skillsRename, async (_event, path: string, newName: string) => {
		const result = await skillManager.rename(path, newName);
		void appLogger.info("skill", "Skill renamed", { path, newName });
		return result;
	});
}
