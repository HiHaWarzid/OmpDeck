/**
 * Prompt 模板 IPC handler：list/create/delete/edit/openFolder + 按项目操作。
 * 仅覆盖 pi 全局/项目级模板管理；promptStore 搜索/导入留在 index.ts（含 inline fetch）。
 */
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { CreatePiPromptTemplateInput } from "../../shared/types";
import type { PromptManager } from "../prompts/PromptManager";
import type { AppLogger } from "../logging/AppLogger";
import { perfEnd, perfStart } from "../perf";

interface PromptHandlerDeps {
	promptManager: PromptManager;
	appLogger: AppLogger;
}

type PromptHandlerMaps = {
	prompts: IpcHandlerMap<typeof ipcTable.prompts, PiDesktopApi["prompts"]>;
};

export function registerPromptHandlers(deps: PromptHandlerDeps): PromptHandlerMaps {
	const { promptManager, appLogger } = deps;

	return {
		prompts: {
			list: async () => {
				const t0 = perfStart("prompts:list");
				const result = await promptManager.list();
				perfEnd("prompts:list", t0, { templates: result.templates.length });
				return result;
			},
			create: async (_event, input: CreatePiPromptTemplateInput) => {
				const result = await promptManager.create(input);
				void appLogger.info("prompt", "Prompt template created", { name: input.name });
				return result;
			},
			delete: async (_event, filePath: string) => {
				await promptManager.delete(filePath);
				void appLogger.info("prompt", "Prompt template deleted", { filePath });
			},
			openFolder: async () => promptManager.openFolder(),
			edit: async (_event, filePath: string, content?: string) => {
				if (content !== undefined) {
					await promptManager.writeContent(filePath, content);
					return;
				}
				return promptManager.readContent(filePath);
			},
			listByProject: async (_event, projectPath: string) => {
				return promptManager.listByProject(projectPath);
			},
			createInProject: async (_event, projectPath: string, input: CreatePiPromptTemplateInput) => {
				const result = await promptManager.createInProject(projectPath, input);
				void appLogger.info("prompt", "Project prompt template created", {
					projectPath,
					name: input.name,
				});
				return result;
			},
			deleteFromProject: async (_event, projectPath: string, fileName: string) => {
				await promptManager.deleteFromProject(projectPath, fileName);
				void appLogger.info("prompt", "Project prompt template deleted", { projectPath, fileName });
			},
			rename: async (_event, oldName: string, newName: string) => {
				const result = await promptManager.rename(oldName, newName);
				void appLogger.info("prompt", "Prompt template renamed", { oldName, newName });
				return result;
			},
			renameInProject: async (_event, projectPath: string, oldName: string, newName: string) => {
				const result = await promptManager.renameInProject(projectPath, oldName, newName);
				void appLogger.info("prompt", "Project prompt template renamed", { projectPath, oldName, newName });
				return result;
			},
		},
	};
}
