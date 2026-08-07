import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	nativeTheme,
	net,
	shell,
	Tray,
} from "electron";
import { basename, join, resolve } from "node:path";
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
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
import type { StartupWindowMode } from "../shared/types";
// 使用 ?asset 后缀导入图标，electron-vite 会在构建时将其复制到输出目录并提供正确的运行时路径
// 这解决了打包后 build/ 目录不在 asar 中导致托盘图标丢失的问题
import iconPath from "../../build/icon.png?asset";
// 托盘图标使用预渲染的小尺寸 PNG，避免从 512x512 下采样导致模糊
import trayIconPath from "../../build/icons/32x32.png?asset";

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
	AppUpdateAsset,
	AppUpdateDownloadProgress,
	AppLogLevel,
	AppLogQuery,
	AppUpdateDownloadResult,
	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
	AppUpdateInfo,
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
import { PiRpcClient } from "./pi/PiRpcClient";
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
import { BUILT_IN_EXTENSIONS, ExtensionManager } from "./extensions/ExtensionManager";
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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 标记是否由用户主动退出（托盘菜单「退出」），区别于窗口关闭隐藏到托盘 */
let isQuitting = false;
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
let feishuBridge: FeishuBridge | null = null;
let activeWslEnvironment: WslEnvironment | null = null;

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

const RELEASES_URL = "https://github.com/HiHaWarzid/OmpDeck";
const LATEST_RELEASE_API =
	"https://api.github.com/repos/HiHaWarzid/OmpDeck/releases/latest";
// Fork 仓库尚未发布 Release 时回退到上游 PiDeck 检查，避免 404 导致检查更新始终失败。
const UPSTREAM_LATEST_RELEASE_API =
	"https://api.github.com/repos/ayuayue/PiDeck/releases/latest";
// GitHub API 认证：设置 GITHUB_TOKEN 环境变量可提升请求限额（5000次/小时→5000次/小时），
// 避免国内网络下因限频（403）导致检查更新失败。
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.PI_DECK_GITHUB_TOKEN ?? "";
const POSTHOG_PROJECT_KEY =
	process.env.POSTHOG_PROJECT_KEY ??
	"phc_xgJ8gFUMgExZEEPzZ7VRa7698ENcaDRquWZVGYb2dCFK";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

type GitHubReleaseAsset = {
	name: string;
	browser_download_url: string;
	size: number;
};

type GitHubRelease = {
	tag_name?: string;
	name?: string;
	body?: string;
	html_url?: string;
	published_at?: string;
	assets?: GitHubReleaseAsset[];
};

function normalizeVersion(version: string) {
	return version.trim().replace(/^v/i, "");
}

function parseVersion(version: string) {
	const normalized = normalizeVersion(version);
	const dashIdx = normalized.indexOf("-");
	const mainVer = dashIdx >= 0 ? normalized.slice(0, dashIdx) : normalized;
	const preRel = dashIdx >= 0 ? normalized.slice(dashIdx + 1) : "";
	return {
		main: mainVer.split(".").map((p) => Number(p)),
		pre: preRel
			? preRel.split(/[.-]/).map((p) => (isNaN(Number(p)) ? p : Number(p)))
			: [],
	};
}

/**
 * 语义化版本比较，符合 semver 规范：
 * - 主版本号（major.minor.patch）逐段比较
 * - pre-release 版本 < 正式版（如 0.6.6-beta.1 < 0.6.6）
 * - pre-release 之间逐段比较，数字按数值、字符串按字典序
 */
function compareVersions(left: string, right: string) {
	const l = parseVersion(left);
	const r = parseVersion(right);
	const maxLen = Math.max(l.main.length, r.main.length);
	for (let i = 0; i < maxLen; i++) {
		const diff = (l.main[i] ?? 0) - (r.main[i] ?? 0);
		if (diff !== 0) return diff;
	}
	// 主版本相等时比较 pre-release
	if (l.pre.length === 0 && r.pre.length > 0) return 1;  // 正式版 > pre-release
	if (l.pre.length > 0 && r.pre.length === 0) return -1; // pre-release < 正式版
	// 两个都是 pre-release，逐段比较
	const preLen = Math.max(l.pre.length, r.pre.length);
	for (let i = 0; i < preLen; i++) {
		if (l.pre[i] === undefined) return -1;
		if (r.pre[i] === undefined) return 1;
		if (typeof l.pre[i] === "number" && typeof r.pre[i] === "number") {
			if (l.pre[i] !== r.pre[i]) return (l.pre[i] as number) - (r.pre[i] as number);
		} else {
			const cmp = String(l.pre[i]).localeCompare(String(r.pre[i]));
			if (cmp !== 0) return cmp;
		}
	}
	return 0;
}

