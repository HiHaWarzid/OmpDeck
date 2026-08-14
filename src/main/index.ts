import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	nativeTheme,
	net,
} from "electron";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { is } from "@electron-toolkit/utils";
import { PetSystem, type PetSystemDeps } from "./pet";
import {
	applyLinuxDisplayBackendWorkaround,
	isUsingLinuxXWaylandWorkaround,
} from "./linuxDisplayBackend";
import {
	readElectronChromiumSandboxPreference,
	readPetEnabledPreference,
	readSingleInstancePreference,
} from "./settings/SettingsStore";
import { acquireVersionSingleInstance } from "./singleInstance";
import { readLastWindowBounds, saveLastWindowBounds } from "./windowState";
import type { StartupWindowMode } from "../shared/types";
// 使用 ?asset 后缀导入图标，electron-vite 会在构建时将其复制到输出目录并提供正确的运行时路径
// 这解决了打包后 build/ 目录不在 asar 中导致托盘图标丢失的问题
import iconPath from "../../build/icon.png?asset";

// 开发态与正式版隔离 userData。
// 否则 npm run dev 会与已安装的 OmpDeck 共用数据/锁，表现为「开发启动被复用到正式版窗口」。
// 必须在读取 settings / 版本单实例锁之前设置。
if (!app.isPackaged) {
	const baseUserData = app.getPath("userData");
	// 仅在尚未指向 *-dev 时追加，避免重复拼接。
	// 同时兼容历史 rebrand 前的 pi-desktop-dev，避免改名后历史数据「凭空消失」。
	if (!/[\\/]omp-deck-dev$/i.test(baseUserData) && !/[\\/]pi-desktop-dev$/i.test(baseUserData) && !/dev$/i.test(baseUserData)) {
		app.setPath("userData", `${baseUserData}-dev`);
	}
	// 一次性迁移：rebrand（pi-desktop -> omp-deck）导致 dev userData 路径变更，
	// 旧数据留在 pi-desktop-dev。新目录首次启动时从旧目录整体拷入，保留项目列表/设置/会话缓存。
	// 迁移成功后写入 .migrated-from-pi-desktop 标记，避免重复迁移。
	const currentDev = app.getPath("userData");
	const legacyDev = currentDev.replace(/[\\/]omp-deck-dev$/i, "\\pi-desktop-dev");
	const migratedFlag = join(currentDev, ".migrated-from-pi-desktop");
	if (
		/[\\/]omp-deck-dev$/i.test(currentDev) &&
		existsSync(legacyDev) &&
		!existsSync(migratedFlag)
	) {
		try {
			mkdirSync(currentDev, { recursive: true });
			const legacyEntries = readdirSync(legacyDev);
			for (const entry of legacyEntries) {
				const src = join(legacyDev, entry);
				const dest = join(currentDev, entry);
				if (existsSync(dest)) continue; // 不覆盖已有文件（如本次刚写入的锁文件）
				const entryStat = statSync(src);
				if (entryStat.isDirectory()) {
					cpSync(src, dest, { recursive: true });
				} else {
					copyFileSync(src, dest);
				}
			}
			writeFileSync(migratedFlag, new Date().toISOString(), "utf8");
			console.log(`[OmpDeck] 一次性迁移：已从 ${legacyDev} 恢复历史数据到 ${currentDev}`);
		} catch (error) {
			console.error("[OmpDeck] 历史数据迁移失败，请手动从 pi-desktop-dev 恢复:", error);
		}
	}
}

// Linux XWayland 兼容层：仅当桌面宠物启用时才强制 ozone-platform=x11（#108，
// 强制 XWayland 在部分 GNOME/Wayland 环境会导致主窗口不可见）。
// ozone 平台一经启动不可更改，整个生命周期统一使用启动时快照。
// 注意必须放在 dev userData 覆盖之后，否则 dev 模式会误读正式版的 petEnabled。
const petEnabledAtLaunch = readPetEnabledPreference();
applyLinuxDisplayBackendWorkaround(petEnabledAtLaunch);

// Chromium 沙箱开关必须在 app.ready 前生效。
// 默认关闭：Windows 上部分安全软件/旧 GPU 驱动会在沙箱初始化时触发原生断点（0x80000003）。
// 用户可在「开发设置」中开启 electronChromiumSandbox，重启后走 Chromium 默认沙箱。
const electronChromiumSandboxEnabled = readElectronChromiumSandboxPreference();
if (!electronChromiumSandboxEnabled) {
	// 关闭沙箱时显式附带 no-sandbox，避免部分环境仍按默认策略启用。
	app.commandLine.appendSwitch("no-sandbox");
}

// 按「应用版本」隔离的单实例：同版本复用窗口，不同版本可并行。
// 不用 Electron requestSingleInstanceLock：它按 userData 全局互斥，会导致 0.6.7 与 0.6.8 无法同开。
// focus 回调稍后挂到 focusMainWindow（定义在文件后部），避免顶层 TDZ。
let focusExistingWindow: (() => void) | null = null;
const singleInstanceEnabled = readSingleInstancePreference();
const versionSingleInstance = acquireVersionSingleInstance(
	singleInstanceEnabled,
	app.getVersion(),
	() => {
		focusExistingWindow?.();
	},
);
const gotSingleInstanceLock = versionSingleInstance.isPrimary;
if (singleInstanceEnabled && !gotSingleInstanceLock) {
	// 同版本已有实例：立即退出，由主实例 watch .focus 后唤起窗口。
	// 用 exit(0) 而不是 quit()：第二进程尚未 ready，quit 更慢。
	app.exit(0);
}

// 开发模式下 stdout 管道可能断开导致 EPIPE 崩溃，全局静默处理
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});

