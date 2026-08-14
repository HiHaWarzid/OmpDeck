/**
 * App/Settings IPC handler：应用信息、窗口控制、更新检查/下载/安装、
 * 设置读写、RPC 日志开关、外部链接打开、反馈环境收集。
 *
 * 从 index.ts 的 registerIpc() 迁移而来。
 * 依赖较多顶层函数和可变状态，全部通过 dep 显式传递：
 * - 可变状态：mainWindow / isQuitting / petSystem / webServiceManager 用 getter/setter
 * - 更新流程：updateManager（UpdateManager 实例）封装检查/下载/安装
 * - 顶层函数：openExternalUrl / syncWslEnvironment / applyNativeThemeSource 作为函数 dep 传入
 * - applyDesktopProxy / testPiProxy 是独立模块，直接 import
 */
import { app, ipcMain, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	AppSettings,
	AppUpdateAsset,
} from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import type { WebServiceManager } from "../web/WebServiceManager";
import type { PiLocator } from "../pi/PiLocator";
import type { PetSystem } from "../pet";
import type { WslEnvironment } from "../wsl/WslPaths";
import { applyDesktopProxy } from "../settings/DesktopProxy";
import { testPiProxy } from "../pi/PiProxyTester";
import { UpdateManager, RELEASES_URL } from "../update/UpdateManager";

interface AppHandlerDeps {
	appLogger: AppLogger;
	settingsStore: SettingsStore;
	agentManager: AgentManager;
	terminalManager: TerminalSessionManager;
	piLocator: PiLocator;
	updateManager: UpdateManager;
	// 可变状态 getter/setter
	getMainWindow: () => BrowserWindow | null;
	setIsQuitting: (value: boolean) => void;
	/** 重启前释放版本级单实例锁，避免新实例被旧实例的锁挡掉 */
	releaseSingleInstanceLock: () => void;
	/** 统一重启流程（清理服务 + 释放锁 + relaunch）；托盘菜单与设置 IPC 共用同一语义 */
	restartApp: () => void;
	getPetSystem: () => PetSystem | null;
	getWebServiceManager: () => WebServiceManager | undefined;
	// 顶层函数 dep（定义留在 index.ts）
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	syncWslEnvironment: (settings: AppSettings) => Promise<WslEnvironment | null>;
	applyNativeThemeSource: (settings: AppSettings) => void;
}

