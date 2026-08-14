/**
 * Pi/WSL IPC handler：pi CLI 检测、模型列表、WSL 发行版枚举与连接验证、pi 更新。
 *
 * 从 index.ts 的 registerIpc() 迁移而来（含原内联的 piExecInstall/piCheckNpm）。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册（通道名/协议取自通道表）。
 * cachedListModels / cachedListModelsPending 为 handler 级缓存，生命周期与注册一致。
 */
import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { AvailableModel, NpmAvailabilityResult, PiInstallExecResult } from "../../shared/types";
import { PiLocator } from "../pi/PiLocator";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import type { ConfigManager } from "../config/ConfigManager";

/**
 * 解析 pi --list-models 表格输出为 AvailableModel[]。
 * 表格格式：provider  model  context  max-out  thinking  images
 */
function parsePiListModels(stdout: string): Array<{ provider: string; id: string; name?: string; thinking: boolean; supportsImages: boolean }> {
	const lines = stdout.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) return [];
	// 跳过表头
	const dataLines = lines.slice(1);
	const models: Array<{ provider: string; id: string; name?: string; thinking: boolean; supportsImages: boolean }> = [];
	for (const line of dataLines) {
		// 列1: provider, 列2: model, 列6: thinking (yes/no), 列7: images (yes/no)
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3) continue;
		const provider = parts[0];
		const modelId = parts[1];
		// thinking 和 images 在倒数第二列和最后一列
		const thinking = parts[parts.length - 2]?.toLowerCase() === "yes";
		const images = parts[parts.length - 1]?.toLowerCase() === "yes";
		models.push({
			provider,
			id: modelId,
			name: `${provider}/${modelId}`,
			thinking,
			supportsImages: images,
		});
	}
	return models;
}

/** 智能查找 wsl.exe：优先绝对路径（含 32-bit Sysnative 绕过），全部不存在时回退到 PATH */
const wslExeResolved = (() => {
	const root = process.env.SystemRoot || "C:\\Windows";
	const candidates = process.arch === "ia32"
		? [join(root, "Sysnative", "wsl.exe"), join(root, "System32", "wsl.exe")]
		: [join(root, "System32", "wsl.exe")];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { command: candidate, shell: false };
	}
	return { command: "wsl", shell: true };
})();
const wslExePath = wslExeResolved.command;
const wslShell = wslExeResolved.shell;

interface PiHandlerDeps {
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	extensionManager: ExtensionManager;
	appLogger: AppLogger;
	configManager: ConfigManager;
}

type PiHandlerMaps = {
	pi: IpcHandlerMap<typeof ipcTable.pi, PiDesktopApi["pi"]>;
	wsl: IpcHandlerMap<typeof ipcTable.wsl, PiDesktopApi["wsl"]>;
	projects: Pick<IpcHandlerMap<typeof ipcTable.projects, PiDesktopApi["projects"]>, "listModels">;
};

