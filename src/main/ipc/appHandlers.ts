/**
 * App/Settings IPC handler：应用信息、窗口控制、更新检查/下载/安装、
 * 设置读写、RPC 日志开关、外部链接打开。
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
	CrashedRun,
	RemoteAccessStatus,
} from "../../shared/types";
import type { AgentManager } from "../pi/AgentManager";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import type { WebServiceManager } from "../web/WebServiceManager";
import type { RemoteAccessManager } from "../remote/RemoteAccessManager";
import type { PetSystem } from "../pet";
import type { AfkOrchestrator } from "../afk/AfkOrchestrator";
import type { WslEnvironment } from "../wsl/WslPaths";
import { resolveNativeThemeSource } from "../nativeThemeSource";
import { applyDesktopProxy } from "../settings/DesktopProxy";
import { testPiProxy } from "../pi/PiProxyTester";
import { UpdateManager, RELEASES_URL } from "../update/UpdateManager";
import {
	generateWebToken,
	normalizeTokenTtlDays,
	tokenExpiresAt,
} from "../web/WebTokenAuth";

interface AppHandlerDeps {
	appLogger: AppLogger;
	settingsStore: SettingsStore;
	agentManager: AgentManager;
	terminalManager: TerminalSessionManager;
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
	/** Tailscale Serve 远程访问管理器；未初始化时设置页仍可读取关闭态 */
	getRemoteAccessManager?: () => RemoteAccessManager | undefined;
	/** AFK 编排器（settings-save 时热更新 afk 启停/目标/间隔） */
	getAfkOrchestrator?: () => AfkOrchestrator | undefined;
	/** 取走「上次非正常退出时打开的会话」快照；一次性消费，重复取返回 null */
	takeCrashedSessions: () => CrashedRun | null;
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
	web: IpcHandlerMap<typeof ipcTable.web, PiDesktopApi["web"]>;
	remoteAccess: IpcHandlerMap<typeof ipcTable.remoteAccess, PiDesktopApi["remoteAccess"]>;
};