process.on("uncaughtException", (error) => {
	// 绝不在这里 process.exit：目标是“失败可诊断”，而不是把偶发 spawn/事件错误变成整应用闪退。
	// 尤其 macOS arm 上 pi 子进程 ENOENT/架构不匹配时，历史上曾出现 error 事件无 listener 升级为 uncaught。
	void appLogger?.error("process", "Uncaught exception", {
		name: error instanceof Error ? error.name : typeof error,
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
		platform: process.platform,
		arch: process.arch,
	});
	console.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
	void appLogger?.error("process", "Unhandled rejection", {
		reason: reason instanceof Error
			? { name: reason.name, message: reason.message, stack: reason.stack }
			: reason,
		platform: process.platform,
		arch: process.arch,
	});
	console.error("Unhandled rejection:", reason);
});
import { ipcChannels } from "../shared/ipc";
import type {
	AppSettings,
	AppLogLevel,
	AppLogQuery,
	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
	CreatePiPromptTemplateInput,
	CreatePiSkillInput,
	CreateProjectSkillInput,
	PiPromptTemplateSummary,
	PromptStoreSearchResult,
	PromptStoreSearchResponse,
	PromptStoreRawItem,
	PromptStoreItem,
	TerminalShell,
	YaoPromptListResult,
	YaoPromptDetailResult,
} from "../shared/types";
import { ProjectStore } from "./projects/ProjectStore";
import { FileSystemService } from "./fs/FileSystemService";
import { AgentManager } from "./pi/AgentManager";
import { PiLocator } from "./pi/PiLocator";
import { PiProcess } from "./pi/PiProcess";
import { QuickGenProcess } from "./pi/QuickGenProcess";
import { ensureAllPiSettingsDefaults } from "./pi/PiSettingsDefaults";
import { SessionScanner } from "./sessions/SessionScanner";
import { ImportPipeline } from "./sessions/importPipeline";
import { OpenCodeImportAdapter } from "./sessions/adapters/opencodeImportAdapter";
import { ClaudeImportAdapter } from "./sessions/adapters/claudeImportAdapter";
import { CodexImportAdapter } from "./sessions/adapters/codexImportAdapter";
import { SettingsStore } from "./settings/SettingsStore";
import { applyDesktopProxy } from "./settings/DesktopProxy";
import { GitService } from "./git/GitService";
import { WorktreeService } from "./git/WorktreeService";
import { ConfigManager } from "./config/ConfigManager";
import { TerminalSessionManager } from "./terminal/TerminalSessionManager";
import { TelemetryService } from "./telemetry/TelemetryService";
import { PromptManager } from "./prompts/PromptManager";
import { XuePromptManager } from "./prompts/XuePromptManager";
import { SkillManager } from "./skills/SkillManager";
import { ExtensionManager } from "./extensions/ExtensionManager";
import { restoreAllParkedExtensions } from "./pi/piExtensionFilter";
import { ProjectResourceManager } from "./projects/ProjectResourceManager";
import { WebServiceManager } from "./web/WebServiceManager";
import { preparePreloadPath } from "./preloadPath";
import { AppLogger } from "./logging/AppLogger";
import { registerLogHandlers } from "./ipc/logHandlers";
import { registerSkillHandlers } from "./ipc/skillHandlers";
import { registerTerminalHandlers } from "./ipc/terminalHandlers";
import { registerExtensionHandlers } from "./ipc/extensionHandlers";
import { registerEditorHandlers } from "./ipc/editorHandlers";
import { registerPromptHandlers } from "./ipc/promptHandlers";
import { registerScratchPadHandlers } from "./ipc/scratchPadHandlers";
import { registerStoreHandlers } from "./ipc/storeHandlers";
import { registerProjectHandlers } from "./ipc/projectHandlers";
import { registerFileHandlers } from "./ipc/fileHandlers";
import { registerSessionHandlers } from "./ipc/sessionHandlers";
import { registerGitHandlers } from "./ipc/gitHandlers";
import { registerConfigHandlers } from "./ipc/configHandlers";
import { registerFeishuHandlers } from "./ipc/feishuHandlers";
import { registerPiHandlers } from "./ipc/piHandlers";
import { registerAgentHandlers } from "./ipc/agentHandlers";
import { registerAppHandlers } from "./ipc/appHandlers";
import { UpdateManager } from "./update/UpdateManager";
import { LinkOpener } from "./links/LinkOpener";
import { TrayManager } from "./tray/TrayManager";
import { RpcLogger } from "./logging/RpcLogger";
import { resolveWslEnvironment } from "./wsl/WslEnvironment";
import type { WslEnvironment } from "./wsl/WslPaths";
import {
	detectExternalEditors,
	listConfiguredExternalEditors,
	mergeDetectedExternalEditors,
	openProjectInEditor,
	validateExternalEditorCommand,
} from "./editors/EditorDetector";
import { FeishuBridge } from "./feishu/FeishuBridge";
import { listBots } from "./feishu/FeishuConfig";
import { perfDump } from "./perf";

let mainWindow: BrowserWindow | null = null;
/** 标记是否由用户主动退出（托盘菜单「退出」），区别于窗口关闭隐藏到托盘 */
let isQuitting = false;
// 主窗口主 frame 加载健康状态（自愈判断用，见 handleVersionFocusRequest）。
// mainFrameLoadFailed：最近一次主 frame 导航失败（含 dev server 失联导致的错误页）。
// pendingErrorPageFinish：did-fail-load 之后紧跟的那次 did-finish-load 属于错误页本身，
// 不能据此清除失败标记——只有真实页面加载成功才清除。
let mainFrameLoadFailed = false;
let pendingErrorPageFinish = false;
// dev URL 首次加载失败后回退到已构建的 renderer 产物，只回退一次，避免无产物时反复重试。
let mainWindowDevFallbackTried = false;
let projectStore: ProjectStore;
let fileSystemService: FileSystemService;
let sessionScanner: SessionScanner;
let importPipeline: ImportPipeline;
let settingsStore: SettingsStore;
let worktreeService: WorktreeService;
let gitService: GitService;
let piLocator: PiLocator;
let agentManager: AgentManager;
let configManager: ConfigManager;
let promptManager: PromptManager;
let xuePromptManager: XuePromptManager;
let skillManager: SkillManager;
let extensionManager: ExtensionManager;
let projectResourceManager: ProjectResourceManager;
let webServiceManager: WebServiceManager;
let terminalManager: TerminalSessionManager;
let petSystem: PetSystem | null = null;
let appLogger: AppLogger;
let rpcLogger: RpcLogger;
let updateManager: UpdateManager;
let linkOpener: LinkOpener;
let trayManager: TrayManager;
let feishuBridge: FeishuBridge | null = null;
let activeWslEnvironment: WslEnvironment | null = null;
let quickGen: QuickGenProcess | null = null;

/**
 * WSL HOME 只在这里解析一次，再把同一个环境对象下发给所有文件边界消费者。
 * 这样 root、自定义 HOME 和普通用户不会在各管理器中被分别猜测。
 */
async function syncWslEnvironment(settings: AppSettings): Promise<WslEnvironment | null> {
	const environment = settings.wslEnabled && settings.wslDistro && settings.wslUser
		? await resolveWslEnvironment(settings.wslDistro, settings.wslUser, {
			warn: (message, detail) => {
				console.warn(`[OmpDeck] ${message}`, detail);
				void appLogger?.warn("wsl", message, detail);
			},
		})
		: null;

	activeWslEnvironment = environment;
	await sessionScanner.configureWsl(environment);
	skillManager.configureWsl(environment);
	promptManager.configureWsl(environment);
	extensionManager.configureWsl(environment);
	agentManager?.configureWsl(environment);
	configManager?.configureWsl(environment);
	xuePromptManager?.configureWsl(environment);
	return environment;
}

