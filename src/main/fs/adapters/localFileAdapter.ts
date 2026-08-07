import { copyFile, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
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
		await rm(path, { recursive: true, force: true });
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
