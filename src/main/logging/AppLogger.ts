import { app, shell } from "electron";
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppLogEntry, AppLogLevel, AppLogQuery } from "../../shared/types";

const MAX_LOG_FILES = 14;
const MAX_READ_LINES = 5000;
/** 旧日志清理间隔：目录 readdir 不必每条日志都做，5 分钟一次足够回收过期文件。 */
const CLEANUP_INTERVAL_MS = 5 * 60_000;

function formatDate(value: Date) {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function normalizeDetail(detail: unknown) {
	if (detail instanceof Error) {
		return { name: detail.name, message: detail.message, stack: detail.stack };
	}
	return detail;
}

/**
 * 主进程应用日志服务。
 * 日志按天写入 userData/logs,既避免 renderer 崩溃丢失关键诊断信息,
 * 也避免记录到项目目录导致用户代码仓库被污染。
 */
export class AppLogger {
	private readonly dir = join(app.getPath("userData"), "logs");
	private writeQueue: Promise<void> = Promise.resolve();
	/** 当日日志文件路径缓存：按日期失效，避免每条日志都格式化日期 + join。 */
	private cachedDay: { date: string; filePath: string } | null = null;
	/** 已创建目录对应的日期；跨日才重新 mkdir。 */
	private ensuredDay: string | null = null;
	/** 上次清理旧文件的时间；undefined 表示本进程尚未清理（首次写入即清理）。 */
	private lastCleanupAt: number | undefined;

	log(level: AppLogLevel, scope: string, message: string, detail?: unknown) {
		const entry: AppLogEntry = {
			id: crypto.randomUUID(),
			time: Date.now(),
			level,
			scope,
			message,
			detail: normalizeDetail(detail),
		};
		// 串行写入队列，fire-and-forget，绝不 await 阻塞调用方
		this.writeQueue = this.writeQueue
			.then(() => this.writeEntry(entry))
			.catch((error) => {
				console.warn("Failed to write app log:", error);
			});
		return this.writeQueue;
	}

	debug(scope: string, message: string, detail?: unknown) {
		return this.log("debug", scope, message, detail);
	}

	info(scope: string, message: string, detail?: unknown) {
		return this.log("info", scope, message, detail);
	}

	warn(scope: string, message: string, detail?: unknown) {
		return this.log("warn", scope, message, detail);
	}

	error(scope: string, message: string, detail?: unknown) {
		return this.log("error", scope, message, detail);
	}

	async list(query: AppLogQuery = {}): Promise<AppLogEntry[]> {
		await mkdir(this.dir, { recursive: true });
		const files = (await readdir(this.dir))
			.filter((file) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(file))
			.sort()
			.slice(-MAX_LOG_FILES);
		const lines: string[] = [];
		for (const file of files) {
			const raw = await readFile(join(this.dir, file), "utf8").catch(() => "");
			lines.push(...raw.split(/\r?\n/).filter(Boolean));
		}

		const search = query.search?.trim().toLowerCase();
		const limit = Math.max(1, Math.min(query.limit ?? 500, 2000));
		return lines
			.slice(-MAX_READ_LINES)
			.map((line) => {
				try {
					return JSON.parse(line) as AppLogEntry;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is AppLogEntry => Boolean(entry))
			.filter((entry) => !query.from || entry.time >= query.from!)
			.filter((entry) => !query.to || entry.time <= query.to!)
			.filter((entry) => !query.level || query.level === "all" || entry.level === query.level)
			.filter((entry) => {
				if (!search) return true;
				const haystack = `${entry.level} ${entry.scope} ${entry.message} ${JSON.stringify(entry.detail ?? "")}`.toLowerCase();
				return haystack.includes(search);
			})
			.slice(-limit)
			.reverse();
	}

	async clear() {
		await mkdir(this.dir, { recursive: true });
		const files = await readdir(this.dir);
		await Promise.all(
			files
				.filter((file) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(file))
				.map((file) => unlink(join(this.dir, file)).catch(() => undefined)),
		);
		await this.info("logs", "Logs cleared");
	}

	/** 计算所有应用日志文件的总字节数 */
	async getSize(): Promise<number> {
		await mkdir(this.dir, { recursive: true });
		const files = (await readdir(this.dir))
			.filter((file) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(file));
		let total = 0;
		for (const file of files) {
			try { total += (await stat(join(this.dir, file))).size; } catch { /* 单个文件统计失败不影响整体 */ }
		}
		return total;
	}

	async openFolder() {
		await mkdir(this.dir, { recursive: true });
		await shell.openPath(this.dir);
	}

	private async writeEntry(entry: AppLogEntry) {
		const { date, filePath } = this.resolveDayFile(entry.time);
		// mkdir 每进程每天只做一次：日志写入是热路径，不能每条都发起目录 syscall。
		if (this.ensuredDay !== date) {
			await mkdir(this.dir, { recursive: true });
			this.ensuredDay = date;
		}
		this.scheduleCleanupIfDue();
		await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
	}

	/** 解析（并缓存）某时刻对应的日志文件；日期变化时自动失效。 */
	private resolveDayFile(time: number): { date: string; filePath: string } {
		const date = formatDate(new Date(time));
		const cached = this.cachedDay;
		if (cached && cached.date === date) return cached;
		const filePath = join(this.dir, `app-${date}.log`);
		this.cachedDay = { date, filePath };
		return this.cachedDay;
	}

	/**
	 * 旧文件清理节流：首次写入（进程启动）触发一次，之后最多每 5 分钟一次。
	 * 清理异步执行、失败静默：日志本身不能因目录整理失败而丢失。
	 */
	private scheduleCleanupIfDue(): void {
		const now = Date.now();
		if (this.lastCleanupAt !== undefined && now - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
		this.lastCleanupAt = now;
		void this.cleanupOldFiles().catch(() => undefined);
	}

	private async cleanupOldFiles() {
		const files = (await readdir(this.dir).catch(() => []))
			.filter((file) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(file))
			.sort();
		const expired = files.slice(0, Math.max(0, files.length - MAX_LOG_FILES));
		await Promise.all(expired.map((file) => unlink(join(this.dir, file)).catch(() => undefined)));
	}
}