function selectRecommendedAsset(
	assets: AppUpdateAsset[],
	installationType?: "portable" | "installed",
) {
	const platform = process.platform;
	const arch = process.arch;
	// Windows 便携版以 electron-builder 注入的运行时环境变量为准；旧 settings 可能残留 installed。
	const isPortable =
		platform === "win32"
			? process.env.PORTABLE_EXECUTABLE_DIR !== undefined || installationType === "portable"
			: installationType === "portable";

	// 映射资产以便匹配
	const candidates = assets.map((asset) => ({
		...asset,
		lowerName: asset.name.toLowerCase(),
	}));

	// 根据架构确定关键词，严格匹配
	const archKeywords =
		arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "amd64", "x86_64"];
	const matchesArch = (name: string) =>
		archKeywords.some((keyword) => name.includes(keyword));

	// 检查是否为非目标架构（用于排除不匹配的资产）
	const isWrongArch = (name: string) => {
		if (arch === "arm64") {
			// 当前是 ARM64，排除 x64 相关的
			return /\b(x64|amd64|x86_64)\b/i.test(name);
		} else {
			// 当前是 x64，排除 arm64 相关的
			return /\b(arm64|aarch64)\b/i.test(name);
		}
	};

	const isWindowsAsset = (name: string) =>
		/\.(exe|msi)$/i.test(name) || (name.endsWith(".zip") && !/(mac|darwin|osx|linux|appimage|deb|tar\.gz)/i.test(name));
	const isMacAsset = (name: string) => /\.(dmg)$/i.test(name) || /(mac|darwin|osx)/i.test(name);
	const isLinuxAsset = (name: string) => /(appimage|\.deb$|\.tar\.gz$|linux)/i.test(name);

	if (platform === "win32") {
		// Windows 只能在 Windows 资产里挑选；Release 同时包含 macOS zip，不能用全局 zip 回退。
		const platformCandidates = candidates.filter((asset) => isWindowsAsset(asset.lowerName));
		// Windows: 优先匹配当前安装形态（便携版 vs 安装版）和架构
		if (isPortable) {
			// 便携版 exe 是单文件绿色版，无需安装；优先推荐非 Setup 的便携 exe，其次 .zip
			return (
				platformCandidates.find(
					(asset) => !asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => !asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
				)
			);
		} else {
			// 安装版：优先推荐带 Setup 的安装 exe，其次普通 exe，最后 zip
			return (
				platformCandidates.find(
					(asset) => asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
				)
			);
		}
	}

	if (platform === "darwin") {
		// macOS 只在 macOS 资产中选择，避免 x64 zip 回退到 Windows/Linux 包。
		const platformCandidates = candidates.filter((asset) => isMacAsset(asset.lowerName));
		return (
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".dmg") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".dmg") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
			)
		);
	}

	if (platform === "linux") {
		// Linux 只在 Linux 资产中选择，避免跨平台 zip/exe 被误推荐。
		const platformCandidates = candidates.filter((asset) => isLinuxAsset(asset.lowerName));
		return (
			platformCandidates.find(
				(asset) => asset.lowerName.includes("appimage") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) =>
					asset.lowerName.includes("appimage") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".deb") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".deb") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".tar.gz") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".tar.gz") && !isWrongArch(asset.lowerName),
			)
		);
	}

	// 回退：返回第一个匹配架构的资产
	return candidates.find((asset) => matchesArch(asset.lowerName)) ?? candidates[0];
}

