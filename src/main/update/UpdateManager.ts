/**
 * 应用更新管理器：版本比较、GitHub Release 检查、资产推荐、下载与安装。
 *
 * 从 src/main/index.ts 提取，将散落的版本工具函数和更新流程聚合为一个内聚模块。
 * - 纯函数（normalizeVersion/parseVersion/compareVersions/selectRecommendedAsset）无外部依赖，可直接单测。
 * - checkForAppUpdate/downloadUpdateAsset/installDownloadedUpdate 通过 deps 注入 appLogger 和 mainWindow getter。
 * - 下载使用 Electron net 模块以继承 Chromium 的 TLS/代理能力，进度通过 IPC 推送给 renderer。
 */
import { app, net, shell, type BrowserWindow } from "electron";
import { basename, join } from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { ipcChannels } from "../../shared/ipc";
import type {
	AppUpdateAsset,
	AppUpdateDownloadProgress,
	AppUpdateDownloadResult,
	AppUpdateInfo,
} from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";

// ── 常量 ──────────────────────────────────────────────

export const RELEASES_URL = "https://github.com/HiHaWarzid/OmpDeck";
const LATEST_RELEASE_API =
	"https://api.github.com/repos/HiHaWarzid/OmpDeck/releases/latest";
// GitHub API 认证：设置 GITHUB_TOKEN 环境变量可提升请求限额，
// 避免国内网络下因限频（403）导致检查更新失败。
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.PI_DECK_GITHUB_TOKEN ?? "";

// ── GitHub Release 类型 ───────────────────────────────

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

// ── 纯函数（导出供测试） ──────────────────────────────

export function normalizeVersion(version: string) {
	return version.trim().replace(/^v/i, "");
}

export function parseVersion(version: string) {
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
export function compareVersions(left: string, right: string) {
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

export function selectRecommendedAsset(
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

// ── UpdateManager ─────────────────────────────────────

export interface UpdateManagerDeps {
	appLogger: AppLogger;
	getMainWindow: () => BrowserWindow | null;
}

export class UpdateManager {
	private readonly deps: UpdateManagerDeps;

	constructor(deps: UpdateManagerDeps) {
		this.deps = deps;
	}

	/** 下载进度通过 IPC 推送给 renderer，由 renderer 展示进度条 */
	private emitUpdateProgress(progress: AppUpdateDownloadProgress) {
		const win = this.deps.getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.webContents.send(ipcChannels.appUpdateProgress, progress);
	}

	async checkForAppUpdate(
		installationType?: "portable" | "installed",
	): Promise<AppUpdateInfo> {
		const { appLogger } = this.deps;
		const currentVersion = app.getVersion();
		void appLogger.info("update", "Check for app update", { currentVersion, installationType });
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"User-Agent": `OmpDeck/${currentVersion}`,
		};
		if (GITHUB_TOKEN) {
			headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
		}
		// Fork 仓库尚未发布 Release（404）时不回退到上游 PiDeck 检查：
		// 上游安装包（PiDeck.Setup.*.exe）不适用于 OmpDeck，提示会误导用户下载错误产物；
		// 自家 repo 发布 Release 后检查自然生效。仍失败（如 403 限频）抛错走原逻辑。
		const response = await fetch(LATEST_RELEASE_API, { headers });
		if (!response.ok) {
			if (response.status === 404) {
				void appLogger.info("update", "No OmpDeck release published, update check skipped", {
					currentVersion,
				});
				return {
					currentVersion,
					latestVersion: currentVersion,
					hasUpdate: false,
					releaseName: `v${currentVersion}`,
					releaseNotes: "",
					releaseUrl: RELEASES_URL,
					publishedAt: undefined,
					assets: [],
					recommendedAsset: undefined,
				};
			}
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
			releaseUrl: release.html_url || RELEASES_URL,
			publishedAt: release.published_at,
			assets,
			recommendedAsset,
		};
	}

	async downloadUpdateAsset(asset: AppUpdateAsset): Promise<AppUpdateDownloadResult> {
		const { appLogger } = this.deps;
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
					this.emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: error.message });
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
					this.emitUpdateProgress({
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
						this.emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, percent: 100, state: "completed", filePath });
						void appLogger.info("update", "Download update asset completed", { assetName: asset.name, filePath, receivedBytes });
						resolve({ filePath, assetName: asset.name });
					});
				});
				output.on("error", (error) => {
					this.emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: error.message });
					reject(error);
				});
			});
			request.on("error", (error) => {
				this.emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: error.message });
				reject(error);
			});
			request.end();
		});
	}

	async installDownloadedUpdate(filePath: string) {
		// Windows/Linux 不同包类型的真正静默自更新风险较高；这里交给系统打开安装包或文件位置。
		// 便携版用户通常下载 zip/AppImage/tar.gz 后需要替换当前目录,避免在运行中覆盖自身可执行文件。
		const { appLogger } = this.deps;
		await appLogger.info("update", "Open downloaded update package", { filePath });
		await shell.openPath(filePath);
	}
}
