/**
 * Prompt 模板 IPC handler：list/create/delete/edit/openFolder + 按项目操作。
 * 仅覆盖 pi 全局/项目级模板管理；promptStore 搜索/导入留在 index.ts（含 inline fetch）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { CreatePiPromptTemplateInput } from "../../shared/types";
import type { PromptManager } from "../prompts/PromptManager";
import type { AppLogger } from "../logging/AppLogger";
import { perfEnd, perfStart } from "../perf";

interface PromptHandlerDeps {
	promptManager: PromptManager;
	appLogger: AppLogger;
}

export function registerPromptHandlers(deps: PromptHandlerDeps) {
	const { promptManager, appLogger } = deps;

	ipcMain.handle(ipcChannels.promptsList, async () => {
		const t0 = perfStart("prompts:list");
		const result = await promptManager.list();
		perfEnd("prompts:list", t0, { templates: result.templates.length });
		return result;
	});
	ipcMain.handle(ipcChannels.promptsCreate, async (_event, input: CreatePiPromptTemplateInput) => {
		const result = await promptManager.create(input);
		void appLogger.info("prompt", "Prompt template created", { name: input.name });
		return result;
	});
	ipcMain.handle(ipcChannels.promptsDelete, async (_event, filePath: string) => {
		await promptManager.delete(filePath);
		void appLogger.info("prompt", "Prompt template deleted", { filePath });
	});
	ipcMain.handle(ipcChannels.promptsOpenFolder, () => promptManager.openFolder());
	ipcMain.handle(ipcChannels.promptsEdit, async (_event, filePath: string, content?: string) => {
		if (content !== undefined) {
			await promptManager.writeContent(filePath, content);
			return;
		}
		return promptManager.readContent(filePath);
	});
	ipcMain.handle(ipcChannels.promptsListByProject, async (_event, projectPath: string) => {
		return promptManager.listByProject(projectPath);
	});
	ipcMain.handle(ipcChannels.promptsCreateInProject, async (_event, projectPath: string, input: CreatePiPromptTemplateInput) => {
		const result = await promptManager.createInProject(projectPath, input);
		void appLogger.info("prompt", "Project prompt template created", {
			projectPath,
			name: input.name,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.promptsDeleteInProject, async (_event, projectPath: string, fileName: string) => {
		await promptManager.deleteFromProject(projectPath, fileName);
		void appLogger.info("prompt", "Project prompt template deleted", { projectPath, fileName });
	});
	ipcMain.handle(ipcChannels.promptsRename, async (_event, oldName: string, newName: string) => {
		const result = await promptManager.rename(oldName, newName);
		void appLogger.info("prompt", "Prompt template renamed", { oldName, newName });
		return result;
	});
	ipcMain.handle(ipcChannels.promptsRenameInProject, async (_event, projectPath: string, oldName: string, newName: string) => {
		const result = await promptManager.renameInProject(projectPath, oldName, newName);
		void appLogger.info("prompt", "Project prompt template renamed", { projectPath, oldName, newName });
		return result;
	});
}