async function checkForAppUpdate(
	installationType?: "portable" | "installed",
): Promise<AppUpdateInfo> {
	const currentVersion = app.getVersion();
	void appLogger.info("update", "Check for app update", { currentVersion, installationType });
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": `OmpDeck/${currentVersion}`,
	};
	if (GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
	}
	// Fork 仓库可能尚未发布 Release（404），此时回退到上游 PiDeck 检查，避免检查更新始终失败。
	let response = await fetch(LATEST_RELEASE_API, { headers });
	let releaseUrlFallback = RELEASES_URL;
	if (!response.ok && response.status === 404) {
		response = await fetch(UPSTREAM_LATEST_RELEASE_API, { headers });
		releaseUrlFallback = "https://github.com/ayuayue/PiDeck";
	}
	if (!response.ok) {
		throw new Error(`GitHub Release 检查失败：HTTP ${response.status}`);
	}
	const release = (await response.json()) as GitHubRelease;
	const latestVersion = normalizeVersion(release.tag_name || currentVersion);
	const assets = (release.assets ?? []).map((asset) => ({
		name: asset.name,
		url: asset.browser_download_url,
		size: asset.size,
	}));
	const recommendedAsset = selectRecommendedAsset(assets, installationType);
	void appLogger.info("update", "App update check completed", {
		currentVersion,
		latestVersion,
		hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
		recommendedAsset: recommendedAsset?.name,
	});
	return {
		currentVersion,
		latestVersion,
		hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
		releaseName: release.name || `v${latestVersion}`,
		releaseNotes: release.body || "",
		releaseUrl: release.html_url || releaseUrlFallback,
		publishedAt: release.published_at,
		assets,
		recommendedAsset,
	};
}

function emitUpdateProgress(progress: AppUpdateDownloadProgress) {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(ipcChannels.appUpdateProgress, progress);
}

async function downloadUpdateAsset(asset: AppUpdateAsset): Promise<AppUpdateDownloadResult> {
	if (!asset.url || !/^https:\/\//i.test(asset.url)) {
		throw new Error("无效的更新下载地址");
	}

	const safeName = basename(asset.name).replace(/[<>:"/\\|?*]+/g, "-");
	const downloadDir = join(app.getPath("userData"), "updates");
	await mkdir(downloadDir, { recursive: true });
	const filePath = join(downloadDir, safeName);
	const startedAt = Date.now();
	let receivedBytes = 0;
	let totalBytes = asset.size > 0 ? asset.size : undefined;

	// 使用 Electron net 下载可继承 Chromium 的 TLS/代理能力；进度通过 IPC 推送给 renderer。
	return new Promise((resolve, reject) => {
			void appLogger.info("update", "Download update asset started", { assetName: asset.name, url: asset.url });
		const request = net.request({ method: "GET", url: asset.url });
		request.setHeader("User-Agent", `OmpDeck/${app.getVersion()}`);
		request.on("redirect", (_statusCode, _method, redirectUrl) => {
			// GitHub browser_download_url 通常会 302 到对象存储,必须显式跟随重定向。
			request.followRedirect();
			void appLogger.debug("update", "Follow update download redirect", { redirectUrl });
		});
		request.on("response", (response) => {
			if (response.statusCode < 200 || response.statusCode >= 300) {
				const error = new Error(`下载失败：HTTP ${response.statusCode}`);
				emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: error.message });
				reject(error);
				return;
			}

			const contentLength = Number(response.headers["content-length"]);
			if (Number.isFinite(contentLength) && contentLength > 0) totalBytes = contentLength;
			const output = createWriteStream(filePath);
			response.on("data", (chunk: Buffer) => {
				receivedBytes += chunk.length;
				output.write(chunk);
				const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
				emitUpdateProgress({
					assetName: asset.name,
					receivedBytes,
					totalBytes,
					percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : undefined,
					bytesPerSecond: receivedBytes / elapsedSeconds,
					state: "downloading",
				});
			});
			response.on("end", () => output.end());
			output.on("finish", () => {
				output.close(() => {
					emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, percent: 100, state: "completed", filePath });
					void appLogger.info("update", "Download update asset completed", { assetName: asset.name, filePath, receivedBytes });
					resolve({ filePath, assetName: asset.name });
				});
			});
			output.on("error", (error) => {
				emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: error.message });
				reject(error);
			});
		});
		request.on("error", (error) => {
			emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: error.message });
			reject(error);
		});
		request.end();
	});
}

async function installDownloadedUpdate(filePath: string) {
	// Windows/Linux 不同包类型的真正静默自更新风险较高；这里交给系统打开安装包或文件位置。
	// 便携版用户通常下载 zip/AppImage/tar.gz 后需要替换当前目录,避免在运行中覆盖自身可执行文件。
	await appLogger.info("update", "Open downloaded update package", { filePath });
	await shell.openPath(filePath);
}

