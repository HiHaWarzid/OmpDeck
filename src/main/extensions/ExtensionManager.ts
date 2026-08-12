import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { app } from "electron";
import { is } from "@electron-toolkit/utils";
import type { AppSettings, PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiUpdateCheckResult } from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import type { AppLogger } from "../logging/AppLogger";
import { toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";

type SettingsProvider = () => AppSettings;

/** OmpDeck 内置扩展列表（已全部移除，omp 提供原生能力替代） */
export const BUILT_IN_EXTENSIONS = [] as const;

/** ensurePiDeckExtension 的校准结果，供启动任务汇总日志。 */
export type PiDeckExtensionSyncResult =
	| "installed"
	| "updated"
	| "unchanged"
	| "missing-source";

/** 启动时内置扩展部署汇总，供日志输出。 */
export interface ExtensionDeploySummary {
	homeDir: string;
	installed: string[];
	updated: string[];
	unchanged: string[];
	skippedRemoved: string[];
	missingSource: string[];
	failed: Array<{ name: string; error: string }>;
}

/**
 * 通过 omp CLI 管理已安装插件，避免桌面端直接改写 pi settings 导致和 CLI 行为不一致。
 * 自动检测 pi 版本，条件性添加 --no-approve（仅 pi >= 0.79.0 支持），
 * 兼容老版本避免 unknown option 错误。
 */
export class ExtensionManager {
	private wslEnvironment: WslEnvironment | null = null;
	/** 扩展列表缓存：避免每次打开配置页都重新跑 pi list + npm view。 */
	private listCache: PiExtensionListResult | null = null;
	/** 缓存是否包含 npm 版本信息（仅 forceRefresh 路径会写入 true）。 */
	private listCacheHasVersionInfo = false;
	/** 进行中的列表请求，用于启动预热与并发去重。 */
	private listInflight: Promise<PiExtensionListResult> | null = null;
	/** 进行中请求是否为强制刷新（含版本信息）。 */
	private listInflightForce = false;
	/**
	 * 列表缓存代数：安装/卸载/开关后递增。
	 * 用于丢弃失效前已发出的 in-flight 结果，避免旧列表写回缓存导致 UI 不刷新。
	 */
	private listCacheGeneration = 0;

	constructor(
		private readonly locator: PiLocator,
		private readonly getSettings: SettingsProvider,
		/** 获取 OmpDeck 桌面设置 */
		private readonly getPiDeckSettings: () => AppSettings,
		/** 保存 OmpDeck 桌面设置的部分更新 */
		private readonly patchPiDeckSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>,
		/** 应用日志器，用于部署/校准过程记录 */
		private readonly appLogger?: AppLogger,
	) {}

	/** 将扩展文件边界切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.wslEnvironment = environment;
		// 切换 WSL/本地 home 后旧缓存失效。
		this.invalidateListCache();
	}

	/** 当前扩展文件边界 HOME（WSL 启用时为 WSL home，否则为系统 home）。 */
	get homeDir(): string {
		return this.wslEnvironment?.windowsHome ?? homedir();
	}

	/** 缓存过期后主动清空。 */
	invalidateListCache() {
		this.listCache = null;
		this.listCacheHasVersionInfo = false;
		this.listCacheGeneration += 1;
		// 允许下一次 list() 立刻发起新请求，而不是复用失效前的 inflight。
		this.listInflight = null;
		this.listInflightForce = false;
	}

	/**
	 * 启动时异步校准内置扩展：对比 resources 源文件与用户扩展目录，
	 * 不一致则覆盖。用户在设置里「移除」的内置扩展按 removedBuiltInExtensions 跳过，
	 * 同时清理残留文件避免 pi 加载旧版导致 RPC 启动失败。
	 *
	 * @param homeDir 目标 HOME 目录；不传则使用当前 homeDir（Windows 本地或 WSL）。
	 */
	async deploy(homeDir?: string): Promise<ExtensionDeploySummary> {
		const target = homeDir ?? this.homeDir;
		const summary: ExtensionDeploySummary = {
			homeDir: target,
			installed: [],
			updated: [],
			unchanged: [],
			skippedRemoved: [],
			missingSource: [],
			failed: [],
		};

		const removedBuiltIn = new Set(this.getPiDeckSettings().removedBuiltInExtensions ?? []);

		// 并行校准：磁盘 IO 为主，互不依赖
		await Promise.all(
			BUILT_IN_EXTENSIONS.map(async (extensionName) => {
				if (removedBuiltIn.has(extensionName)) {
					summary.skippedRemoved.push(extensionName);
					// 历史「仅标记移除、文件仍保留」会让 pi 继续加载残留扩展，
					// 与三方同名工具（如 rpiv-todo 的 todo）冲突导致 RPC 启动失败。启动时清残留。
					try {
						await rm(join(target, ".omp", "agent", "extensions", extensionName), { force: true });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						summary.failed.push({ name: extensionName, error: `purge residual: ${message}` });
					}
					return;
				}
				try {
					const result = await this.ensureExtension(extensionName, target);
					if (result === "installed") summary.installed.push(extensionName);
					else if (result === "updated") summary.updated.push(extensionName);
					else if (result === "unchanged") summary.unchanged.push(extensionName);
					else if (result === "missing-source") summary.missingSource.push(extensionName);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					summary.failed.push({ name: extensionName, error: message });
				}
			}),
		);

		const changedCount = summary.installed.length + summary.updated.length;
		if (changedCount > 0) {
			// 文件有变时清扩展列表缓存，配置页/下次 list 能看到最新状态
			this.invalidateListCache();
		}

		void this.appLogger?.info("extension", "Built-in extensions sync finished", {
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
			void this.appLogger?.warn("extension", "Some built-in extensions failed to sync", {
				homeDir: summary.homeDir,
				failed: summary.failed,
			});
		}

		return summary;
	}

	/**
	 * 确保单个内置扩展文件存在于目标目录。
	 * - 目标不存在 → 安装
	 * - 内容不一致（老版本/用户手改）→ 覆盖为 PiDeck 当前版本
	 * - 内容一致 → 跳过写盘
	 *
	 * 供 restoreBuiltIn IPC handler 在用户「恢复」内置扩展时调用，
	 * 也供 deploy() 内部并行校准使用。
	 */
	async ensureExtension(
		extensionName: string,
		homeDir: string,
	): Promise<PiDeckExtensionSyncResult> {
		const extensionsDir = join(homeDir, ".omp", "agent", "extensions");
		const targetPath = join(extensionsDir, extensionName);

		// 获取源文件路径：开发模式下在 resources/ 目录，打包后通过 process.resourcesPath 访问
		const sourcePath = is.dev
			? join(app.getAppPath(), "resources", "extensions", extensionName)
			: join(process.resourcesPath, "extensions", extensionName);

		const sourceContent = await readFile(sourcePath, "utf-8").catch(() => null);
		if (!sourceContent) {
			void this.appLogger?.warn("extension", "Built-in extension source missing", {
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
		void this.appLogger?.info("extension", `Built-in extension ${action}`, {
			extensionName,
			targetPath,
			sourcePath,
			previousBytes: existingContent?.length ?? 0,
			nextBytes: sourceContent.length,
		});
		return action;
	}

	/**
	 * 列出扩展。
	 * - forceRefresh=false：优先返回内存缓存；无缓存时做一次轻量扫描（跳过 npm view）。
	 * - forceRefresh=true：强制重新 `pi list`，并补充 npm 版本信息。
	 */
	async list(forceRefresh = false): Promise<PiExtensionListResult> {
		// 有缓存且（非强制刷新，或缓存已含版本信息）时直接返回。
		if (this.listCache && (!forceRefresh || this.listCacheHasVersionInfo)) {
			return this.listCache;
		}
		// 已有同级或更强请求在飞时复用，避免并发打爆 pi/npm。
		if (this.listInflight && (!forceRefresh || this.listInflightForce)) {
			return this.listInflight;
		}

		// 捕获当前代数：若请求返回前发生 install/uninstall/toggle，丢弃结果并改走最新 list。
		const generation = this.listCacheGeneration;
		this.listInflightForce = forceRefresh;
		const request = this.loadList(forceRefresh)
			.then((result) => {
				if (generation !== this.listCacheGeneration) {
					// 失效前的调用方也必须拿到变更后的列表，否则 UI 会短暂/永久停在旧数据。
					return this.list(forceRefresh);
				}
				this.listCache = result;
				this.listCacheHasVersionInfo = forceRefresh;
				return result;
			})
			.finally(() => {
				// 仅清理自己：失效后新发起的请求可能已经接管 listInflight。
				if (this.listInflight === request) {
					this.listInflight = null;
					this.listInflightForce = false;
				}
			});
		this.listInflight = request;
		return request;
	}

	private async loadList(includeVersionInfo: boolean): Promise<PiExtensionListResult> {
		const raw = await this.runPi(["plugin", "list"], 20_000);
		const parsed = this.parseListOutput(raw);
		// npm view 是扩展页变慢的主因；默认列表先跳过，只有手动刷新时再查更新。
		const piInstalled = includeVersionInfo
			? await Promise.all(parsed.map((extension) => this.enrichExtensionVersion(extension)))
			: parsed;

		// 扫描本地自动发现的扩展，
		// omp plugin list 只列出通过 omp plugin install 安装的包，不包含本地文件扩展。
		const localExtensions = await this.scanLocalExtensions();

		// 合并，已通过 pi 安装的优先保留原条目
		const installedPaths = new Set(piInstalled.map((ext) => ext.path));
		const merged = [...piInstalled];
		for (const local of localExtensions) {
			if (!local.path || !installedPaths.has(local.path)) {
				merged.push(local);
			}
		}

		// 补充：将已禁用/文件缺失的内置扩展也纳入列表，确保用户可在 UI 中重新启用。
		const existingSources = new Set(merged.map((ext) => ext.source));
		for (const builtIn of BUILT_IN_EXTENSIONS) {
			if (!existingSources.has(builtIn)) {
				merged.push({
					id: `local:${builtIn}`,
					source: builtIn,
					path: undefined,
					scope: "user",
					builtIn: true,
				});
			}
		}

		// 通过 OmpDeck 桌面设置标记内置扩展移除状态
		const removedBuiltIn = new Set(this.getPiDeckSettings().removedBuiltInExtensions ?? []);
		for (const ext of merged) {
			ext.enabled = !(ext.builtIn && removedBuiltIn.has(ext.source));
		}

		// 仅检测 todo / plan / ask 固定冲突：三方包名含对应关键词时自动禁用内置版。
		// nul-redirect-fix 等其它内置扩展暂不参与冲突检测，避免 mode 等通用词误伤。
		// 注意：此处不走 disableBuiltIn（会 invalidateListCache），避免 list 请求中途 generation
		// 变化导致结果被丢弃后反复重入。
		const conflicts: { builtIn: string; thirdParty: string }[] = [];
		let removedChanged = false;
		// BUILT_IN_CONFLICT_KEYWORDS 已清空（omp 内置能力替代）

		if (removedChanged) {
			await this.saveRemovedBuiltIn([...removedBuiltIn]);
		}

		// 已标记移除但磁盘仍有残留时主动清掉，修复「UI 已禁用但仍冲突」的历史状态。
		for (const builtInName of removedBuiltIn) {
			if (!builtInName.startsWith("pi-deck-")) continue;
			await this.removeBuiltInFile(builtInName).catch(() => undefined);
		}

		return { extensions: merged, raw, conflicts: conflicts.length > 0 ? conflicts : undefined };
	}

	/**
	 * 扫描 ~/.omp/agent/extensions/ 目录，发现未被 pi list 列出的本地扩展。
	 * 单文件扩展（.ts 文件）和目录扩展（含 index.ts）都会被识别。
	 */
	private async scanLocalExtensions(): Promise<PiExtensionSummary[]> {
		const extensionsDir = join(this.homeDir, ".omp", "agent", "extensions");
		const result: PiExtensionSummary[] = [];

		let entries: string[];
		try {
			entries = await readdir(extensionsDir);
		} catch {
			return result; // 目录不存在时静默跳过
		}

		for (const entry of entries) {
			if (entry.startsWith(".") || entry === "node_modules" || entry.endsWith(".d.ts")) continue;

			const fullPath = join(extensionsDir, entry);
			let name = entry;
			let source = entry;

			// 处理目录扩展（目录/index.ts）
			if (entry.endsWith(".ts")) {
				// 单文件扩展，去掉 .ts 后缀作为显示名
				name = entry.slice(0, -3);
				source = entry;
			} else {
				// 目录扩展，检查是否有 index.ts
				try {
					await readFile(join(fullPath, "index.ts"), "utf-8");
					name = entry;
					source = entry;
				} catch {
					continue; // 没有 index.ts，跳过
				}
			}

			const isBuiltIn = name.startsWith("pi-deck-");
			result.push({
				id: `local:${source}`,
				source,
				path: extensionsDir,
				scope: "user",
				builtIn: isBuiltIn,
			});
		}

		return result;
	}

	/**
	 * 判断是否为本地文件扩展（~/.omp/agent/extensions 下自动发现的 .ts/目录）。
	 * pi list 的包源都带 npm:/file:/github: 等协议前缀；裸文件名只能走文件系统删除。
	 */
	private isLocalFileExtension(source: string): boolean {
		return !/^(?:npm|file|github|git|https?):/i.test(source);
	}

	/**
	 * 删除本地扩展文件/目录。
	 * 只允许删除 extensions 目录下的单层 basename，防止路径穿越。
	 */
	private async removeLocalExtension(source: string): Promise<void> {
		const extensionsDir = join(this.homeDir, ".omp", "agent", "extensions");
		const trimmed = source.trim();
		const name = basename(trimmed);
		// source 必须等于 basename（如 orca-agent-status.ts），拒绝 ../ 或绝对路径穿越。
		if (!name || name !== trimmed || name === "." || name === "..") {
			throw new Error("非法扩展路径");
		}
		const targetPath = join(extensionsDir, name);
		await rm(targetPath, { recursive: true, force: true });
	}

	async uninstall(source: string, scope: PiExtensionSummary["scope"] = "user"): Promise<void> {
		const normalized = source.trim();
		if (!normalized) throw new Error("扩展来源不能为空");
		// 内置扩展走 removeBuiltIn（设置 + 删文件），不要走 pi remove
		if (normalized.startsWith("pi-deck-")) {
			throw new Error("内置扩展请使用 removeBuiltIn 操作");
		}
		// 本地 .ts/目录扩展不在 pi package 列表里，pi remove 会报 No matching package
		if (this.isLocalFileExtension(normalized)) {
			await this.removeLocalExtension(normalized);
		} else {
			await this.runPi(["plugin", "uninstall", normalized,
				...(scope === "project" ? ["--local"] : []),
			], 30_000);
		}
		this.invalidateListCache();
	}

	/**
	 * 「移除」内置扩展：写入 OmpDeck 设置跳过自动部署，并删除用户目录中的扩展文件。
	 * 必须删文件：pi 会自动加载 ~/.omp/agent/extensions 下的 .ts，仅改设置无法阻止加载，
	 * 与同名三方工具（如 npm:@juicesharp/rpiv-todo 的 todo）会直接冲突导致 RPC 启动失败。
	 * 恢复时由 ensurePiDeckExtension 从 resources 重新部署。
	 */
	async removeBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		if (!normalized.startsWith("pi-deck-")) {
			throw new Error("只能操作内置扩展");
		}
		await this.disableBuiltIn(normalized);
	}

	/**
	 * 恢复已移除的内置扩展：从 OmpDeck 设置中移除记录，下次启动自动部署。
	 * 实际文件由调用方 ensurePiDeckExtension 写回。
	 */
	async restoreBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		const current = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
		const next = current.filter((s) => s !== normalized);
		if (next.length === current.length) return;
		await this.saveRemovedBuiltIn(next);
		this.invalidateListCache();
	}

	/**
	 * 禁用内置扩展的统一路径：记入 removedBuiltInExtensions + 删除磁盘文件。
	 * 供手动移除与三方冲突自动让位共用，保证 pi 进程侧立即不再加载。
	 */
	async disableBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		if (!normalized.startsWith("pi-deck-")) {
			throw new Error("只能操作内置扩展");
		}
		const current = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
		if (!current.includes(normalized)) {
			await this.saveRemovedBuiltIn([...current, normalized]);
		}
		await this.removeBuiltInFile(normalized);
		this.invalidateListCache();
	}

	/**
	 * 删除用户扩展目录中的内置扩展文件。
	 * 只允许 pi-deck-* 单层 basename，防止路径穿越。
	 * force: 文件本就不存在时静默成功（幂等，适合启动残留清理）。
	 */
	async removeBuiltInFile(source: string): Promise<void> {
		const extensionsDir = join(this.homeDir, ".omp", "agent", "extensions");
		const trimmed = source.trim();
		const name = basename(trimmed);
		if (!name || name !== trimmed || !name.startsWith("pi-deck-") || name === "." || name === "..") {
			throw new Error("非法内置扩展路径");
		}
		await rm(join(extensionsDir, name), { force: true });
	}

	private async saveRemovedBuiltIn(removedList: string[]): Promise<void> {
		await this.patchPiDeckSettings({ removedBuiltInExtensions: removedList });
	}

	async install(source: string): Promise<string> {
		const normalized = source.trim();
		if (!normalized) throw new Error("扩展名称不能为空");
		const result = await this.runPi(["plugin", "install", normalized], 60_000);
		this.invalidateListCache();
		return result;
	}

	/** omp 本体 npm 包名（与 omp update 内部一致，见 cli.js EAh）。 */
	private static readonly PI_NPM_PACKAGE = "@oh-my-pi/pi-coding-agent";

	async checkPiUpdate(): Promise<PiUpdateCheckResult> {
		try {
			const status = await this.locator.check(this.getSettings().customPiPath);
			if (!status.installed) return { hasUpdate: false, error: status.error ?? "omp 未安装" };
			// 用 npm view 查询最新版本：npm 继承 HTTP(S)_PROXY 等代理配置，比 omp 内置
			// update --check（bun fetch 直连 registry.npmjs.org）在代理环境下更可靠。
			const latestVersion = await this.npmViewVersion(ExtensionManager.PI_NPM_PACKAGE);
			// omp --version 输出形如 "omp/17.2.12"，提取语义版本号后再比较。
			const currentVersion =
				status.version?.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ??
				status.version?.trim() ??
				"";
			return {
				currentVersion,
				latestVersion,
				hasUpdate: this.compareVersions(latestVersion, currentVersion) > 0,
			};
		} catch (error) {
			return { hasUpdate: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async updatePi(): Promise<PiCliUpdateResult> {
		// 主路径 omp update：按安装方式（brew/mise/bun/npm）自动选择更新命令。
		// 慢网络（代理/国内直连）下 12MB tarball 下载实测可达 300s+；
		// 超时太短会导致 npm 只写完小文件、cli.js 未落盘，留下损坏安装。
		try {
			const output = await this.runPi(["update"], 600_000);
			return this.toUpdateResult("omp update", output, true);
		} catch (error) {
			const ompError = error instanceof Error ? error.message : String(error);
			// omp update 内置版本检查用 bun fetch 直连 registry，代理环境下检查阶段即失败；
			// npm 命令继承代理配置，回退 npm install 更可靠。仅当 omp 确为 npm 全局安装时
			// 回退，避免给 brew/mise 用户装出并存的 npm 副本。
			try {
				if (!(await this.isPiInstalledViaNpm())) {
					return { command: "omp update", output: ompError, updated: false };
				}
				// 同样给足 10 分钟：tarball 在慢网络下可能远超 2 分钟，提前杀掉会让
				// package.json 与 cli.js 版本不一致，破坏 omp 安装。
				const output = await this.runNpm(["install", "-g", `${ExtensionManager.PI_NPM_PACKAGE}@latest`], 600_000);
				return this.toUpdateResult(`npm install -g ${ExtensionManager.PI_NPM_PACKAGE}@latest`, output, true);
			} catch (npmError) {
				return {
					command: "omp update",
					output: `${ompError}\n\nnpm 回退安装失败：${npmError instanceof Error ? npmError.message : String(npmError)}`,
					updated: false,
				};
			}
		}
	}

	/** 检测 omp 是否安装自 npm 全局目录；非 npm 安装时避免回退装出并存的副本。 */
	private async isPiInstalledViaNpm(): Promise<boolean> {
		try {
			const output = await this.runNpm(["ls", "-g", ExtensionManager.PI_NPM_PACKAGE], 30_000);
			return output.includes(ExtensionManager.PI_NPM_PACKAGE);
		} catch {
			return false;
		}
	}

	async updateExtensions(): Promise<PiCliUpdateResult> {
		const output = await this.runPi(["update", "--plugins"], 120_000);
		// 更新后版本信息变化，强制下次 list 重新获取。
		this.invalidateListCache();
		return this.toUpdateResult("omp update --plugins", output, true);
	}

	private async enrichExtensionVersion(extension: PiExtensionSummary): Promise<PiExtensionSummary> {
		if (!extension.source.toLowerCase().startsWith("npm:")) return extension;
		const packageName = extension.source.replace(/^npm:/i, "");
		try {
			const [currentVersion, latestVersion] = await Promise.all([
				this.readInstalledVersion(extension.path),
				this.npmViewVersion(packageName),
			]);
			return {
				...extension,
				currentVersion,
				latestVersion,
				hasUpdate: Boolean(currentVersion && latestVersion && this.compareVersions(latestVersion, currentVersion) > 0),
			};
		} catch (error) {
			return { ...extension, updateError: error instanceof Error ? error.message : String(error) };
		}
	}

	private async readInstalledVersion(path?: string) {
		if (!path) return undefined;
		const hostPath = this.wslEnvironment
			? toWindowsHostPath(path, this.wslEnvironment)
			: path;
		const raw = await readFile(join(hostPath, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version;
	}

	private npmViewVersion(packageName: string) {
		return this.runNpm(["view", packageName, "version"], 30_000);
	}

	/**
	 * 执行 npm 命令。WSL 模式下 npm 也要在 WSL 内运行（与 omp 同一运行时环境），
	 * 通过 wsl:// 前缀让 PiLocator 构造 wsl.exe 调用。
	 */
	private runNpm(args: string[], timeout: number): Promise<string> {
		const settings = this.getSettings();
		const command =
			settings.wslEnabled && process.platform === "win32"
				? `wsl://${settings.wslDistro}/${settings.wslUser}/npm`
				: "npm";
		const invocation = this.locator.createInvocation(command, args);
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
					shell: invocation.shell,
					windowsHide: true,
					timeout,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						// Electron 启动环境经常缺少用户 shell PATH；通过 PiLocator 补齐 PATH 后仍失败时，把 stderr 透出给设置页。
						reject(new Error((stderr || error.message).trim()));
						return;
					}
					resolve(stdout.trim());
				},
			);
		});
	}

	private toUpdateResult(command: string, output: string, updated: boolean): PiCliUpdateResult {
		return { command, output: output.trim(), updated };
	}

	private compareVersions(a: string, b: string) {
		const left = a.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
		const right = b.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
		const len = Math.max(left.length, right.length);
		for (let index = 0; index < len; index += 1) {
			const diff = (left[index] ?? 0) - (right[index] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	}

	private async runPi(args: string[], timeout: number): Promise<string> {
		const finalArgs = [...args];
		const settings = this.getSettings();
		const command = this.locator.resolveCommand(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		const invocation = this.locator.createInvocation(command, finalArgs);
		const env = this.locator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl);
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env,
					shell: invocation.shell,
					windowsHide: true,
					timeout,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						const detail = (stderr || error.message).trim();
						reject(new Error(detail || "omp 扩展命令执行失败"));
						return;
					}
					resolve(stdout);
				},
			);
		});
	}

	private parseListOutput(raw: string): PiExtensionSummary[] {
		const result: PiExtensionSummary[] = [];
		let scope: PiExtensionSummary["scope"] = "unknown";
		let pending: PiExtensionSummary | null = null;

		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (/^User packages:/i.test(trimmed)) {
				scope = "user";
				pending = null;
				continue;
			}
			if (/^Project packages:/i.test(trimmed)) {
				scope = "project";
				pending = null;
				continue;
			}

			if (/^(?:npm|file|github|git|https?):/i.test(trimmed)) {
				pending = {
					id: `${scope}:${trimmed}`,
					source: trimmed,
					scope,
				};
				result.push(pending);
				continue;
			}

			if (pending && !pending.path) {
				pending.path = trimmed;
			}
		}

		return result;
	}
}

/**
 * 当前参与冲突检测的内置扩展与关键词。
 * todo / plan / ask：三方包名含关键词即视为功能冲突；其它内置扩展暂不自动互斥。
 */
export const BUILT_IN_CONFLICT_KEYWORDS = [] as const;

/**
 * 固定关键词冲突匹配：清理协议/作用域后，包名是否包含指定关键词。
 * 例：rpiv-todo、my-plan-helper 命中；context-mode 不含 plan/todo 不命中。
 */
export function extensionNameMatches(source: string, keyword: string): boolean {
	const clean = source
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "")
		.toLowerCase();
	return clean.includes(keyword.toLowerCase());
}
