/**
 * 扩展管理 IPC handler：list/install/uninstall/remove/restore/update。
 *
 * restoreBuiltIn 额外调用 extensionManager.ensureExtension 确保文件存在。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { AppLogger } from "../logging/AppLogger";

interface ExtensionHandlerDeps {
	extensionManager: ExtensionManager;
	appLogger: AppLogger;
	/** 当前 WSL 环境（运行期可变，通过 getter 读取最新值） */
	getActiveWslEnvironment: () => { windowsHome?: string } | null;
}

export function registerExtensionHandlers(deps: ExtensionHandlerDeps) {
	const { extensionManager, appLogger, getActiveWslEnvironment } = deps;

	// forceRefresh=true 时跳过内存缓存，重新跑 pi list 并查 npm 版本；默认走缓存。
	ipcMain.handle(ipcChannels.extensionsList, (_event, forceRefresh?: boolean) =>
		extensionManager.list(Boolean(forceRefresh)),
	);
	ipcMain.handle(ipcChannels.extensionsUninstall, async (_event, source: string, scope?: "user" | "project" | "unknown") => {
		const result = await extensionManager.uninstall(source, scope);
		void appLogger.info("extension", "Extension uninstalled", { source, scope });
		return result;
	});
	ipcMain.handle(ipcChannels.extensionsInstall, async (_event, source: string) => {
		const result = await extensionManager.install(source);
		void appLogger.info("extension", "Extension installed", { source });
		return result;
	});
	ipcMain.handle(ipcChannels.extensionsRemoveBuiltIn, async (_event, source: string) => {
		// 移除内置扩展：标记跳过自动部署，并删除用户目录文件，避免 pi 仍加载导致工具冲突
		await extensionManager.removeBuiltIn(source);
		void appLogger.info("extension", "Built-in extension removed", { source });
	});
	ipcMain.handle(ipcChannels.extensionsRestoreBuiltIn, async (_event, source: string) => {
		// 恢复内置扩展：从 OmpDeck 移除标记中删除，并确保文件存在
		await extensionManager.restoreBuiltIn(source);
		const wslHome = getActiveWslEnvironment()?.windowsHome;
		// ensureExtension 需要明确的 homeDir；WSL 启用时用 WSL home，否则用默认 home
		await extensionManager.ensureExtension(
			source,
			wslHome ?? extensionManager.homeDir,
		);
		void appLogger.info("extension", "Built-in extension restored", { source });
	});
	ipcMain.handle(ipcChannels.extensionsUpdate, async () => {
		const result = await extensionManager.updateExtensions();
		void appLogger.info("extension", "Extensions update command completed", { updated: result.updated, bytes: result.output.length });
		return result;
	});
}
