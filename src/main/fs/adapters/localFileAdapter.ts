import { copyFile, readFile, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FileAdapter, FileVersion } from "./fileAdapter";

/**
 * 本地文件系统实现。包装 node:fs/promises。
 * readHead 用 readFile + slice（本地读取头部与全量同成本，直接截断）。
 */
export class LocalFileAdapter implements FileAdapter {
	async read(path: string, signal?: AbortSignal): Promise<string> {
		return readFile(path, { encoding: "utf8", signal });
	}

	async readHead(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
		const raw = await readFile(path, { encoding: "utf8", signal });
		return raw.slice(0, maxBytes);
	}

	async write(path: string, content: string): Promise<void> {
		await writeFile(path, content, "utf8");
	}

	async stat(path: string): Promise<FileVersion> {
		const info = await stat(path);
		return { mtimeMs: info.mtimeMs, size: info.size };
	}

	async exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}

	async existsDir(path: string): Promise<boolean> {
		try {
			const info = await stat(path);
			return info.isDirectory();
		} catch {
			return false;
		}
	}

	async rm(path: string): Promise<void> {
		await unlink(path);
	}

	async rmDir(path: string): Promise<void> {
		// 先走 fs.rm 快速路径（Linux/macOS 及大多数 Windows 环境直接生效）。
		// maxRetries 应对 Windows 文件句柄延迟释放导致的偶发 EBUSY/EPERM。
		await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
		// Windows 上 fs.rm(recursive) 存在已知缺陷：文件被标记删除后目录列表可能
		// 延迟更新，rm 误判成功但目录实际仍在。兜底验证后回退到分步删除。
		if (await this.existsDir(path)) {
			await this.removeTree(path);
		}
	}

	/**
	 * 分步递归删除目录树：先逐个 unlink 文件，再 rmdir 空目录。
	 * 作为 fs.rm 在 Windows 静默失败时的可靠回退——诊断证实 unlink+rmdir
	 * 在 Windows 上不受 fs.rm 的目录列表延迟更新问题影响。
	 */
	private async removeTree(path: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch {
			return; // 目录已不存在
		}
		for (const entry of entries) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				await this.removeTree(child);
			} else {
				await unlink(child).catch(() => {});
			}
		}
		await rmdir(path).catch(() => {});
	}

	async copy(src: string, dst: string): Promise<void> {
		await copyFile(src, dst);
	}

	async collectJsonl(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...(await this.collectJsonl(path)));
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(path);
			}
		}
		return files;
	}
}
