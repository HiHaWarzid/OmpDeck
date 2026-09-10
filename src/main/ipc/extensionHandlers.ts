/**
 * 扩展管理 IPC handler：list/install/uninstall/remove/restore/update。
 */
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { AppLogger } from "../logging/AppLogger";

interface ExtensionHandlerDeps {
	extensionManager: ExtensionManager;
	appLogger: AppLogger;
}

type ExtensionHandlerMaps = {
	extensions: IpcHandlerMap<typeof ipcTable.extensions, PiDesktopApi["extensions"]>;
};

export function registerExtensionHandlers(deps: ExtensionHandlerDeps): ExtensionHandlerMaps {
	const { extensionManager, appLogger } = deps;

	return {
		extensions: {
			// forceRefresh=true 时跳过内存缓存，重新跑 pi list 并查 npm 版本；默认走缓存。
			list: (_event, forceRefresh?: boolean) =>
				extensionManager.list(Boolean(forceRefresh)),
			uninstall: async (_event, source: string, scope?: "user" | "project" | "unknown") => {
				const result = await extensionManager.uninstall(source, scope);
				void appLogger.info("extension", "Extension uninstalled", { source, scope });
				return result;
			},
			install: async (_event, source: string) => {
				const result = await extensionManager.install(source);
				void appLogger.info("extension", "Extension installed", { source });
				return result;
			},
			removeBuiltIn: async (_event, source: string) => {
				// 移除内置扩展：标记跳过自动部署，并删除用户目录文件，避免 pi 仍加载导致工具冲突
				await extensionManager.removeBuiltIn(source);
				void appLogger.info("extension", "Built-in extension removed", { source });
			},
			restoreBuiltIn: async (_event, source: string) => {
				// 恢复内置扩展：清除 OmpDeck 的移除标记（残留文件已不再部署，标记即唯一状态）。
				await extensionManager.restoreBuiltIn(source);
				void appLogger.info("extension", "Built-in extension restored", { source });
			},
			update: async () => {
				const result = await extensionManager.updateExtensions();
				void appLogger.info("extension", "Extensions update command completed", { updated: result.updated, bytes: result.output.length });
				return result;
			},
		},
	};
}