/** 从托盘/任务栏/二次启动唤起主窗口：处理最小化、隐藏到托盘两种状态。 */
function focusMainWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	// 托盘隐藏时需重新显示任务栏按钮，否则只 focus 可能仍不可见。
	if (typeof mainWindow.setSkipTaskbar === "function") {
		mainWindow.setSkipTaskbar(false);
	}
	mainWindow.show();
	mainWindow.focus();
	// Windows：短暂置顶再取消，避免已有窗口在后台时 second-instance 只亮任务栏不前置。
	if (process.platform === "win32") {
		mainWindow.setAlwaysOnTop(true);
		mainWindow.setAlwaysOnTop(false);
	}
}

/**
 * 同版本次实例请求聚焦：窗口已在则前置；若窗口尚未创建/已销毁，ready 后重建。
 * 挂到顶层 focusExistingWindow，供版本单实例锁的 .focus 信号调用。
 */
function handleVersionFocusRequest() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		focusMainWindow();
		return;
	}
	void app.whenReady().then(() => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			focusMainWindow();
			return;
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
	// 托盘图标：直接使用预渲染 32x32 PNG，高 DPI 下清晰；不额外 resize 以免模糊
	tray = new Tray(nativeImage.createFromPath(trayIconPath));
	tray.setToolTip("OmpDeck");

	// 双击托盘图标恢复窗口（Windows 常见交互）
	tray.on("double-click", () => {
		focusMainWindow();
	});

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "显示窗口",
			click: () => {
				focusMainWindow();
			},
		},
		{ type: "separator" },
		{
			label: "退出 OmpDeck",
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]);
	tray.setContextMenu(contextMenu);
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
	// 允许 http/https 以及 file:// 协议（用于本地 HTML 预览等场景）
	if (!url.startsWith("http:") && !url.startsWith("https:") && !url.startsWith("file:")) return;
	// forceSystem 为 true 时绕过 linkOpenMode 设置，始终用系统默认浏览器
	if (forceSystem) {
		await shell.openExternal(url);
		return;
	}
	const settings = settingsStore.get();
	if (settings.linkOpenMode === "internal") {
		openInternalLinkInBrowserPanel(url);
		return;
	}
	await shell.openExternal(url);
}