export function registerAppHandlers(deps: AppHandlerDeps): AppHandlerMaps {
	const {
		appLogger,
		settingsStore,
		agentManager,
		updateManager,
		getMainWindow,
		getPetSystem,
		getWebServiceManager,
		getRemoteAccessManager,
		openExternalUrl,
		syncWslEnvironment,
		applyNativeThemeSource,
		restartApp,
		takeCrashedSessions,
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
			// 崩溃恢复：主进程持有一次性快照，渲染层取走后就置空，重复调用返回 null。
			takeCrashedSessions: async () => takeCrashedSessions(),
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
				// 远程访问依赖 Web 服务；用户只打开远程访问时自动把 Web 服务一起启用，
				// 避免出现「开关是开、Serve 指向未监听端口」的半配置状态。
				const effectivePatch: Partial<AppSettings> = { ...patch };
				if (effectivePatch.remoteAccessEnabled === true && !prevSettings.webServiceEnabled) {
					effectivePatch.webServiceEnabled = true;
				}
				// 关闭 Web 服务会立刻让 Serve 指向一个未监听的端口；远程访问必须同步关闭，
				// 否则设置页会停在「远程已启用但不可用」的矛盾状态。
				if (effectivePatch.webServiceEnabled === false && prevSettings.remoteAccessEnabled) {
					effectivePatch.remoteAccessEnabled = false;
				}
				let settings = await settingsStore.update(effectivePatch);
				void appLogger.info("settings", "Settings updated", { keys: Object.keys(effectivePatch) });
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
				if ("webServiceTokenTtlDays" in patch) {
					// TTL 变更只改过期时间，不重新生成令牌：已扫码的手机不应因改设置掉线。
					const ttl = normalizeTokenTtlDays(settings.webServiceTokenTtlDays);
					settings = await settingsStore.update({
						webServiceTokenExpiresAt: tokenExpiresAt(
							settings.webServiceTokenGeneratedAt ?? Date.now(),
							ttl,
						),
					});
				}
				if (
					"webServiceEnabled" in effectivePatch ||
					"webServiceHost" in effectivePatch ||
					"webServicePort" in effectivePatch ||
					"webServiceTokenTtlDays" in effectivePatch ||
					"remoteAccessEnabled" in effectivePatch
				) {
					const webServiceManager = getWebServiceManager();
					try {
						await webServiceManager?.applySettings(settings);
					} catch (error) {
						// applySettings 先绑新端口、成功后才关旧 server：新端口被占用时旧服务仍在
						// 正常服务。失败意味着这三个键没有生效，必须回滚到应用前的值——否则设置
						// 面板会显示一个并未在服务的端口，用户以为已切换而实际仍在旧端口。
						const rollback: Partial<AppSettings> = {};
						if ("webServiceEnabled" in effectivePatch) {
							rollback.webServiceEnabled = prevSettings.webServiceEnabled;
						}
						if ("webServiceHost" in effectivePatch) {
							rollback.webServiceHost = prevSettings.webServiceHost;
						}
						if ("webServicePort" in effectivePatch) {
							rollback.webServicePort = prevSettings.webServicePort;
						}
						if ("remoteAccessEnabled" in effectivePatch) {
							rollback.remoteAccessEnabled = prevSettings.remoteAccessEnabled ?? false;
						}
						// 启动失败且当前确无实例在跑（此前也没有服务）：明确关掉开关，
						// 避免停在「开关是开、后端没有服务」的状态。
						if (settings.webServiceEnabled && webServiceManager?.isRunning() !== true) {
							rollback.webServiceEnabled = false;
						}
						if (Object.keys(rollback).length > 0) await settingsStore.update(rollback);
						throw error;
					}
				}
				// 远程访问必须在 Web 服务绑定成功后配置；Web 端口变化时也要把 Serve
				// 目标改到新端口，否则隧道会指向旧端口。
				if (
					"remoteAccessEnabled" in effectivePatch ||
					"webServicePort" in effectivePatch ||
					"webServiceEnabled" in effectivePatch
				) {
					const remoteAccessManager = getRemoteAccessManager?.();
					if (remoteAccessManager) {
						try {
							await remoteAccessManager.applySettings(settings);
						} catch (error) {
							// 远程访问启用/关闭失败时回滚开关，避免 UI 显示已开启但 Serve 未生效。
							// Web 服务是否保留启用由上面的 Web 服务分支决定（自动启用是合理的）。
							const rollback: Partial<AppSettings> = {};
							if ("remoteAccessEnabled" in effectivePatch) {
								rollback.remoteAccessEnabled = prevSettings.remoteAccessEnabled ?? false;
							}
							// 同一次保存若还关闭了 Web 服务，而 Serve 关闭失败，远程开关必须保持
							// 开启；此时必须把 Web 服务一并恢复，否则开关为开但目标端口未监听。
							if (effectivePatch.webServiceEnabled === false && prevSettings.webServiceEnabled) {
								rollback.webServiceEnabled = true;
								rollback.webServiceHost = prevSettings.webServiceHost;
								rollback.webServicePort = prevSettings.webServicePort;
							}
							if (Object.keys(rollback).length > 0) {
								settings = await settingsStore.update(rollback);
								if (rollback.webServiceEnabled) {
									try {
										await getWebServiceManager()?.applySettings(settings);
									} catch (restoreError) {
										void appLogger.warn("settings", "Failed to restore web service after remote stop failure", {
											error: restoreError instanceof Error ? restoreError.message : String(restoreError),
										});
									}
								}
							}
							throw error;
						}
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
		web: {
			status: async () => {
				const manager = getWebServiceManager();
				return manager?.getStatus(true) ?? {
					running: false,
					host: settingsStore.get().webServiceHost,
					port: settingsStore.get().webServicePort,
					token: settingsStore.get().webServiceToken ?? null,
					tokenGeneratedAt: settingsStore.get().webServiceTokenGeneratedAt ?? null,
					tokenExpiresAt: settingsStore.get().webServiceTokenExpiresAt ?? null,
					loopback: true,
					url: "",
					lanUrls: [],
				};
			},
			rotateToken: async () => {
				const manager = getWebServiceManager();
				const current = settingsStore.get();
				const now = Date.now();
				const ttlDays = normalizeTokenTtlDays(current.webServiceTokenTtlDays);
				const settings = await settingsStore.update({
					webServiceToken: generateWebToken(),
					webServiceTokenGeneratedAt: now,
					webServiceTokenExpiresAt: tokenExpiresAt(now, ttlDays),
					webServiceTokenTtlDays: ttlDays,
				});
				await manager?.applySettings(settings);
				void appLogger.info("web", "Web access token rotated", {
					expiresAt: settings.webServiceTokenExpiresAt,
				});
				return manager?.getStatus(true) ?? {
					running: false,
					host: settings.webServiceHost,
					port: settings.webServicePort,
					token: settings.webServiceToken ?? null,
					tokenGeneratedAt: settings.webServiceTokenGeneratedAt ?? null,
					tokenExpiresAt: settings.webServiceTokenExpiresAt ?? null,
					loopback: true,
					url: "",
					lanUrls: [],
				};
			},
		},
		remoteAccess: {
			status: async () => getRemoteAccessManager?.()?.getStatus() ?? disabledRemoteAccessStatus(),
			start: async () => {
				const manager = getRemoteAccessManager?.();
				if (!manager) return disabledRemoteAccessStatus();
				// 重试入口：以「启用」语义启动，成功后持久化开关；失败不改设置。
				const status = await manager.applySettings({
					...settingsStore.get(),
					remoteAccessEnabled: true,
				});
				await settingsStore.update({ remoteAccessEnabled: true });
				return status;
			},
			stop: async () => {
				const manager = getRemoteAccessManager?.();
				const status = manager ? await manager.stop() : disabledRemoteAccessStatus();
				await settingsStore.update({ remoteAccessEnabled: false });
				return status;
			},
		},
	};
}

/** 管理器尚未初始化（例如启动早期）时返回关闭态，避免设置页拿到 undefined。 */
function disabledRemoteAccessStatus(): RemoteAccessStatus {
	return {
		enabled: false,
		state: "off",
		provider: "tailscale",
		installed: false,
		loggedIn: false,
		url: null,
		hostname: null,
		httpsPort: 8443,
		binaryPath: null,
		errorCode: null,
		error: null,
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
