/**
 * File IPC handler：文件树浏览/读写/创建/删除/重命名/复制/移动 + 在资源管理器中打开。
 * WSL 模式下通过 `toWindowsPath` 将 Linux 路径转为 Windows 可访问路径。
 */
import { shell } from "electron";
import { basename, dirname, join } from "node:path";
import { cp, mkdir, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { AppSettings } from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";
import type { FileSystemService } from "../fs/FileSystemService";
import type { AppLogger } from "../logging/AppLogger";
import { createProjectGuard } from "./withProjectGuard";

interface FileHandlerDeps {
	projectStore: ProjectStore;
	fileSystemService: FileSystemService;
	settingsStore: { get(): AppSettings };
	appLogger: AppLogger;
}

type FileHandlerMaps = {
	files: IpcHandlerMap<typeof ipcTable.files, PiDesktopApi["files"]>;
};

/** 单次文件读取的默认预算（字节）：与 git 侧读原文件同一口径，取设置里的编辑器文件上限。 */
function resolveReadBudget(maxBytes: number | undefined, fallbackMB: number): number {
	if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) return Math.floor(maxBytes);
	// 设置缺失/损坏时回落到 5MB：预算必须是有限正数，否则定位读会算出 NaN 长度。
	return (Number.isFinite(fallbackMB) && fallbackMB > 0 ? fallbackMB : 5) * 1024 * 1024;
}

/**
 * 按预算定位读文件（不做整文件 readFile）：超过预算只读头部，避免把任意大小的文件
 * 拉进主进程再丢弃。读取失败（含 ENOENT）原样上抛，由调用方决定回退语义。
 */
async function readBounded(
	hostPath: string,
	maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
	const handle = await open(hostPath, "r");
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return { buffer: buffer.subarray(0, bytesRead), truncated: size > maxBytes };
	} finally {
		await handle.close();
	}
}

export function registerFileHandlers(deps: FileHandlerDeps): FileHandlerMaps {
	const { projectStore, fileSystemService, settingsStore, appLogger } = deps;
	const { resolveProject } = createProjectGuard(projectStore);

	// 将 WSL Linux 路径转为 Windows 可访问的路径（/mnt/c → C:\，/home/... → \\wsl$\<distro>\...）
	const toWindowsPath = (linuxPath: string): string => {
		if (!linuxPath || /^[A-Za-z]:/.test(linuxPath)) return linuxPath; // 已是 Windows 路径
		// /mnt/c/Users/... → C:\Users\...
		const mntMatch = linuxPath.match(/^\/mnt\/([a-z])\/(.*)/);
		if (mntMatch) {
			return `${mntMatch[1].toUpperCase()}:\\${mntMatch[2].replace(/\//g, "\\")}`;
		}
		// /home/user/... → \\wsl$\<distro>\home\user\...
		const settings = settingsStore.get();
		if (settings.wslEnabled && settings.wslDistro) {
			return `\\\\wsl$\\${settings.wslDistro}\\${linuxPath.replace(/^\//, "").replace(/\//g, "\\")}`;
		}
		return linuxPath;
	};

	return {
		files: {
			list: async (_event, projectId: string) =>
				fileSystemService.listTree(resolveProject(projectId).path),
			open: async (_event, path: string) => {
				const error = await shell.openPath(toWindowsPath(path));
				// Electron 通过返回字符串报告打开失败；显式抛出后前端才能提示路径不存在或系统无法打开。
				if (error) throw new Error(error);
			},
			showInFolder: async (_event, path: string) => {
				shell.showItemInFolder(toWindowsPath(path));
			},
			readContent: async (_event, path: string, maxBytes?: number) => {
				const budget = resolveReadBudget(maxBytes, settingsStore.get().maxEditorFileSizeMB);
				try {
					const { buffer, truncated } = await readBounded(toWindowsPath(path), budget);
					const content = buffer.toString("utf8");
					// 文本截断回退到最后一个换行：半个多字节字符/半行源码对调用方毫无意义。
					const lastBreak = truncated ? content.lastIndexOf("\n") : -1;
					return { content: lastBreak >= 0 ? content.slice(0, lastBreak + 1) : content, truncated };
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return { content: "", truncated: false };
					}
					throw error;
				}
			},
			readBase64: async (_event, path: string, maxBytes?: number) => {
				const hostPath = toWindowsPath(path);
				const budget = resolveReadBudget(maxBytes, settingsStore.get().maxEditorFileSizeMB);
				const { buffer, truncated } = await readBounded(hostPath, budget);
				const ext = hostPath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
				const mime =
					ext === "jpg" || ext === "jpeg"
						? "image/jpeg"
						: ext === "gif"
							? "image/gif"
							: ext === "webp"
								? "image/webp"
								: ext === "bmp"
									? "image/bmp"
									: "image/png";
				return { content: `data:${mime};base64,${buffer.toString("base64")}`, truncated };
			},
			writeContent: async (_event, path: string, content: string) => {
				await writeFile(path, content, "utf8");
				void appLogger.info("file", "File written", { path, bytes: Buffer.byteLength(content, "utf8") });
			},
			delete: async (_event, path: string, recursive?: boolean) => {
				const targetStat = await stat(path);
				if (targetStat.isDirectory()) {
					await rm(path, { recursive: true, force: true });
				} else {
					await unlink(path);
				}
				void appLogger.info("file", "File deleted", { path, recursive: Boolean(recursive) });
			},
			rename: async (_event, path: string, newName: string) => {
				const newPath = join(dirname(path), newName);
				await rename(path, newPath);
				void appLogger.info("file", "File renamed", { path, newName, result: newPath });
				return newPath;
			},
			create: async (_event, parentDir: string, name: string, type: "file" | "directory") => {
				const fullPath = join(parentDir, name);
				if (type === "directory") {
					await mkdir(fullPath, { recursive: true });
				} else {
					await writeFile(fullPath, "", "utf8");
				}
				void appLogger.info("file", "File/folder created", { parentDir, name, type, result: fullPath });
				return fullPath;
			},
			copy: async (_event, sourcePaths: string[], targetDir: string) => {
				const results: string[] = [];
				for (const src of sourcePaths) {
					try {
						const name = basename(src);
						const dest = join(targetDir, name);
						await cp(src, dest, { recursive: true, errorOnExist: false });
						results.push(dest);
						void appLogger.info("file", "File/folder copied", { src, dest });
					} catch (error) {
						void appLogger.error("file", "File copy failed", { src, targetDir, error });
						throw error;
					}
				}
				return results;
			},
			move: async (_event, sourcePaths: string[], targetDir: string) => {
				const results: string[] = [];
				for (const src of sourcePaths) {
					try {
						const name = basename(src);
						const dest = join(targetDir, name);
						// 先尝试 rename（同设备快），跨设备 fallback 到 cp+rm
						try {
							await rename(src, dest);
						} catch {
							await cp(src, dest, { recursive: true });
							await rm(src, { recursive: true, force: true });
						}
						results.push(dest);
						void appLogger.info("file", "File/folder moved", { src, dest });
					} catch (error) {
						void appLogger.error("file", "File move failed", { src, targetDir, error });
						throw error;
					}
				}
				return results;
			},
		},
	};
}