function applyNativeThemeSource(settings: AppSettings) {
	// 原生标题栏不受 renderer CSS 影响；跟随应用主题，避免暗色界面顶部仍是系统浅色栏。
	nativeTheme.themeSource = settings.theme === "system" ? "system" : settings.theme;
}

const POSTHOG_PROJECT_KEY =
	process.env.POSTHOG_PROJECT_KEY ??
	"phc_xgJ8gFUMgExZEEPzZ7VRa7698ENcaDRquWZVGYb2dCFK";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

// focusMainWindow 和 setupTray 的实现已提取到 TrayManager 类。
// 这里转发调用以保持对现有调用点的兼容性。
function focusMainWindow() {
	trayManager?.focusMainWindow();
}

/**
 * 主窗口是否处于不可用状态（空白页/崩溃），需要重建而非仅聚焦。
 * 除渲染进程崩溃外，主 frame 加载失败（如 dev server 失联）也会让窗口停留在
 * 错误页——此时二次启动只聚焦无济于事，必须重建窗口走一遍加载/回退逻辑。
 */
function mainWindowNeedsRecovery(window: BrowserWindow): boolean {
	if (window.isDestroyed()) return true;
	if (window.webContents.isCrashed()) return true;
	return mainFrameLoadFailed;
}

/**
 * 同版本次实例请求聚焦：窗口健康则前置；窗口损坏（加载失败/渲染崩溃）则销毁重建；
 * 若窗口尚未创建/已销毁，ready 后重建。
 * 挂到顶层 focusExistingWindow，供版本单实例锁的 .focus 信号调用。
 */
function handleVersionFocusRequest() {
	if (
		mainWindow &&
		!mainWindow.isDestroyed() &&
		!mainWindowNeedsRecovery(mainWindow)
	) {
		focusMainWindow();
		return;
	}
	void app.whenReady().then(() => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			if (!mainWindowNeedsRecovery(mainWindow)) {
				focusMainWindow();
				return;
			}
			// 窗口还在但渲染已坏：重建而非聚焦，避免用户反复启动都看到空白页
			void appLogger?.warn("app", "Recreating unhealthy main window on version focus request", {
				crashed: mainWindow.webContents.isCrashed(),
				loadFailed: mainFrameLoadFailed,
				url: mainWindow.webContents.getURL(),
			});
			mainWindow.destroy();
		}
		if (settingsStore) {
			void createWindow().catch((error) => {
				void appLogger?.error("app", "Failed to recreate window on version focus request", error);
			});
		}
	});
}

// 顶层锁回调延后绑定：focusMainWindow / createWindow 定义在锁申请之后。
focusExistingWindow = handleVersionFocusRequest;

function setupTray() {
	trayManager?.setupTray();
}

/**
 * 重启应用：统一清理后 relaunch + quit。
 * 必须先置 isQuitting，否则 closeToTray 会把退出流程吞成「隐藏到托盘」，relaunch 不生效；
 * 清理失败不能拦住重启，否则应用会卡死在"点了没反应"。
 * 托盘菜单与设置页「重启」IPC（registerAppHandlers → appRestart）共用此流程。
 */
function restartApp() {
	isQuitting = true;
	void webServiceManager?.stop();
	terminalManager?.closeAll();
	void agentManager?.stopAll();
	// 先释放单实例锁再 relaunch：新实例启动时旧实例仍持有锁（锁内 PID 存活判定），
	// 会被当成"同版本二次启动"而写 .focus 后立即退出，导致重启变成退出、应用不再回来。
	// 旧实例随后 will-quit 的 dispose 是幂等的，读到新实例 PID 不会误删新锁。
	versionSingleInstance.dispose();
	app.relaunch();
	app.quit();
}

/** 启动窗口预设 → BrowserWindow 初始尺寸；fullscreen/maximized 另用 setFullScreen/maximize。 */
function resolveStartupWindowBounds(mode: StartupWindowMode): {
	width: number;
	height: number;
} {
	switch (mode) {
		case "normal-compact":
			return { width: 1100, height: 720 };
		case "normal-medium":
			return { width: 1280, height: 840 };
		case "normal-large":
			return { width: 1480, height: 960 };
		case "maximized":
		case "fullscreen":
		default:
			// 全屏/最大化前仍给一个合理兜底尺寸，避免显示器信息异常时缩成最小窗
			return { width: 1480, height: 960 };
	}
}

/** 在窗口创建后应用启动尺寸预设；隐藏态先 maximize/fullscreen，减少首帧跳动。 */
function applyStartupWindowMode(
	window: BrowserWindow,
	mode: StartupWindowMode,
	showImmediately: boolean,
) {
	if (mode === "fullscreen") {
		// setFullScreen 在某些平台要求窗口已 show；隐藏态先 maximize 再在 show 后补全屏。
		if (showImmediately) {
			window.setFullScreen(true);
		} else {
			window.maximize();
			window.once("show", () => {
				if (!window.isDestroyed()) window.setFullScreen(true);
			});
		}
		return;
	}
	if (mode === "maximized") {
		window.maximize();
	}
}

async function openExternalUrl(url: string, forceSystem?: boolean) {
	// 转发给 LinkOpener 处理
	await linkOpener.openExternalUrl(url, forceSystem);
}