function openInternalLinkInBrowserPanel(url: string) {
	// 内部打开：将 URL 发送到渲染进程，由 BrowserPanel 在侧栏/弹框中加载，
	// 替代之前的独立 BrowserWindow 方案，保持一致的浏览体验。
	if (!mainWindow || mainWindow.isDestroyed()) {
		void shell.openExternal(url);
		return;
	}
	mainWindow.webContents.send(ipcChannels.appOpenInBrowser, url);
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
	const lightBg = settingsStore.get().lightBackground;
	const isDark =
		theme === "dark" ||
		(theme === "system" && nativeTheme.shouldUseDarkColors);
	const lightBgColors: Record<string, string> = {
		white: "#ffffff",
		warm: "#f3f4f1",
		paper: "#f7f6f1",
		blue: "#f4f8ff",
		green: "#f4fbf6",
	};
	const backgroundColor = isDark
		? "#111315"
		: (lightBgColors[lightBg] ?? "#f3f4f1");

	const startupWindowMode = settingsStore.get().startupWindowMode ?? "maximized";
	const startupBounds = resolveStartupWindowBounds(startupWindowMode);

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
	function showMainWindowOnce() {
		if (createdWindow.isDestroyed() || hasShownMainWindow) return;
		hasShownMainWindow = true;
		createdWindow.show();
		createdWindow.focus();
		// 向开发者工具输出启动信息
		printStartupInfo();
	}

	// 按外观设置的启动预设调整尺寸；隐藏态先 maximize/fullscreen，减少首帧跳动。
	applyStartupWindowMode(
		mainWindow,
		startupWindowMode,
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
	mainWindow.webContents.on("did-finish-load", () => {
		void appLogger.info("app", "Main window load finished", {
			url: mainWindow?.webContents.getURL(),
		});
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
	// 子进程（含 GPU/utility）异常退出：Mac 上偶发“整窗闪一下”，需要留下 reason/exitCode。
	app.on("child-process-gone", (_event, details) => {
		void appLogger.error("process", "Child process gone", {
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

	mainWindow.once("ready-to-show", showMainWindowOnce);
	mainWindow.webContents.once("did-finish-load", showMainWindowOnce);
	setTimeout(showMainWindowOnce, 3000);
	if (showMainWindowImmediately) {
		showMainWindowOnce();
	}

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
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
	if (devRendererUrl) {
		mainWindow.loadURL(devRendererUrl);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

function shouldUseDevRendererUrl() {
	return is.dev && !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
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
		ensurePiDeckExtension,
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
	registerGitHandlers({ projectStore, gitService, settingsStore, worktreeService, appLogger });
	registerConfigHandlers({ configManager, agentManager, appLogger });
	registerPiHandlers({ piLocator, settingsStore, extensionManager, appLogger });
	registerAgentHandlers({
		agentManager,
		terminalManager,
		appLogger,
		getFeishuBridge: () => feishuBridge,
	});
	registerAppHandlers({
		appLogger,
		settingsStore,
		agentManager,
		terminalManager,
		piLocator,
		releasesUrl: RELEASES_URL,
		getMainWindow: () => mainWindow,
		setIsQuitting: (value: boolean) => {
			isQuitting = value;
		},
		getPetSystem: () => petSystem,
		getWebServiceManager: () => webServiceManager,
		checkForAppUpdate,
		downloadUpdateAsset,
		installDownloadedUpdate,
		openExternalUrl,
		syncWslEnvironment,
		applyNativeThemeSource,
	});

	async function ensureGenProcess(
		projectPath: string,
		command: string,
	): Promise<PiRpcClient> {
		console.log("[QuickGen] ensureGenProcess", { projectPath, command, existingPid: genProcess?.pid ?? null });

		// 如果已有进程还在运行，直接复用（跨项目也复用）
		if (genProcess && genRpcClient && genProcess.exitCode === null) {
			console.log("[QuickGen] reusing existing process, pid:", genProcess.pid);
			genProcessCwd = projectPath;
			resetGenIdleTimer();
			return genRpcClient;
		}

		// 清理旧进程（已死才重建）
		if (genProcess) {
			console.log("[QuickGen] stopping old process");
			stopGenProcess();
		}

		const settings = settingsStore.get();
		const invocation = piLocator.createInvocation(command, [
			"--mode", "rpc",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-themes",
			"--thinking", "off",
		]);

		console.log("[QuickGen] spawning", { command: invocation.command, args: invocation.args, cwd: projectPath });

		genProcess = spawn(invocation.command, invocation.args, {
			cwd: projectPath,
			env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
			stdio: ["pipe", "pipe", "pipe"],
			shell: invocation.shell,
			windowsHide: true,
			windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		});
		genProcessCwd = projectPath;
		console.log("[QuickGen] spawned, pid:", genProcess.pid);

		genRpcClient = new PiRpcClient(genProcess.stdin!, genProcess.stdout!);
		console.log("[QuickGen] RPC client created");

		// stderr 仅用于调试日志
		genProcess.stderr!.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").slice(0, 300);
			console.log("[QuickGen] stderr:", text);
			void appLogger?.warn("git", "QuickGen stderr", text);
		});

		// 进程退出时清理状态
		genProcess.on("exit", (code, signal) => {
			console.log("[QuickGen] process exited", { code, signal });
			void appLogger?.warn("git", "QuickGen process exited", { code, signal });
			stopGenProcess();
		});

		genProcess.on("error", (err) => {
			console.log("[QuickGen] process ERROR", err.message);
			void appLogger?.error("git", "QuickGen process error", err.message);
		});

		resetGenIdleTimer();
		return genRpcClient;
	}

	/** 通过持久化的 RPC 进程快速生成文本 */
	async function quickGenerate(projectPath: string, prompt: string): Promise<string> {
		console.log("[QuickGen] quickGenerate called", { projectPath });
		const settings = settingsStore.get();
		const command = piLocator.resolveCommand(
			settings.customPiPath,
			settings.wslEnabled,
			settings.wslDistro,
			settings.wslUser,
		);
		console.log("[QuickGen] resolved command", { command });

		const rpc = await ensureGenProcess(projectPath, command);
		console.log("[QuickGen] process ready, sending prompt", { length: prompt.length });

		return new Promise<string>((resolve, reject) => {
			const collected: string[] = [];
			let settled = false;
			const timeout = setTimeout(() => {
				if (!settled) {
					console.log("[QuickGen] TIMEOUT", { collected: collected.join("").slice(0, 200) });
					void appLogger?.warn("git", "QuickGen timed out", { collected: collected.join("").slice(0, 200) });
					reject(new Error("Quick generate timed out"));
				}
			}, 60_000);

			const onEvent = (event: Record<string, unknown>) => {
				const eventType = event.type as string;
				if (eventType === "message_update") {
					const ae = (event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
					if (ae?.type === "text_delta" && typeof ae.delta === "string") {
						collected.push(ae.delta);
						console.log("[QuickGen] text_delta", { delta: ae.delta.slice(0, 50) });
					}
				}
				if (eventType === "agent_settled" || eventType === "agent_end") {
					console.log("[QuickGen] event received", { eventType });
					settled = true;
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					const text = collected.join("");
					console.log("[QuickGen] completed", { length: text.length });
					void appLogger?.warn("git", "QuickGen completed", { length: text.length });
					resolve(text);
				}
			};

			rpc.on("event", onEvent);

			console.log("[QuickGen] sending prompt via RPC");
			rpc.request({ type: "prompt", message: prompt }).then((response) => {
				console.log("[QuickGen] prompt response", { success: response.success, error: response.error });
				if (!response.success) {
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					reject(new Error(response.error ?? "Prompt rejected"));
				}
			}).catch((err) => {
				console.log("[QuickGen] prompt request failed", { error: err.message });
				clearTimeout(timeout);
				rpc.off("event", onEvent);
				reject(err);
			});
		});
	}

	console.log("[QuickGen] gitGenerateCommitMessage handler registered");
	ipcMain.handle(
		ipcChannels.gitGenerateCommitMessage,
		async (_event, projectId: string) => {
			console.log("[QuickGen] IPC handler called", { projectId });
			const project = projectStore.get(projectId);
			if (!project) {
				console.log("[QuickGen] project not found");
				return "";
			}

			const diff = await gitService.getStagedDiff(project.path, 10000);
			if (!diff.trim()) {
				console.log("[QuickGen] no staged diff");
				return "";
			}
			console.log("[QuickGen] diff obtained", { length: diff.length });

			// 从设置中读取提示词模板，替换 {diff} 为实际 diff 内容
			const promptTemplate = settingsStore.get().gitCommitMessagePrompt ||
				"请根据以下 git diff 生成一条中文 git commit message。\n\n{diff}\n\n直接输出 commit 消息。";
			const prompt = promptTemplate.replace("{diff}", diff.slice(0, 8000));

			try {
				console.log("[QuickGen] calling quickGenerate");
				const result = await quickGenerate(project.path, prompt);
				console.log("[QuickGen] done", { length: result.length });
				void appLogger?.warn("git", "Generate commit message result", { length: result.length, text: result.slice(0, 100) });
				return result.trim();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.log("[QuickGen] FAILED", { error: msg });
				void appLogger?.warn("git", "Generate commit message failed", { error: msg });
				throw err;
			}
		},
	);

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

// ── 持久化轻量 pi RPC 进程（用于快速文本生成，避免每次启动开销） ──────
let genProcess: ChildProcess | null = null;
let genRpcClient: PiRpcClient | null = null;
let genProcessCwd = "";
let genIdleTimer: NodeJS.Timeout | null = null;

/** 清理快速生成进程，包括 RPC 客户端和空闲定时器 */
function stopGenProcess() {
	if (genIdleTimer) {
		clearTimeout(genIdleTimer);
		genIdleTimer = null;
	}
	genRpcClient?.close();
	genRpcClient = null;
	if (genProcess && genProcess.exitCode === null) {
		try { genProcess.kill(); } catch { /* ignore */ }
	}
	genProcess = null;
	genProcessCwd = "";
}

/** 重置空闲定时器：30 分钟无请求自动杀掉进程释放内存 */
function resetGenIdleTimer() {
	if (genIdleTimer) clearTimeout(genIdleTimer);
	genIdleTimer = setTimeout(() => {
		void appLogger?.debug("git", "QuickGen idle timeout, killing process");
		stopGenProcess();
	}, 30 * 60 * 1000);
	if (genIdleTimer && typeof genIdleTimer === "object") genIdleTimer.unref?.();
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
	);
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
	// 启动后异步校准内置扩展：对比 resources 与用户目录全文，不一致则覆盖。
	// 用户手动移除的记在 removedBuiltInExtensions，跳过自动部署。
	const deployExtensionsTo = async (homeDir: string) => {

		const removedBuiltIn = new Set(settingsStore.get().removedBuiltInExtensions ?? []);
		const summary = {
			homeDir,
			installed: [] as string[],
			updated: [] as string[],
			unchanged: [] as string[],
			skippedRemoved: [] as string[],
			missingSource: [] as string[],
			failed: [] as Array<{ name: string; error: string }>,
		};

		// 并行校准：磁盘 IO 为主，互不依赖
		await Promise.all(
			BUILT_IN_EXTENSIONS.map(async (extensionName) => {
				if (removedBuiltIn.has(extensionName)) {
					summary.skippedRemoved.push(extensionName);
					// 历史「仅标记移除、文件仍保留」会让 pi 继续加载残留扩展，
					// 与三方同名工具（如 rpiv-todo 的 todo）冲突导致 RPC 启动失败。启动时清残留。
					try {
						await rm(join(homeDir, ".omp", "agent", "extensions", extensionName), { force: true });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						summary.failed.push({ name: extensionName, error: `purge residual: ${message}` });
						console.error(`Failed to purge residual ${extensionName}:`, error);
					}
					return;
				}
				try {
					const result = await ensurePiDeckExtension(extensionName, homeDir);
					if (result === "installed") summary.installed.push(extensionName);
					else if (result === "updated") summary.updated.push(extensionName);
					else if (result === "unchanged") summary.unchanged.push(extensionName);
					else if (result === "missing-source") summary.missingSource.push(extensionName);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					summary.failed.push({ name: extensionName, error: message });
					console.error(`Failed to sync ${extensionName}:`, error);
				}
			}),
		);

		const changedCount = summary.installed.length + summary.updated.length;
		if (changedCount > 0) {
			// 文件有变时清扩展列表缓存，配置页/下次 list 能看到最新状态
			extensionManager.invalidateListCache();
		}

		void appLogger.info("extension", "Built-in extensions sync finished", {
			homeDir: summary.homeDir,
			installed: summary.installed,
			updated: summary.updated,
			unchanged: summary.unchanged,
			skippedRemoved: summary.skippedRemoved,
			missingSource: summary.missingSource,
			failed: summary.failed,
			changedCount,
		});
		if (summary.failed.length > 0) {
			void appLogger.warn("extension", "Some built-in extensions failed to sync", {
				homeDir: summary.homeDir,
				failed: summary.failed,
			});
		}
	};

	// 并行做无依赖的后台初始化，缩短窗口出现后的空闲等待。
	await Promise.all([
		syncWslEnvironment(settingsStore.get()).catch((error) => {
			console.error("Failed to sync WSL config:", error);
		}),
		deployExtensionsTo(app.getPath("home")).catch((error) => {
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
		void deployExtensionsTo(activeWslEnvironment.windowsHome).catch(() => {
			console.warn("[OmpDeck] Failed to deploy extensions to WSL, skipping");
		});
	}

	// 补齐 pi settings.json 缺失的默认配置项，新安装或精简配置的用户无需手动添加。
	void ensureAllPiSettingsDefaults().catch((error) => {
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

/** ensurePiDeckExtension 的校准结果，供启动任务汇总日志。 */
type PiDeckExtensionSyncResult =
	| "installed"
	| "updated"
	| "unchanged"
	| "missing-source";

/**
 * 将内置扩展部署到用户扩展目录。
 * 启动时异步对比 resources 源文件与 ~/.omp/agent/extensions 目标：
 * - 目标不存在 → 安装
 * - 内容不一致（老版本/用户手改）→ 覆盖为 PiDeck 当前版本
 * - 内容一致 → 跳过写盘
 * 用户在设置里「移除」的内置扩展由调用方按 removedBuiltInExtensions 跳过，本函数不读该列表。
 */
async function ensurePiDeckExtension(
	extensionName: string,
	wslHome?: string,
): Promise<PiDeckExtensionSyncResult> {
	const home = wslHome ?? app.getPath("home");
	const extensionsDir = join(home, ".omp", "agent", "extensions");
	const targetPath = join(extensionsDir, extensionName);

	// 获取源文件路径：开发模式下在 resources/ 目录，打包后通过 process.resourcesPath 访问
	const sourcePath = is.dev
		? join(app.getAppPath(), "resources", "extensions", extensionName)
		: join(process.resourcesPath, "extensions", extensionName);

	const sourceContent = await readFile(sourcePath, "utf-8").catch(() => null);
	if (!sourceContent) {
		console.warn(`[OmpDeck] Extension source not found: ${sourcePath}`);
		void appLogger?.warn("extension", "Built-in extension source missing", {
			extensionName,
			sourcePath,
		});
		return "missing-source";
	}

	const existingContent = await readFile(targetPath, "utf-8").catch(() => null);
	// 全文比对：任意与 resources 不一致都覆盖，避免用户仍跑旧版 ask/plan/todo 扩展。
	if (existingContent === sourceContent) {
		return "unchanged";
	}

	const action: PiDeckExtensionSyncResult = existingContent == null ? "installed" : "updated";
	await mkdir(extensionsDir, { recursive: true });
	await writeFile(targetPath, sourceContent, "utf-8");
	console.log(`[OmpDeck] ${action === "installed" ? "Installed" : "Updated"} extension: ${targetPath}`);
	void appLogger?.info("extension", `Built-in extension ${action}`, {
		extensionName,
		targetPath,
		sourcePath,
		previousBytes: existingContent?.length ?? 0,
		nextBytes: sourceContent.length,
	});
	return action;
}

/**
 * 补齐 pi 全局 settings.json 的推荐默认项。
 * 仅添加缺失的 key，不覆盖用户已有配置。
 * 适用于新安装 pi 或配置精简的用户。
 */
/** 补齐指定 configDir 下 settings.json 的缺失默认项 */
async function ensurePiSettingsDefaults(configDir: string, piVersionHint?: string): Promise<void> {
	const filePath = join(configDir, "settings.json");
	let current: Record<string, unknown> = {};
	try {
		const raw = await readFile(filePath, "utf8");
		current = JSON.parse(raw) as Record<string, unknown>;
	} catch { /* 文件不存在或解析失败，使用空对象 */ }

	let changed = false;
	const defaults: Record<string, unknown> = {
		theme: "dark",
		hideThinkingBlock: false,
		defaultProjectTrust: "ask",
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		retry: { enabled: true, maxRetries: 3 },
	};

	if (piVersionHint && !current.lastChangelogVersion) {
		current.lastChangelogVersion = piVersionHint;
		changed = true;
	}

	for (const [key, defaultValue] of Object.entries(defaults)) {
		if (!(key in current)) {
			current[key] = defaultValue;
			changed = true;
		}
	}

	if (changed) {
		await mkdir(configDir, { recursive: true });
		await writeFile(filePath, JSON.stringify(current, null, 2), "utf8");
		console.log('[OmpDeck] Ensured pi settings defaults at:', filePath);
	}
}

/** 对当前环境和 WSL 环境（如果启用）都补齐 settings.json 默认项 */
async function ensureAllPiSettingsDefaults(): Promise<void> {
	const s = settingsStore.get();
	let piVersion = "";
	if (piLocator) {
		piVersion = (await piLocator.check(undefined, s.wslEnabled, s.wslDistro, s.wslUser).catch(() => null))?.version ?? "";
	}

	// Windows 本地
	const winDir = join(app.getPath("home"), ".omp", "agent");
	await ensurePiSettingsDefaults(winDir, piVersion).catch(() => {});

	// WSL（如果已配置）
	if (activeWslEnvironment) {
		const wslDir = join(activeWslEnvironment.windowsHome, ".omp", "agent");
		await ensurePiSettingsDefaults(wslDir, piVersion).catch(() => {});
	}
}

app.on("before-quit", () => {
	isQuitting = true;
	tray?.destroy();
	tray = null;
	void webServiceManager?.stop();
	terminalManager?.closeAll();
	agentManager?.stopAll();
	// 退出前刷盘会话摘要缓存，保证下次冷启动可复用未变化文件的摘要。
	void sessionScanner?.flushSummaryCache();
	petSystem?.stop();
	petSystem = null;
	stopGenProcess();
});

app.on("window-all-closed", () => {
	// macOS 关闭所有窗口不退出；其他平台如果启用 closeToTray 也不退出
	if (process.platform === "darwin") return;
	if (!isQuitting) return;
	app.quit();
});