export function registerAppHandlers(deps: AppHandlerDeps) {
	const {
		appLogger,
		settingsStore,
		agentManager,
		terminalManager,
		piLocator,
		updateManager,
		getMainWindow,
		setIsQuitting,
		releaseSingleInstanceLock,
		getPetSystem,
		getWebServiceManager,
		openExternalUrl,
		syncWslEnvironment,
		applyNativeThemeSource,
		restartApp,
	} = deps;

	ipcMain.handle(ipcChannels.appInfo, () => ({
		version: app.getVersion(),
		releasesUrl: RELEASES_URL,
		platform: process.platform,
	}));
	ipcMain.handle(ipcChannels.appPreferredSystemLanguages, () => {
		// Renderer navigator.language can reflect Chromium launch flags or a stale browser locale.
		// Electron exposes the OS preference order directly; use it for the "follow system" setting.
		try {
			return app.getPreferredSystemLanguages();
		} catch {
			return [];
		}
	});
	ipcMain.handle(ipcChannels.appCheckUpdate, () =>
		updateManager.checkForAppUpdate(settingsStore.get().installationType),
	);
	ipcMain.handle(
		ipcChannels.appDownloadUpdate,
		async (_event, asset: AppUpdateAsset) => updateManager.downloadUpdateAsset(asset),
	);
	ipcMain.handle(
		ipcChannels.appInstallUpdate,
		async (_event, filePath: string) => updateManager.installDownloadedUpdate(filePath),
	);
	ipcMain.on(ipcChannels.preloadReady, (event) => {
		void appLogger.info("app", "Preload API exposed", {
			url: event.sender.getURL(),
		});
	});
	ipcMain.on(ipcChannels.preloadError, (event, detail) => {
		void appLogger.error("app", "Preload API expose failed", {
			url: event.sender.getURL(),
			detail,
		});
	});
	/** 开关某 agent 的 RPC 日志记录 */
	ipcMain.handle(ipcChannels.rpcLoggingSet, async (_event, agentId: string, enabled: boolean) => {
		agentManager.setRpcLogging(agentId, enabled);
		return enabled;
	});
	/** 查询某 agent 的 RPC 日志记录状态 */
	ipcMain.handle(ipcChannels.rpcLoggingGet, async (_event, agentId: string) => agentManager.isRpcLogging(agentId));
	ipcMain.handle(ipcChannels.appFeedbackEnvironment, async () => {
		// 反馈报告只包含诊断必需的运行时版本与 pi 检测结果，不读取配置密钥或会话内容。
		const pi = await piLocator.check();
		return {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			electronVersion: process.versions.electron ?? "",
			chromeVersion: process.versions.chrome ?? "",
			nodeVersion: process.versions.node,
			pi,
		};
	});
	ipcMain.handle(ipcChannels.appOpenExternal, async (_event, url: string, forceSystem?: boolean) => {
		// 外部链接统一经主进程打开，避免 renderer 直接依赖 shell 权限，并遵守用户设置的打开方式。
		// forceSystem 为 true 时绕过 linkOpenMode 检查，始终用系统默认浏览器。
		await openExternalUrl(url, forceSystem);
	});
	ipcMain.handle(ipcChannels.appRestart, async () => {
		// 统一清理 + relaunch；清理失败不能拦住重启，否则应用会卡死在"点了没反应"
		restartApp();
	});
	ipcMain.handle(ipcChannels.appWindowMinimize, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.minimize();
	});
	ipcMain.handle(ipcChannels.appWindowToggleMaximize, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return;
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	});
	ipcMain.handle(ipcChannels.appWindowToggleAlwaysOnTop, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		const next = !win.isAlwaysOnTop();
		// floating 适合工具型桌面窗口；跨平台由 Electron 映射到各系统的置顶层级。
		win.setAlwaysOnTop(next, "floating");
		return next;
	});
	ipcMain.handle(ipcChannels.appWindowClose, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.close();
	});

	ipcMain.handle(ipcChannels.settingsGet, () => settingsStore.get());
	ipcMain.handle(
		ipcChannels.settingsUpdate,
		async (_event, patch: Partial<AppSettings>) => {
			// 记录更新前的设置，用于驱动桌面宠物对 pet 字段变化的反应
			const prevSettings = settingsStore.get();
			const settings = await settingsStore.update(patch);
			void appLogger.info("settings", "Settings updated", { keys: Object.keys(patch) });
			// 桌面宠物：设置面板走 settings.update，这里统一驱动开窗/切换/置顶
			await getPetSystem()?.reactToSettings(prevSettings, settings);
			if (
				"desktopProxyEnabled" in patch ||
				"desktopProxyUrl" in patch ||
				"desktopProxyBypass" in patch
			) {
				await applyDesktopProxy(settings);
			}
			if ("theme" in patch) {
				applyNativeThemeSource(settings);
			}
			if ("useNativeTitleBar" in patch) {
				settingsStore.notifyTitleBarChange(getMainWindow());
			}
			if ("zoomFactor" in patch) {
				getMainWindow()?.webContents.setZoomFactor(settings.zoomFactor);
			}
			if (
				"webServiceEnabled" in patch ||
				"webServiceHost" in patch ||
				"webServicePort" in patch
			) {
				try {
					await getWebServiceManager()?.applySettings(settings);
				} catch (error) {
					if (settings.webServiceEnabled) {
						await settingsStore.update({ webServiceEnabled: false });
					}
					throw error;
				}
			}
			// WSL 设置变更时同步更新会话扫描器和配置管理器
			if ("wslEnabled" in patch || "wslDistro" in patch || "wslUser" in patch) {
				await syncWslEnvironment(settings);
			}
			return settings;
		},
	);
	ipcMain.handle(
		ipcChannels.settingsTestPiProxy,
		async () => {
			const result = await testPiProxy(settingsStore.get());
			void appLogger.info("settings", "Pi proxy tested", {
				success: result.success,
				elapsedMs: result.elapsedMs,
				statusCode: result.statusCode,
				error: result.error,
			});
			return result;
		},
	);

	// ── 配置管理 ──────────────────────────────────────
	// 切换开发者控制台
	ipcMain.handle(ipcChannels.appToggleDevTools, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		if (win.webContents.isDevToolsOpened()) {
			win.webContents.closeDevTools();
			return false;
		}
		win.webContents.openDevTools({ mode: "detach" });
		return true;
	});
	ipcMain.handle(ipcChannels.visionTest, async (_event, config: unknown) => {
		// 视觉桥连通性测试：GET {baseUrl}/models 验证端点与 API key（入参校验在边界）。
		const c = config as {
			baseUrl?: unknown;
			apiKey?: unknown;
		} | null;
		const baseUrl = typeof c?.baseUrl === "string" ? c.baseUrl.trim().replace(/\/+$/, "") : "";
		const apiKey = typeof c?.apiKey === "string" ? c.apiKey.trim() : "";
		if (!baseUrl || !apiKey) {
			return { ok: false, error: "请先填写端点与 API Key" };
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 15_000);
			try {
				const response = await fetch(`${baseUrl}/models`, {
					headers: { Authorization: `Bearer ${apiKey}` },
					signal: controller.signal,
				});
				if (!response.ok) {
					const detail = await response.text().catch(() => "");
					return {
						ok: false,
						error: `HTTP ${response.status}: ${detail.slice(0, 200)}`,
					};
				}
				const data = (await response.json()) as { data?: unknown };
				const modelIds = Array.isArray(data.data)
					? data.data
							.map((m) => (m && typeof m === "object" && "id" in m ? String((m as { id: unknown }).id) : ""))
							.filter(Boolean)
					: [];
				return { ok: true, models: modelIds };
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				return { ok: false, error: "连接超时（15s）" };
			}
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
}