export function registerPiHandlers(deps: PiHandlerDeps): PiHandlerMaps {
	const { piLocator, settingsStore, extensionManager, appLogger, configManager } = deps;

	// 从 pi --list-models 获取可用模型列表（无需启动 agent）
	// 全局缓存：首次运行后复用，避免每次打开选择器都 fork 子进程
	let cachedListModels: AvailableModel[] | null = null;
	let cachedListModelsPending: Promise<AvailableModel[]> | null = null;

	return {
		pi: {
			check: async () => {
				// 用户手动指定的路径优先于自动检测
				const settings = settingsStore.get();
				const status = await piLocator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
				void appLogger.info("pi", "Pi check completed", {
					installed: status.installed,
					version: status.version,
					command: status.command,
					error: status.error,
				});
				return status;
			},
			checkCustom: async (_event, customPath: string) => {
				const status = await piLocator.validateCustomPath(customPath);
				// 校验通过后持久化归一化后的路径，后续启动 agent 时 PiProcess 会从 settings 读取。
				// 例如用户粘贴 "D:\\foo\\pi" 时，PiLocator 会返回可执行的 D:\foo\pi.cmd。
				if (status.installed && status.command) {
					await settingsStore.update({ customPiPath: status.command });
				}
				void appLogger.info("pi", "Custom pi path checked", {
					installed: status.installed,
					version: status.version,
					command: status.command,
					error: status.error,
				});
				return status;
			},
			checkUpdate: async () => {
				const result = await extensionManager.checkPiUpdate();
				void appLogger.info("pi", "Pi update check completed", { currentVersion: result.currentVersion, latestVersion: result.latestVersion, hasUpdate: result.hasUpdate, error: result.error });
				return result;
			},
			update: async () => {
				const result = await extensionManager.updatePi();
				void appLogger.info("pi", "Pi update command completed", { updated: result.updated, bytes: result.output.length });
				return result;
			},
			/**
			 * 执行 npm install 安装命令，返回 stdout/stderr/exitCode。
			 * 用于首次安装向导中让用户一键安装 pi CLI。
			 * 使用 execFile 而非 spawn 以确保命令执行完毕后一次性返回完整输出。
			 */
			execInstall: async (_event, command: string): Promise<PiInstallExecResult> => {
				void appLogger.info("pi", "Executing install command", { command });
				try {
										const result = await new Promise<PiInstallExecResult>((resolve) => {
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
			/**
			 * 检查 npm 是否可在系统中执行。
			 * 通过执行 npm --version 判断，返回版本号或错误信息。
			 * 用于首次安装向导中判断是否应显示 npm install 按钮或引导安装 Node.js。
			 */
			checkNpm: async (): Promise<NpmAvailabilityResult> => {
				try {
										const result = await new Promise<NpmAvailabilityResult>((resolve) => {
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
		},
		wsl: {
			// WSL: 列出已安装的发行版（仅 Windows 有效，其他平台返回空数组）
			listDistros: async () => {
				if (process.platform !== "win32") return [] as string[];
				try {
										return new Promise<string[]>((resolve) => {
						execFile(wslExePath, ["-l", "-q"], { encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
							(err, stdout) => {
								if (err) { resolve([]); return; }
								// 过滤空行、\0 字符、Windows 文件后缀等非法发行版名
								const distros = stdout.split(/\r?\n/)
									.map((s) => s.trim())
									.filter((s) => s.length > 0 && !s.includes("\\") && !s.includes("\x00"));
								resolve(distros);
							});
					});
				} catch { return [] as string[]; }
			},
			// WSL: 验证连接性 — 分步检查 distro+user 可达性 和 pi 可用性
			validateConnection: async (_event, distro: string, user: string) => {
				if (process.platform !== "win32") {
					return { ok: false, whoami: "", piVersion: "", error: "WSL 仅在 Windows 上可用" };
				}
				try {
										// Step 1: 验证 distro + user 可达
					const whoami = await new Promise<string>((resolve, reject) => {
						execFile(wslExePath, ["-d", distro, "-u", user, "whoami"],
							{ encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
							(err, stdout) => {
								if (err) { reject(err); return; }
								resolve(stdout.trim());
							});
					});
					// Step 2: 检查 omp CLI 是否已安装（走 PiLocator 的 binaryName，避免硬编码 "pi"）
					// 复用已实例化的 piLocator（binaryName="omp"），保证与 RPC 启动用的是同一个命令。
					const ompCommand = piLocator instanceof PiLocator ? piLocator.binaryName : "omp";
					let piVersion = "";
					try {
						piVersion = await new Promise<string>((resolve, reject) => {
							execFile(wslExePath, ["-d", distro, "-u", user, ompCommand, "--version"],
								{ encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
								(err, stdout) => {
									if (err) { reject(err); return; }
									resolve(stdout.trim());
								});
						});
					} catch { /* omp 未安装，piVersion 保持空 */ }
					return {
						ok: true,
						whoami,
						piVersion,
						error: piVersion ? "" : `omp CLI 未安装 - 请在 WSL 中运行 npm i -g @oh-my-pi/omp`,
					};
				} catch (err) {
					return {
						ok: false,
						whoami: "",
						piVersion: "",
						error: `无法连接到 WSL 发行版 "${distro}" 用户 "${user}"：${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
		},
		projects: {
			listModels: async (_event, _projectId?: string) => {
				try {
					if (cachedListModels) return cachedListModels;
					// 已有在途请求时复用同一个 Promise，避免并发 fork 多个 pi 进程
					if (cachedListModelsPending) return cachedListModelsPending;

					cachedListModelsPending = (async () => {
						const settings = settingsStore.get();
						const command = piLocator.resolveCommand(
							settings.customPiPath,
							settings.wslEnabled,
							settings.wslDistro,
							settings.wslUser,
						);
						const invocation = piLocator.createInvocation(command, ["--list-models"]);
												const result = await new Promise<{ stdout: string }>((resolve, reject) => {
							execFile(invocation.command, invocation.args, {
								env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
								shell: invocation.shell,
								windowsHide: true,
								timeout: 15_000,
								encoding: "utf8",
								windowsVerbatimArguments: invocation.windowsVerbatimArguments,
							}, (error, stdout, stderr) => {
								if (error) {
									const message = (stderr || error.message).slice(0, 300);
									reject(new Error(message));
								} else {
									resolve({ stdout });
								}
							});
						});
						const models = await configManager.filterConfiguredModels(parsePiListModels(result.stdout));
						cachedListModels = models;
						return models;
					})();
					const models = await cachedListModelsPending;
					return models;
				} catch (error) {
					cachedListModelsPending = null;
					void appLogger.warn("pi", "Failed to list models", {
						error: error instanceof Error ? error.message : String(error),
					});
					return [];
				}
			},
		},
	};
}