function printStartupInfo() {
	if (!mainWindow || mainWindow.isDestroyed()) return;

	const settings = settingsStore.get();
	const appVersion = app.getVersion();
	const electronVersion = process.versions.electron;
	const chromeVersion = process.versions.chrome;
	const nodeVersion = process.versions.node;
	const platform = process.platform;
	const arch = process.arch;
	const persistentInstallationType = settings.installationType || "unknown";
	const isPortableEnv = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
	// Debug 中展示实际生效类型,便于发现持久化值和运行时便携信号不一致的问题。
	const effectiveInstallationType =
		process.platform === "win32" && isPortableEnv ? "portable" : persistentInstallationType;

	// 执行 console.log 输出到开发者工具
	mainWindow.webContents.executeJavaScript(`
		console.log(
			"%c╭──────────────────────────────────────────────────────────╮",
			"color: #8b5cf6; font-weight: bold;"
		);
		console.log(
			"%c│                     OmpDeck Desktop                       │",
			"color: #8b5cf6; font-weight: bold; font-size: 16px;"
		);
		console.log(
			"%c╰──────────────────────────────────────────────────────────╯",
			"color: #8b5cf6; font-weight: bold;"
		);
		console.log("");
		console.log("%c📦 Application Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  Version:         %c${appVersion}", "color: #6b7280;", "color: #10b981; font-weight: bold;");
		console.log("%c  Installation:    %c${effectiveInstallationType}", "color: #6b7280;", "color: #f59e0b; font-weight: bold;");
		console.log("%c  Platform:        %c${platform} (${arch})", "color: #6b7280;", "color: #8b5cf6;");
		console.log("");
		console.log("%c⚡ Runtime Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  Electron:        %c${electronVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("%c  Chrome:          %c${chromeVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("%c  Node:            %c${nodeVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("");
		console.log("%c🔧 Debug Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  PORTABLE_EXECUTABLE_DIR: %c${isPortableEnv ? '✅ Set' : '❌ Not set'}", "color: #6b7280;", "color: ${isPortableEnv ? '#10b981' : '#ef4444'};");
		console.log("%c  Persistent installationType: %c${persistentInstallationType}", "color: #6b7280;", "color: #8b5cf6; font-weight: bold;");
		console.log("");
		console.log("%c🐛 Found a bug? Report at:", "color: #6b7280;");
		console.log("%c  https://github.com/HiHaWarzid/OmpDeck/issues", "color: #3b82f6; text-decoration: underline;");
		console.log("");
		console.log("%c🎉 Easter egg: You found it! Thanks for exploring.", "color: #ec4899; font-weight: bold;");
		console.log("");
	`);
}

async function prepareMainPreloadPath() {
	const sourcePath = join(__dirname, "../preload/index.js");
	return preparePreloadPath(sourcePath, "main-preload.js");
}

