/**
 * File IPC handler：文件树浏览/读写/创建/删除/重命名/复制/移动 + 在资源管理器中打开。
 * WSL 模式下通过 `toWindowsPath` 将 Linux 路径转为 Windows 可访问路径。
 * `browserOpenExternal` 物理位于此块，使用 shell.openExternal 打开系统浏览器。
 */
import { shell } from "electron";
import { basename, join } from "node:path";
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { ipcTable, type IpcHandlerMap } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type { AppSettings } from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";
import type { FileSystemService } from "../fs/FileSystemService";
import type { AppLogger } from "../logging/AppLogger";

interface FileHandlerDeps {
	projectStore: ProjectStore;
	fileSystemService: FileSystemService;
	settingsStore: { get(): AppSettings };
	appLogger: AppLogger;
}

type FileHandlerMaps = {
	files: IpcHandlerMap<typeof ipcTable.files, PiDesktopApi["files"]>;
	browser: IpcHandlerMap<typeof ipcTable.browser, PiDesktopApi["browser"]>;
};

export function registerFileHandlers(deps: FileHandlerDeps): FileHandlerMaps {
	const { projectStore, fileSystemService, settingsStore, appLogger } = deps;

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
			list: async (_event, projectId: string) => {
				const project = projectStore.get(projectId);
				if (!project) throw new Error(`Project not found: ${projectId}`);
				return fileSystemService.listTree(project.path);
			},
			open: async (_event, path: string) => {
				const error = await shell.openPath(toWindowsPath(path));
				// Electron 通过返回字符串报告打开失败；显式抛出后前端才能提示路径不存在或系统无法打开。
				if (error) throw new Error(error);
			},
			showInFolder: async (_event, path: string) => {
				shell.showItemInFolder(toWindowsPath(path));
			},
			readContent: async (_event, path: string) => {
				try {
					return await readFile(toWindowsPath(path), "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return "";
					}
					throw error;
				}
			},
			readBase64: async (_event, path: string) => {
				const hostPath = toWindowsPath(path);
				const buf = await readFile(hostPath);
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
				return `data:${mime};base64,${buf.toString("base64")}`;
			},
			writeContent: async (_event, path: string, content: string) => {
				await writeFile(path, content, "utf8");
				void appLogger.info("file", "File written", { path, bytes: Buffer.byteLength(content, "utf8") });
			},
			delete: async (_event, path: string, recursive?: boolean) => {
				await fileSystemService.delete(path, recursive);
				void appLogger.info("file", "File deleted", { path, recursive: Boolean(recursive) });
			},
			rename: async (_event, path: string, newName: string) => {
				const result = await fileSystemService.rename(path, newName);
				void appLogger.info("file", "File renamed", { path, newName, result });
				return result;
			},
			create: async (_event, parentDir: string, name: string, type: "file" | "directory") => {
				const result = await fileSystemService.create(parentDir, name, type);
				void appLogger.info("file", "File/folder created", { parentDir, name, type, result });
				return result;
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
		browser: {
			openExternal: async (_event, url: string) => {
				// shell.openExternal 使用系统默认浏览器打开链接，可控且安全。
				await shell.openExternal(url);
			},
		},
	};
}
