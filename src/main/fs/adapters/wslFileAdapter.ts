import { execFile } from "node:child_process";

import type { FileAdapter, FileVersion } from "./fileAdapter";

/**
 * WSL 文件系统实现。通过 wsl.exe 在 Linux 侧执行文件操作。
 *
 * 构造参数由调用方（SessionScanner.resolveWslExe + wslConfig）解析注入，
 * adapter 自身不探测环境，保证可测试（注入 mock execFile 验证参数拼装）。
 *
 * 超时策略（沿用 SessionScanner 原值）：
 *   - read/write: 10s
 *   - head/stat/exists/rm/copy/existsDir/rmDir: 5s
 *   - collectJsonl: 15s
 */

export type WslFileAdapterOptions = {
	distro: string;
	user: string;
	wslExePath: string;
	wslShell: boolean;
	/** 测试注入点：默认 execFile，测试传 mock 验证参数拼装 */
	execFileImpl?: typeof execFile;
};

export class WslFileAdapter implements FileAdapter {
	private readonly distro: string;
	private readonly user: string;
	private readonly wslExePath: string;
	private readonly wslShell: boolean;
	private readonly exec: typeof execFile;

	constructor(options: WslFileAdapterOptions) {
		this.distro = options.distro;
		this.user = options.user;
		this.wslExePath = options.wslExePath;
		this.wslShell = options.wslShell;
		this.exec = options.execFileImpl ?? execFile;
	}

	/** 基础 wsl.exe 前缀：-d <distro> -u <user> */
	private baseArgs(command: string): string[] {
		return ["-d", this.distro, "-u", this.user, command];
	}

	private run(
		args: string[],
		options: { timeout: number; signal?: AbortSignal },
	): Promise<{ stdout: string; stdin?: never }> {
		return new Promise((resolve, reject) => {
			this.exec(this.wslExePath, args, {
				shell: this.wslShell,
				encoding: "utf8",
				timeout: options.timeout,
				signal: options.signal,
				windowsHide: true,
			}, (err, stdout) => {
				if (err) reject(err);
				else resolve({ stdout });
			});
		});
	}

	async read(path: string, signal?: AbortSignal): Promise<string> {
		const { stdout } = await this.run([...this.baseArgs("cat"), path], {
			timeout: 10_000,
			signal,
		});
		return stdout;
	}

	async readHead(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
		const { stdout } = await this.run(
			[...this.baseArgs("head"), "-c", String(maxBytes), "--", path],
			{ timeout: 5_000, signal },
		);
		return stdout;
	}

	async write(path: string, content: string): Promise<void> {
		// 使用 tee 写入，避免 heredoc 中的特殊字符问题
		await new Promise<void>((resolve, reject) => {
			const proc = this.exec(
				this.wslExePath,
				[...this.baseArgs("tee"), path],
				{ encoding: "utf8", timeout: 10_000, windowsHide: true },
				(err) => (err ? reject(err) : resolve()),
			);
			if (proc.stdin) {
				proc.stdin.end(content);
			}
		});
	}

	async stat(path: string, signal?: AbortSignal): Promise<FileVersion> {
		const { stdout } = await this.run(
			[...this.baseArgs("stat"), "-c", "%Y %s", path],
			{ timeout: 5_000, signal },
		);
		const [mtimeSeconds, size] = stdout.trim().split(/\s+/).map(Number);
		return { mtimeMs: mtimeSeconds * 1000, size };
	}

	async exists(path: string, signal?: AbortSignal): Promise<boolean> {
		try {
			await this.run([...this.baseArgs("test"), "-f", path], {
				timeout: 5_000,
				signal,
			});
			return true;
		} catch {
			return false;
		}
	}

	async existsDir(path: string): Promise<boolean> {
		try {
			await this.run([...this.baseArgs("test"), "-d", path], { timeout: 5_000 });
			return true;
		} catch {
			return false;
		}
	}

	async rm(path: string): Promise<void> {
		await this.run([...this.baseArgs("rm"), path], { timeout: 5_000 });
	}

	async rmDir(path: string): Promise<void> {
		// 静默：失败不阻塞调用方（与 SessionScanner 原 deleteWslSiblingDir 一致）
		await this.run([...this.baseArgs("rm"), "-rf", path], { timeout: 10_000 }).catch(() => {});
	}

	async copy(src: string, dst: string): Promise<void> {
		await this.run([...this.baseArgs("cp"), src, dst], { timeout: 5_000 });
	}

	async collectJsonl(dir: string, signal?: AbortSignal): Promise<string[]> {
		const { stdout } = await this.run(
			[...this.baseArgs("find"), dir, "-name", "*.jsonl", "-type", "f"],
			{ timeout: 15_000, signal },
		);
		return stdout.trim().split(/\r?\n/).filter(Boolean);
	}
}