async function createWindow() {
	// 重建窗口时重置加载健康状态，让新窗口重新尝试 dev URL（若仍失联则再次回退构建产物）
	mainFrameLoadFailed = false;
	pendingErrorPageFinish = false;
	mainWindowDevFallbackTried = false;
	applyNativeThemeSource(settingsStore.get());
	const windowOptions = settingsStore.createWindowOptions();
	const showMainWindowImmediately = shouldShowMainWindowImmediately();
	const sourcePreloadPath = join(__dirname, "../preload/index.js");
	const mainPreloadPath = await prepareMainPreloadPath();
	void appLogger.info("app", "Main window preload configured", {
		sourcePreloadPath,
		preloadPath: mainPreloadPath,
		sourceExists: existsSync(sourcePreloadPath),
		exists: existsSync(mainPreloadPath),
		appPath: app.getAppPath(),
		userDataPath: app.getPath("userData"),
		packaged: app.isPackaged,
		isDev: is.dev,
		electronRendererUrl: process.env.ELECTRON_RENDERER_URL ? "set" : "unset",
	});

	// 根据用户的主题设置选择窗口背景色，避免系统标题栏与暗色主题间出现浅色条带。
	const theme = settingsStore.get().theme;
	const isDark =
		theme === "dark" ||
		(theme === "system" && nativeTheme.shouldUseDarkColors);
	// 窗口背景色同时是启动链上两帧的间隙底色：data URL loading 页 → boot-overlay
	// 跨文档导航时旧页面销毁、新页面未提交，此间隙会露出 backgroundColor。
	// 对齐两处 loading 渐变的主色（浅 #eef0f3 / 深 #111315），避免闪出异色纯色帧。
	const backgroundColor = isDark ? "#111315" : "#eef0f3";

	// 按外观设置的启动预设调整初始尺寸；隐藏态先 maximize/fullscreen，减少首帧跳动。
	// startupWindowMode="last"：读上次关闭时的窗口大小；读不到（首次启动/记录损坏）顺延默认 maximized。
	const requestedWindowMode = settingsStore.get().startupWindowMode ?? "last";
	let effectiveStartupMode = requestedWindowMode;
	let startupBounds: { width: number; height: number };
	if (requestedWindowMode === "last") {
		const last = readLastWindowBounds(app.getPath("userData"));
		if (last) {
			startupBounds = last;
		} else {
			effectiveStartupMode = "maximized";
			startupBounds = resolveStartupWindowBounds("maximized");
		}
	} else {
		startupBounds = resolveStartupWindowBounds(requestedWindowMode);
	}

	mainWindow = new BrowserWindow({
		show: showMainWindowImmediately,
		backgroundColor,
		width: startupBounds.width,
		height: startupBounds.height,
		minWidth: 880,
		minHeight: 640,
		title: "",
		icon: iconPath,
		frame: windowOptions.frame,
		titleBarStyle: windowOptions.titleBarStyle,
		...(windowOptions.trafficLightPosition ? { trafficLightPosition: windowOptions.trafficLightPosition } : {}),
		webPreferences: {
			preload: mainPreloadPath,
			// 与启动期 no-sandbox 开关一致；改配置后必须整应用重启。
			sandbox: electronChromiumSandboxEnabled,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: true,
		},
	});
	const createdWindow = mainWindow;
	let hasShownMainWindow = false;
	function showMainWindowOnce(source: string) {
		if (createdWindow.isDestroyed() || hasShownMainWindow) return;
		hasShownMainWindow = true;
		void appLogger.info("app", "Main window shown", {
			source,
			url: createdWindow.webContents.getURL(),
			readyState: createdWindow.webContents.isLoading() ? "loading" : "loaded",
		});
		createdWindow.show();
		createdWindow.focus();
		// 向开发者工具输出启动信息
		printStartupInfo();
	}

	applyStartupWindowMode(
		mainWindow,
		effectiveStartupMode,
		showMainWindowImmediately,
	);

	// 所有 target="_blank" 或 window.open 的链接统一经同一入口处理，遵守用户设置的打开方式。
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		void openExternalUrl(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("did-start-loading", () => {
		void appLogger.info("app", "Main window load started", {
			url: mainWindow?.webContents.getURL(),
		});
	});
	mainWindow.webContents.on("did-stop-loading", () => {
		void appLogger.info("app", "Main window load stopped", {
			url: mainWindow?.webContents.getURL(),
		});
	});
	mainWindow.webContents.on("did-finish-load", () => {
		void appLogger.info("app", "Main window load finished", {
			url: mainWindow?.webContents.getURL(),
		});
		// 紧跟 did-fail-load 的这次 finish 是 Chromium 错误页本身，不视为加载成功；
		// 其余 finish 说明真实页面已加载，清除失败标记。
		if (pendingErrorPageFinish) {
			pendingErrorPageFinish = false;
		} else {
			mainFrameLoadFailed = false;
		}
		// 恢复用户设置的窗口缩放；在 did-finish-load 后应用，避免早期设置被覆盖。
		mainWindow?.webContents.setZoomFactor(settingsStore.get().zoomFactor);
	});
	mainWindow.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			void appLogger.error("app", "Main window load failed", {
				errorCode,
				errorDescription,
				validatedURL,
				isMainFrame,
			});
			if (!isMainFrame) return;
			mainFrameLoadFailed = true;
			pendingErrorPageFinish = true;
			// dev server 失联（承载它的终端/父进程被关）时，窗口会永远停在错误页。
			// 回退到已构建的 renderer 产物，保证至少能看到界面而不是空白；只回退一次。
			if (shouldUseDevRendererUrl() && !mainWindowDevFallbackTried) {
				mainWindowDevFallbackTried = true;
				void appLogger.warn("app", "Dev server unreachable, falling back to built renderer", {
					errorCode,
					errorDescription,
					validatedURL,
				});
				void mainWindow?.loadFile(join(__dirname, "../renderer/index.html"));
			}
		},
	);
	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		const level: AppLogLevel = details.reason === "clean-exit" ? "info" : "error";
		void appLogger.log(level, "app", "Main window renderer process gone", {
			...details,
			platform: process.platform,
			arch: process.arch,
		});
	});
	mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
		void appLogger.error("app", "Main window preload failed", {
			preloadPath,
			message: error.message,
			stack: error.stack,
		});
	});
	mainWindow.webContents.on("dom-ready", () => {
		void mainWindow?.webContents
			.executeJavaScript("Boolean(window.piDesktop)", true)
			.then((hasPiDesktop) => {
				void appLogger.info("app", "Main window preload API availability", {
					hasPiDesktop,
					url: mainWindow?.webContents.getURL(),
				});
			})
			.catch((error) => {
				void appLogger.warn("app", "Main window preload API check failed", error);
			});
	});
	mainWindow.webContents.on(
		"console-message",
		(event) => {
			if (!["warning", "error"].includes(event.level)) return;
			void appLogger.warn("app", "Main window renderer console error", {
				level: event.level,
				message: event.message,
				line: event.lineNumber,
				sourceId: event.sourceId,
			});
		},
	);

	mainWindow.once("ready-to-show", () => {
		// 即使窗口已由其他门控显示也记录：用于诊断 hidden 窗口首帧渲染
		// （ready-to-show）是否晚于 did-finish-load / 兜底。
		void appLogger.info("app", "Main window ready-to-show", {
			alreadyShown: hasShownMainWindow,
			url: mainWindow?.webContents.getURL(),
		});
		showMainWindowOnce("ready-to-show");
	});
	// did-finish-load 后若首帧（ready-to-show）尚未触发，再宽限 800ms 等合成器出帧，
	// 避免窗口显示在首帧前露出纯色空白；宽限到点仍未出帧则先显示（兜底，不能永不显示）。
	// 正常路径下 ready-to-show 先触发，这里只是保险。
	mainWindow.webContents.once("did-finish-load", () => {
		setTimeout(() => showMainWindowOnce("did-finish-load+800ms"), 800);
	});
	setTimeout(() => showMainWindowOnce("timeout-3s"), 3000);
	if (showMainWindowImmediately) {
		showMainWindowOnce("immediate");
	}

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
	// 窗口大小记忆：关闭/退出前保存 normal bounds（最大化/全屏时取恢复后的尺寸），
	// 供下次 startupWindowMode="last" 启动使用；隐藏到托盘不记录（窗口未关闭）。
	// 注意：mainWindow 为模块级可空变量，此处用创建后的局部引用确保非空。
	const windowForState = createdWindow;
	windowForState.on("close", () => {
		if (!windowForState.isDestroyed()) {
			const normal = windowForState.isMaximized() || windowForState.isFullScreen()
				? windowForState.getNormalBounds()
				: windowForState.getBounds();
			saveLastWindowBounds(app.getPath("userData"), { width: normal.width, height: normal.height });
		}
	});

	mainWindow.on("close", (event) => {
		if (!isQuitting && settingsStore.get().closeToTray) {
			event.preventDefault();
			mainWindow?.hide();
		} else if (!isQuitting) {
			// 如果没有启用托盘，关闭窗口时直接退出应用
			isQuitting = true;
			app.quit();
		}
	});

	// 监听浏览器标准快捷键打开开发者工具
	mainWindow.webContents.on("before-input-event", (event, input) => {
		if (!mainWindow || mainWindow.isDestroyed()) return;

		// F12
		if (input.key === "F12" && input.type === "keyDown") {
			event.preventDefault();
			if (mainWindow.webContents.isDevToolsOpened()) {
				mainWindow.webContents.closeDevTools();
			} else {
				mainWindow.webContents.openDevTools({ mode: "detach" });
			}
		}

		// Ctrl+Shift+I (Windows/Linux) 或 Cmd+Option+I (macOS)
		const isMac = process.platform === "darwin";
		const ctrlOrCmd = isMac ? input.meta : input.control;
		const shiftOrOption = input.shift || (isMac && input.alt);

		if (
			ctrlOrCmd &&
			shiftOrOption &&
			input.key.toLowerCase() === "i" &&
			input.type === "keyDown"
		) {
			event.preventDefault();
			if (mainWindow.webContents.isDevToolsOpened()) {
				mainWindow.webContents.closeDevTools();
			} else {
				mainWindow.webContents.openDevTools({ mode: "detach" });
			}
		}

		// Ctrl+Shift+J (Windows/Linux) 或 Cmd+Option+J (macOS) - 直接打开 Console
		if (
			ctrlOrCmd &&
			shiftOrOption &&
			input.key.toLowerCase() === "j" &&
			input.type === "keyDown"
		) {
			event.preventDefault();
			if (mainWindow.webContents.isDevToolsOpened()) {
				mainWindow.webContents.closeDevTools();
			} else {
				mainWindow.webContents.openDevTools({ mode: "detach", activate: true });
			}
		}
	});

	const devRendererUrl = shouldUseDevRendererUrl()
		? process.env.ELECTRON_RENDERER_URL
		: undefined;

	// 直接加载真实 renderer（其 index.html 自带 boot-overlay 启动画面），不再先切
	// data URL loading 页：跨文档导航会整页替换（旧页消失→间隙→新页出现），即使两页
	// 内容同构也造成可感知的闪烁。窗口显示由 ready-to-show 门控（Electron 保证该时机
	// 显示无视觉闪烁），窗口出现时 boot-overlay 已渲染完成，启动画面与 React 之间
	// 只有 boot-overlay 自身的淡出过渡，全程无整页切换。
	if (devRendererUrl) {
		// 重启（app.relaunch）后 vite 已被 electron-vite CLI 带走，直接 loadURL 会
		// 白等一次连接失败；先短超时探测，不通则直接走构建产物。
		const reachable = await devServerReachable(devRendererUrl);
		if (reachable) {
			void mainWindow.loadURL(devRendererUrl).catch((error) => {
				void appLogger.error("app", "Main renderer load failed", { error });
			});
		} else {
			void appLogger.warn("app", "Dev server unreachable, loading built renderer", {
				url: devRendererUrl,
			});
			void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
		}
	} else {
		void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

function shouldUseDevRendererUrl() {
	return is.dev && !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
}

/**
 * 探测 dev server 是否可达。重启应用（app.relaunch）时 electron-vite CLI 已随旧实例
 * 退出并把 vite 一起杀掉，直接 loadURL(dev) 会白等一次连接失败（数百 ms ~ 秒级）。
 * 先做短超时 TCP 探测：不通则直接加载构建产物，跳过失败的导航尝试。
 */
function devServerReachable(url: string, timeoutMs = 300): Promise<boolean> {
	const { promise, resolve: settle } = Promise.withResolvers<boolean>();
	const { hostname, port } = new URL(url);
	const socket = connect({ host: hostname, port: Number(port) });
	socket.setTimeout(timeoutMs);
	const done = (result: boolean) => {
		socket.destroy();
		settle(result);
	};
	socket.once("connect", () => done(true));
	socket.once("error", () => done(false));
	socket.once("timeout", () => done(false));
	return promise;
}

function shouldShowMainWindowImmediately() {
	return isUsingLinuxXWaylandWorkaround(petEnabledAtLaunch);
}

// ===== 飞书桥接 IPC =====

/** 自动连接：启动时检查已保存的 Bot 配置，自动连接 */
async function autoConnectFeishu() {
	const bots = listBots();
	if (bots.length === 0) return;
	const bot = bots.find((b) => b.enabled);
	if (!bot) return;
	// 不再自动连接，由用户手动在配置页点击连接
	// 避免应用重启后静默恢复连接导致用户困惑
	console.log("[飞书] 检测到已保存的 Bot 配置:", bot.name, "(跳过自动连接，需手动连接)");
}

function registerIpc() {
	// ===== 已提取到 src/main/ipc/ 的命名空间 =====
	registerLogHandlers({ appLogger, rpcLogger });
	registerSkillHandlers({ skillManager, appLogger });
	registerTerminalHandlers({ terminalManager, appLogger });
	registerExtensionHandlers({
		extensionManager,
		appLogger,
		getActiveWslEnvironment: () => activeWslEnvironment,
	});
	registerEditorHandlers({
		settingsStore,
		appLogger,
		getMainWindow: () => mainWindow,
	});
	registerPromptHandlers({ promptManager, appLogger });
	registerScratchPadHandlers({ appLogger });
	registerStoreHandlers({ promptManager, skillManager, xuePromptManager, appLogger });
	registerProjectHandlers({
		projectStore,
		projectResourceManager,
		settingsStore,
		appLogger,
		agentManager,
		gitService,
		worktreeService,
		getMainWindow: () => mainWindow,
		getActiveWslEnvironment: () => activeWslEnvironment,
		syncWslEnvironment,
	});
	registerFileHandlers({ projectStore, fileSystemService, settingsStore, appLogger });
	registerSessionHandlers({ projectStore, sessionScanner, importPipeline, agentManager, appLogger });
	registerGitHandlers({ projectStore, gitService, settingsStore, worktreeService, appLogger, quickGen: quickGen! });
	registerConfigHandlers({ configManager, agentManager, appLogger });
	registerPiHandlers({ piLocator, settingsStore, extensionManager, appLogger, configManager });
	registerAgentHandlers({
		agentManager,
		terminalManager,
		appLogger,
		getFeishuBridge: () => feishuBridge,
		getMainWindow: () => mainWindow,
	});
	registerAppHandlers({
		appLogger,
		settingsStore,
		agentManager,
		terminalManager,
		piLocator,
		updateManager,
		getMainWindow: () => mainWindow,
		setIsQuitting: (value: boolean) => {
			isQuitting = value;
		},
		// 重启前主动让出单实例锁，保证 relaunch 的新实例能拿到主实例身份
		releaseSingleInstanceLock: () => versionSingleInstance.dispose(),
		// 托盘菜单与设置 IPC 共用同一重启语义
		restartApp,
		getPetSystem: () => petSystem,
		getWebServiceManager: () => webServiceManager,
		openExternalUrl,
		syncWslEnvironment,
		applyNativeThemeSource,
	});

	/**
	 * 执行 npm install 安装命令，返回 stdout/stderr/exitCode。
	 * 用于首次安装向导中让用户一键安装 pi CLI。
	 * 使用 execFile 而非 spawn 以确保命令执行完毕后一次性返回完整输出。
	 */
	ipcMain.handle(
		ipcChannels.piExecInstall,
		async (_event, command: string): Promise<import("../shared/types").PiInstallExecResult> => {
			void appLogger.info("pi", "Executing install command", { command });
			try {
				const { execFile } = await import("node:child_process");
				const result = await new Promise<import("../shared/types").PiInstallExecResult>((resolve) => {
					// Windows 下通过 cmd /c 执行命令，确保 npm.cmd shim 能被正确调用。
					// Unix 直接使用 shell:true 兼容通过 nvm/n 等版本管理器安装的 npm。
					const isWin = process.platform === "win32";
					if (isWin) {
						const child = execFile(
							process.env.ComSpec || "cmd.exe",
							["/d", "/s", "/c", command],
							{
								cwd: app.getPath("home"),
								timeout: 120_000, // npm install 最长 2 分钟
								env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
								windowsHide: true,
								encoding: "utf8",
								shell: false,
							},
							(error: unknown, stdout: string, stderr: string) => {
								const execError = error as { code?: number | string } | null;
								resolve({
									success: !error,
									exitCode: typeof execError?.code === "number" ? execError.code : execError ? -1 : 0,
									stdout: stdout || "",
									stderr: stderr || "",
								});
							},
						);
					} else {
						execFile(
							"/bin/sh",
							["-c", command],
							{
								cwd: app.getPath("home"),
								timeout: 120_000,
								env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
								encoding: "utf8",
							},
							(error: unknown, stdout: string, stderr: string) => {
								const execError = error as { code?: number | string } | null;
								resolve({
									success: !error,
									exitCode: typeof execError?.code === "number" ? execError.code : execError ? -1 : 0,
									stdout: stdout || "",
									stderr: stderr || "",
								});
							},
						);
					}
				});
				void appLogger.info("pi", "Install command completed", {
					success: result.success,
					exitCode: result.exitCode,
					stdoutLength: result.stdout.length,
					stderrLength: result.stderr.length,
				});
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void appLogger.error("pi", "Install command threw", { error: message });
				return { success: false, exitCode: -1, stdout: "", stderr: message };
			}
		},
	);

	/**
	 * 检查 npm 是否可在系统中执行。
	 * 通过执行 npm --version 判断，返回版本号或错误信息。
	 * 用于首次安装向导中判断是否应显示 npm install 按钮或引导安装 Node.js。
	 */
	ipcMain.handle(
		ipcChannels.piCheckNpm,
		async (): Promise<import("../shared/types").NpmAvailabilityResult> => {
			try {
				const { execFile } = await import("node:child_process");
				const result = await new Promise<import("../shared/types").NpmAvailabilityResult>((resolve) => {
					const isWin = process.platform === "win32";
					if (isWin) {
						execFile(
							process.env.ComSpec || "cmd.exe",
							["/d", "/s", "/c", "npm --version"],
							{ timeout: 10_000, encoding: "utf8", windowsHide: true, shell: false },
							(error, stdout) => {
								if (error) {
									resolve({ available: false, error: error.message });
								} else {
									resolve({ available: true, version: stdout.trim() });
								}
							},
						);
					} else {
						execFile(
							"npm",
							["--version"],
							{ timeout: 10_000, encoding: "utf8" },
							(error, stdout) => {
								if (error) {
									resolve({ available: false, error: error.message });
								} else {
									resolve({ available: true, version: stdout.trim() });
								}
							},
						);
					}
				});
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { available: false, error: message };
			}
		},
	);
}

function sendTelemetryHeartbeat() {
	const telemetry = new TelemetryService({
		settingsStore,
		config: {
			projectKey: POSTHOG_PROJECT_KEY,
			host: POSTHOG_HOST,
		},
		metadata: {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			packaged: app.isPackaged,
		},
		capture: async (request) => {
			const response = await net.fetch(request.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request.body),
			});
			if (!response.ok) {
				throw new Error(`Telemetry request failed: ${response.status}`);
			}
		},
	});

	void telemetry.sendHeartbeat().catch(() => undefined);
}

