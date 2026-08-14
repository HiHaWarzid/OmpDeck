/**
 * 外部编辑器 IPC handler：list/choose/redetect/update/openProject。
 *
 * chooseExecutable 使用系统文件选择器，需要 mainWindow 作为 dialog 父窗口；
 * mainWindow 运行期可变，通过 getter 注入。
 */
import { dialog, type BrowserWindow } from "electron";
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type {
	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
} from "../../shared/types";
import {
	detectExternalEditors,
	listConfiguredExternalEditors,
	mergeDetectedExternalEditors,
	openProjectInEditor,
	validateExternalEditorCommand,
} from "../editors/EditorDetector";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";

interface EditorHandlerDeps {
	settingsStore: SettingsStore;
	appLogger: AppLogger;
	/** 主窗口引用（运行期可变，dialog 需要作为父窗口） */
	getMainWindow: () => BrowserWindow | null;
}

type EditorHandlerMaps = {
	editors: IpcHandlerMap<typeof ipcTable.editors, PiDesktopApi["editors"]>;
};

export function registerEditorHandlers(deps: EditorHandlerDeps): EditorHandlerMaps {
	const { settingsStore, appLogger, getMainWindow } = deps;

	return {
		editors: {
			list: async () => listConfiguredExternalEditors(settingsStore.get()),
			chooseExecutable: async () => {
				const options = {
					properties: ["openFile"],
					filters: process.platform === "win32"
						? [
								{ name: "Applications", extensions: ["exe", "cmd", "bat"] },
								{ name: "All Files", extensions: ["*"] },
							]
						: [{ name: "All Files", extensions: ["*"] }],
				} satisfies Electron.OpenDialogOptions;
				const mainWindow = getMainWindow();
				const result = mainWindow
					? await dialog.showOpenDialog(mainWindow, options)
					: await dialog.showOpenDialog(options);
				return result.canceled ? null : result.filePaths[0] ?? null;
			},
			redetect: async () => {
				const detected = await detectExternalEditors();
				const settings = await settingsStore.update({
					externalEditors: mergeDetectedExternalEditors(settingsStore.get().externalEditors, detected),
				});
				void appLogger.info("editor", "External editors redetected", { count: detected.length });
				return settings;
			},
			update: async (_event, editorId: ExternalEditorId, patch: Partial<ExternalEditorSetting>) => {
				const current = settingsStore.get().externalEditors;
				const existing = current[editorId];
				if (!existing) throw new Error(`Unsupported editor: ${editorId}`);
				const command = typeof patch.command === "string" ? patch.command.trim() : existing.command;
				if (command) {
					const validation = await validateExternalEditorCommand(command);
					if (!validation.valid) throw new Error(`Editor path does not exist: ${command}`);
				}
				const settings = await settingsStore.update({
					externalEditors: {
						...current,
						[editorId]: {
							...existing,
							...patch,
							command,
							detectedFrom: patch.command !== undefined ? "manual" : (patch.detectedFrom ?? existing.detectedFrom),
							updatedAt: Date.now(),
						},
					},
				});
				void appLogger.info("editor", "External editor settings updated", { editorId, keys: Object.keys(patch) });
				return settings;
			},
			openProject: async (_event, editor: ExternalEditor, projectPath: string) => {
				// 只接收已检测到的编辑器配置；打开项目不经过 shell 拼接命令,降低路径含空格时失败的概率。
				await openProjectInEditor(editor, projectPath);
				void appLogger.info("editor", "Project opened in external editor", {
					editorId: editor.id,
					editorName: editor.name,
					command: editor.command,
					args: editor.args,
					projectPath,
				});
			},
		},
	};
}
