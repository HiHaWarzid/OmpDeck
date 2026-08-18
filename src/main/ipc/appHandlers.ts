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
 *
 * preloadReady / preloadError 是 mainOnly 通道（不在 ipcTable 命名空间里），
 * 由本模块直接 ipcMain.on 注册，不走 registerIpcHandlers。
 */
import { app, ipcMain, type BrowserWindow } from "electron";
import { ipcChannels, ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
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
import type { AfkOrchestrator } from "../afk/AfkOrchestrator";
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
	/** AFK 编排器（settings-save 时热更新 afk 启停/目标/间隔） */
	getAfkOrchestrator?: () => AfkOrchestrator | undefined;
	// 顶层函数 dep（定义留在 index.ts）
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	syncWslEnvironment: (settings: AppSettings) => Promise<WslEnvironment | null>;
	applyNativeThemeSource: (settings: AppSettings) => void;
}

type AppHandlerMaps = {
	// rendererLog 由 logHandlers 注册
	app: Omit<IpcHandlerMap<typeof ipcTable.app, PiDesktopApi["app"]>, "rendererLog">;
	rpcLogs: Pick<IpcHandlerMap<typeof ipcTable.rpcLogs, PiDesktopApi["rpcLogs"]>, "setLogging" | "getLogging">;
	// onApplyWindow 是 subscribe（主进程推送），不注册 handler
	settings: Omit<IpcHandlerMap<typeof ipcTable.settings, PiDesktopApi["settings"]>, "onApplyWindow">;
};

export function registerAppHandlers(deps: AppHandlerDeps): AppHandlerMaps {
	const {
		appLogger,
		settingsStore,
		agentManager,
		piLocator,
		updateManager,
		getMainWindow,
		getPetSystem,
		getWebServiceManager,
		openExternalUrl,
		syncWslEnvironment,
		applyNativeThemeSource,
		restartApp,
	} = deps;

	return {
		app: {
			info: async () => ({
				version: app.getVersion(),
				releasesUrl: RELEASES_URL,
				platform: process.platform,
				// 扩展读取本地文件（如 memory-store.json）依赖 home 目录
				homeDir: app.getPath("home"),
			}),
			preferredSystemLanguages: async () => {
				// Renderer navigator.language can reflect Chromium launch flags or a stale browser locale.
				// Electron exposes the OS preference order directly; use it for the "follow system" setting.
				try {
					return app.getPreferredSystemLanguages();
				} catch {
					return [];
				}
			},
			checkUpdate: async () =>
				updateManager.checkForAppUpdate(settingsStore.get().installationType),
			downloadUpdate: async (_event, asset: AppUpdateAsset) => updateManager.downloadUpdateAsset(asset),
			installUpdate: async (_event, filePath: string) => updateManager.installDownloadedUpdate(filePath),
			feedbackEnvironment: async () => {
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
			},
			openExternal: async (_event, url: string, forceSystem?: boolean) => {
				// 外部链接统一经主进程打开，避免 renderer 直接依赖 shell 权限，并遵守用户设置的打开方式。
				// forceSystem 为 true 时绕过 linkOpenMode 检查，始终用系统默认浏览器。
				await openExternalUrl(url, forceSystem);
			},
			restart: async () => {
				// 统一清理 + relaunch；清理失败不能拦住重启，否则应用会卡死在"点了没反应"
				restartApp();
			},
			windowControl: async (_event, action: "minimize" | "toggle-maximize" | "close") => {
				const win = getMainWindow();
				if (!win || win.isDestroyed()) return;
				switch (action) {
					case "minimize":
						win.minimize();
						break;
					case "toggle-maximize":
						if (win.isMaximized()) win.unmaximize();
						else win.maximize();
						break;
					case "close":
						win.close();
						break;
				}
			},
			toggleAlwaysOnTopWindow: async () => {
				const win = getMainWindow();
				if (!win || win.isDestroyed()) return false;
				const next = !win.isAlwaysOnTop();
				// floating 适合工具型桌面窗口；跨平台由 Electron 映射到各系统的置顶层级。
				win.setAlwaysOnTop(next, "floating");
				return next;
			},
			toggleDevTools: async () => {
				const win = getMainWindow();
				if (!win || win.isDestroyed()) return false;
				if (win.webContents.isDevToolsOpened()) {
					win.webContents.closeDevTools();
					return false;
				}
				win.webContents.openDevTools({ mode: "detach" });
				return true;
			},
			visionTest: async (_event, config: unknown) => {
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
									.map((m) => (m && typeof m === "object" && "id" in m ? String(m.id) : ""))
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
			},
		},
		rpcLogs: {
			/** 开关某 agent 的 RPC 日志记录 */
			setLogging: async (_event, agentId: string, enabled: boolean) => {
				agentManager.setRpcLogging(agentId, enabled);
				return enabled;
			},
			/** 查询某 agent 的 RPC 日志记录状态 */
			getLogging: async (_event, agentId: string) => agentManager.isRpcLogging(agentId),
		},
		settings: {
			get: async () => settingsStore.get(),
			update: async (_event, patch: Partial<AppSettings>) => {
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
				// AFK 设置热更新：enabled/targetProjectIds/pollIntervalMs 即刻生效，无需重启
				// （运行中的任务保持不动；启用即恢复轮询，停用即停表，目标/间隔下一轮生效）
				if ("afk" in patch) {
					deps.getAfkOrchestrator?.()?.applySettings(settings);
				}
				return settings;
			},
			testPiProxy: async () => {
				const result = await testPiProxy(settingsStore.get());
				void appLogger.info("settings", "Pi proxy tested", {
					success: result.success,
					elapsedMs: result.elapsedMs,
					statusCode: result.statusCode,
					error: result.error,
				});
				return result;
			},
		},
	};
}

/** preload 启动握手（mainOnly 通道，不走通道表命名空间）。 */
export function registerPreloadHandshakeHandlers(appLogger: AppLogger): void {
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
}