async function detectExternalEditorsOnFirstLaunch() {
	const current = settingsStore.get().externalEditors;
	if (Object.values(current).some((editor) => editor.command)) return;
	const detected = await detectExternalEditors();
	if (detected.length === 0) return;
	await settingsStore.update({
		externalEditors: mergeDetectedExternalEditors(current, detected),
	});
	void appLogger.info("editor", "External editors detected on first launch", { count: detected.length });
}

// 同版本二次启动的唤起由 acquireVersionSingleInstance 的 .focus 文件 + handleVersionFocusRequest 完成。
// 不再使用 Electron 全局 second-instance（它无法按版本区分）。

app.whenReady().then(async () => {
	// 未拿到同版本主实例锁时不要继续初始化，避免第二进程短暂闪窗。
	if (singleInstanceEnabled && !gotSingleInstanceLock) return;

	projectStore = new ProjectStore();
	fileSystemService = new FileSystemService();
	sessionScanner = new SessionScanner();
	importPipeline = new ImportPipeline(join(app.getPath("home"), ".omp", "agent", "sessions"));
	importPipeline.registerAdapter(new OpenCodeImportAdapter(join(app.getPath("home"), ".local", "share", "opencode", "opencode.db")));
	importPipeline.registerAdapter(new ClaudeImportAdapter(join(app.getPath("home"), ".claude", "projects")));
	importPipeline.registerAdapter(new CodexImportAdapter(join(app.getPath("home"), ".codex", "sessions")));
	settingsStore = new SettingsStore();
	appLogger = new AppLogger();
	rpcLogger = new RpcLogger();
	updateManager = new UpdateManager({ appLogger, getMainWindow: () => mainWindow });
	linkOpener = new LinkOpener({ getMainWindow: () => mainWindow, getSettings: () => settingsStore.get() });
	trayManager = new TrayManager({ getMainWindow: () => mainWindow, setIsQuitting: (v) => { isQuitting = v; }, onQuit: () => { app.quit(); }, onRestart: restartApp });
	gitService = new GitService();
	worktreeService = new WorktreeService();
	piLocator = new PiLocator("omp");
	configManager = new ConfigManager();
	promptManager = new PromptManager();
	xuePromptManager = new XuePromptManager();
	skillManager = new SkillManager();
	extensionManager = new ExtensionManager(
		piLocator,
		() => settingsStore.get(),
		() => settingsStore.get(),
		(patch) => settingsStore.update(patch),
		appLogger,
	);
	quickGen = new QuickGenProcess({
		locator: piLocator,
		getSettings: () => settingsStore.get(),
		appLogger,
	});
	projectResourceManager = new ProjectResourceManager((projectId) => projectStore.get(projectId));
	agentManager = new AgentManager(
		(id) => projectStore.get(id),
		() => mainWindow,
		settingsStore,
		configManager,
		rpcLogger,
		appLogger,
	);
	webServiceManager = new WebServiceManager({
		listProjects: () => projectStore.list(),
		listAgents: () => agentManager.list(),
		listSessions: (projectId) => {
			const project = projectStore.get(projectId);
			return sessionScanner.list(project?.path);
		},
		getMessages: (agentId) => agentManager.getMessages(agentId),
		createAgent: (input) => agentManager.create(input),
		sendPrompt: (input) => agentManager.sendPrompt(input),
		stopAgent: (agentId) => agentManager.stop(agentId),
		runtimeState: (agentId) => agentManager.getRuntimeState(agentId),
		cycleModel: (agentId) => agentManager.cycleModel(agentId),
		availableModels: (agentId) => agentManager.getAvailableModels(agentId),
		setModel: (agentId, provider, modelId) => agentManager.setModel(agentId, provider, modelId),
		refreshModels: (agentId) => agentManager.refreshModels(agentId),
		cycleThinking: (agentId) => agentManager.cycleThinking(agentId),
		setThinking: (agentId, level) => agentManager.setThinking(agentId, level),
	});
	terminalManager = new TerminalSessionManager(
		(agentId) => agentManager.getCwd(agentId),
		(channel, payload) => {
			try {
				if (mainWindow && !mainWindow.webContents.isDestroyed()) {
					mainWindow.webContents.send(channel, payload);
				}
			} catch {
				// 窗口已关闭时静默忽略，避免 pty 后发事件抛 "Object has been destroyed"
			}
		},
	);

	// 启动关键路径只等设置加载与 IPC 注册，尽快 createWindow。
	// 扩展部署、WSL 同步、代理/Web 服务/宠物等后置，避免打包后点击启动要先等一长串磁盘/网络 IO。
	await settingsStore.load();
	registerIpc();
	registerFeishuHandlers({
		agentManager,
		projectStore,
		appLogger,
		getMainWindow: () => mainWindow,
		getFeishuBridge: () => feishuBridge,
		setFeishuBridge: (bridge) => {
			feishuBridge = bridge;
		},
	});
	await createWindow();
	setupTray();

	void runPostWindowStartupTasks().catch((error) => {
		void appLogger.warn("app", "Post-window startup tasks failed", error);
	});

	// macOS dock 点击或任务栏点击时恢复窗口
	app.on("activate", () => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			focusMainWindow();
		} else {
			void createWindow().catch((error) => {
				void appLogger.error("app", "Failed to create window on activate", error);
			});
		}
	});
});

/**
 * 窗口出现后的后台启动任务。
 * 这些工作不影响首帧可见，但会拖慢 packaged app 的“点击图标 → 窗口出来”。
 */
async function runPostWindowStartupTasks(): Promise<void> {
	// 并行做无依赖的后台初始化，缩短窗口出现后的空闲等待。
	await Promise.all([
		syncWslEnvironment(settingsStore.get()).catch((error) => {
			console.error("Failed to sync WSL config:", error);
		}),
		extensionManager.deploy(app.getPath("home")).catch((error) => {
			console.error("Failed to deploy extensions:", error);
		}),
		applyDesktopProxy(settingsStore.get()).catch((error) => {
			console.error("Failed to apply desktop proxy:", error);
		}),
		// 预热 pi --version 缓存：避免首次创建 Agent 时 trust 路径同步卡住 数秒。
		PiProcess.warmVersionCache(settingsStore.get()).catch((error) => {
			console.warn("[OmpDeck] Failed to warm pi version cache:", error);
		}),
		appLogger.info("app", "Application started", {
			version: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			installationType: settingsStore.get().installationType,
		}),
	]);

	// WSL 启用时额外部署到动态解析出的 HOME。
	if (activeWslEnvironment) {
		void extensionManager.deploy(activeWslEnvironment.windowsHome).catch(() => {
			console.warn("[OmpDeck] Failed to deploy extensions to WSL, skipping");
		});
	}

	// 补齐 pi settings.json 缺失的默认配置项，新安装或精简配置的用户无需手动添加。
	void ensureAllPiSettingsDefaults(settingsStore.get(), piLocator, activeWslEnvironment).catch((error) => {
		console.error("Failed to ensure pi settings defaults:", error);
	});

	// 清理上次异常退出留下的 codeisland 停放文件，避免扩展在磁盘上永久消失。
	try {
		const home = app.getPath("home");
		const restored = restoreAllParkedExtensions([
			join(home, ".omp", "agent", "extensions"),
		]);
		if (restored.length > 0) {
			void appLogger.info("extension", "Restored parked incompatible extensions from previous session", {
				restored,
			});
		}
	} catch (error) {
		console.error("Failed to restore parked extensions:", error);
	}


	void webServiceManager.applySettings(settingsStore.get()).catch((error) => {
		console.error("Failed to start web service:", error);
		void settingsStore.update({ webServiceEnabled: false });
	});

	// 自动连接：如果已有 Bot 配置，自动启动飞书连接
	autoConnectFeishu();
	sendTelemetryHeartbeat();

	// 启动后预热扩展列表缓存，打开配置页时优先命中内存结果。
	void extensionManager.list(false).catch((error) => {
		void appLogger.warn("extension", "Warmup extensions list failed", error);
	});

	void detectExternalEditorsOnFirstLaunch().catch((error) => {
		void appLogger.warn("editor", "External editor first launch detection failed", error);
	});

	// 桌面宠物系统：新增模块，默认关闭（petEnabled=false），不触碰现有 IPC 与主窗逻辑
	petSystem = new PetSystem({
		agentManager,
		settingsStore,
		getMainWindow: () => mainWindow,
		recreateMainWindow: async () => {
			await createWindow();
			return mainWindow!;
		},
	});
	void petSystem.start().catch((error) => {
		void appLogger.warn("pet", "Pet system start failed", error);
	});

	// 项目列表可能位于杀软/同步盘较慢的 userData；窗口先显示，随后异步加载，避免 packaged app 打开时白屏等待。
	void projectStore
		.load()
		.then(() => {
			const s = settingsStore.get();
			const visible = s.wslEnabled
				? projectStore.list().filter((p) => p.kind === "chat" || p.environment === "wsl")
				: projectStore.list().filter((p) => p.kind === "chat" || !p.environment || p.environment === "windows");
			mainWindow?.webContents.send("projects:changed", visible);
		})
		.catch(() => undefined);

	// 启动后异步检查 RPC 超时时间，如果小于 600 秒则自动修正为 600 秒
	// 避免用户配置的过小超时（如 30 秒）导致启动或命令执行频繁超时
	setTimeout(() => {
		void settingsStore.ensureRpcTimeoutMinimum().catch((error) => {
			void appLogger.warn("settings", "Failed to ensure rpcTimeout minimum", error);
		});
	}, 0);
}

// 子进程（含 GPU/utility）异常退出：Mac 上偶发"整窗闪一下"，需要留下 reason/exitCode。
// 注册在模块级而非 createWindow 内：窗口重建（版本唤起恢复、macOS activate）时
// 不会累积重复的 app 级监听器。
app.on("child-process-gone", (_event, details) => {
	void appLogger.error("process", "Child process gone", {
		...details,
		platform: process.platform,
		arch: process.arch,
	});
});

app.on("before-quit", () => {
	isQuitting = true;
	trayManager?.destroy();
	void webServiceManager?.stop();
	terminalManager?.closeAll();
	agentManager?.stopAll();
	// 退出前刷盘会话摘要缓存，保证下次冷启动可复用未变化文件的摘要。
	void sessionScanner?.flushSummaryCache();
	// 退出前刷盘防抖中的设置写入，保证最后一次 update 不丢失。
	void settingsStore.flushSave().catch((error) => {
		void appLogger.warn("settings", "Failed to flush settings on quit", error);
	});
	petSystem?.stop();
	petSystem = null;
	quickGen?.stop();
	// PIDECK_PERF=1 时输出本次会话关键路径耗时汇总。
	perfDump();
});

app.on("window-all-closed", () => {
	// macOS 关闭所有窗口不退出；其他平台如果启用 closeToTray 也不退出
	if (process.platform === "darwin") return;
	if (!isQuitting) return;
	app.quit();
});
