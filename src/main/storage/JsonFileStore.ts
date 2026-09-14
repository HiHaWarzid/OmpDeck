/**
 * JsonFileStore —— 配置文件的原子、串行、可失效读写深模块。
 *
 * 背景：各 store（settings/trust/config/projects/afk/roles）此前各自「就地 writeFile」，
 * 集中暴露三类缺陷：
 * 1. 写到一半进程退出/磁盘写失败 → 目标文件只剩半个 JSON（部分解析器直接报错）；
 * 2. 多处 fire-and-forget 的 read-modify-write 交错 → 后写者用旧快照覆盖前写者的键；
 * 3. 读一次后永不重读 → 外部改动（用户手改/config 包导入）在重启前不可见。
 *
 * 本模块统一承担：
 * - 原子写：同目录 tmp 完整写出后才 rename 替换（复用 utils/fsRetry 的瞬态锁退避重试），
 *   失败时目标文件保持上一次的完整内容，绝不出现截断的半个 JSON；
 * - 按路径串行：同一文件路径的 write/update 排队执行，update 的 read→mutate→write
 *   不会与另一个 update 交错（杜绝丢键）；
 * - 指纹缓存：(mtimeMs,size) 变化即重读重解析，外部改动对同进程可见。
 *
 * sessionSummaryCache 是仓库里既有的正确实现（tmp+rename），本模块把同一策略推广到
 * 全部配置文件读写，并补上「按路径串行」与「读指纹」两项它不需要的能力。
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renameWithRetry } from "../utils/fsRetry";

/** 文件版本指纹：外部改动（含 mtime 或 size 变化）都会使缓存失效。 */
export interface FileFingerprint {
	mtimeMs: number;
	size: number;
}

/**
 * fs 端口：默认实现是 node:fs/promises + renameWithRetry。
 * 抽成端口是为了让「写 tmp 中途失败/rename 前失败」这类在真实磁盘上难以稳定复现的
 * 场景可注入验证（原子性回归测试）。
 */
export interface JsonFileStoreIo {
	readText: (filePath: string) => Promise<string>;
	writeText: (filePath: string, text: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	fingerprint: (filePath: string) => Promise<FileFingerprint>;
	ensureDir: (dirPath: string) => Promise<void>;
}

export interface JsonFileStoreOptions<T> {
	/** 反序列化；抛错表示内容损坏（read 回落 fallback，update 拒绝静默覆盖）。 */
	deserialize?: (raw: string) => T;
	/** 序列化；缺省 JSON.stringify(value, null, 2)，与仓库既有落盘格式逐字节一致。 */
	serialize?: (value: T) => string;
	/** fs 端口覆盖（测试注入失败写入器）。 */
	io?: Partial<JsonFileStoreIo>;
}

const defaultIo: JsonFileStoreIo = {
	readText: (filePath) => readFile(filePath, "utf8"),
	writeText: (filePath, text) => writeFile(filePath, text, "utf8"),
	rename: renameWithRetry,
	fingerprint: async (filePath) => {
		const info = await stat(filePath);
		return { mtimeMs: info.mtimeMs, size: info.size };
	},
	ensureDir: async (dirPath) => {
		await mkdir(dirPath, { recursive: true });
	},
};

interface CacheEntry<T> {
	fingerprint: FileFingerprint;
	value: T;
	raw: string;
}

function isNotFound(error: unknown): boolean {
	// 具名收窄错误码，避免内联断言访问对象成员
	if (error && typeof error === "object" && "code" in error) {
		return error.code === "ENOENT";
	}
	return false;
}

/**
 * 按文件路径串行队列（模块级：不同 store 实例指向同一文件时也必须排队）。
 * 前序任务失败不阻塞后续；队列尾只在仍是当前尾时清理，避免 Map 常驻。
 */
const pathQueues = new Map<string, Promise<void>>();

function enqueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
	const key = resolve(filePath);
	const previous = pathQueues.get(key) ?? Promise.resolve();
	const run = previous.then(task, task);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	pathQueues.set(key, tail);
	void tail.then(() => {
		if (pathQueues.get(key) === tail) pathQueues.delete(key);
	});
	return run;
}

export class JsonFileStore<T> {
	private readonly filePath: string;
	private readonly io: JsonFileStoreIo;
	private readonly deserialize: (raw: string) => T;
	private readonly serialize: (value: T) => string;
	private cache: CacheEntry<T> | null = null;

	constructor(filePath: string, options: JsonFileStoreOptions<T> = {}) {
		this.filePath = filePath;
		this.io = { ...defaultIo, ...options.io };
		this.deserialize = options.deserialize ?? ((raw) => JSON.parse(raw) as T);
		this.serialize = options.serialize ?? ((value) => JSON.stringify(value, null, 2));
	}

	/**
	 * 原文读写 store（序列化/反序列化均为恒等）：供内容不是 JSON、或需要保留原文
	 * 自行解析的场景（config.yml 的 YAML、trust.json 的原文 + 形状校验）。
	 */
	static text(filePath: string): JsonFileStore<string> {
		return new JsonFileStore<string>(filePath, {
			serialize: (text) => text,
			deserialize: (raw) => raw,
		});
	}

	/**
	 * 读取解析后的值。文件缺失、不可读或内容损坏时回落 fallback
	 * （与各 store 原「catch → 默认值」的语义一致）。
	 */
	async read(fallback: T): Promise<T> {
		try {
			const loaded = await this.load();
			return loaded ? loaded.value : fallback;
		} catch {
			return fallback;
		}
	}

	/**
	 * 读取原文。文件缺失返回 null；不可读/内容损坏抛出，由调用方区分
	 * 「不存在（可安全写）」与「损坏（不冒险覆盖）」。
	 */
	async readRaw(): Promise<string | null> {
		const loaded = await this.load();
		return loaded ? loaded.raw : null;
	}

	/**
	 * 原子写：同目录 tmp 完整写出后才 rename 替换。
	 * 写 tmp 或 rename 失败时目标文件保持上一次的完整内容（绝不出现半个 JSON）。
	 */
	async write(value: T): Promise<void> {
		await enqueue(this.filePath, () => this.writeNow(value));
	}

	/**
	 * 串行 read-modify-write：mutate 在队列内基于最新内容执行，两个并发 update
	 * 不会互相覆盖（就地 read-modify-write 会丢键）。
	 * current = undefined 表示文件当前缺失（基线形状由 mutate 决定）；
	 * 内容损坏时读取抛错，避免把损坏文件静默覆盖成空基线。
	 */
	async update(mutate: (current: T | undefined) => T | Promise<T>): Promise<void> {
		await enqueue(this.filePath, async () => {
			const loaded = await this.load();
			const next = await mutate(loaded ? loaded.value : undefined);
			await this.writeNow(next);
		});
	}

	private async load(): Promise<{ value: T; raw: string } | null> {
		let fingerprint: FileFingerprint;
		try {
			fingerprint = await this.io.fingerprint(this.filePath);
		} catch (error) {
			if (isNotFound(error)) {
				// 文件不存在（含外部删除）：清缓存并按缺失处理
				this.cache = null;
				return null;
			}
			throw error;
		}
		if (
			this.cache &&
			this.cache.fingerprint.mtimeMs === fingerprint.mtimeMs &&
			this.cache.fingerprint.size === fingerprint.size
		) {
			return { value: this.cache.value, raw: this.cache.raw };
		}
		// 指纹先取后读：读的过程中若发生外部改动，下一次读取指纹不符会重读，
		// 不会把新内容缓存成旧指纹。
		const raw = await this.io.readText(this.filePath);
		const value = this.deserialize(raw);
		this.cache = { fingerprint, value, raw };
		return { value, raw };
	}

	private async writeNow(value: T): Promise<void> {
		const text = this.serialize(value);
		await this.io.ensureDir(dirname(this.filePath));
		// pid 后缀与 sessionSummaryCache 一致：同路径写入已由队列串行，跨进程同名时
		// rename 仍是原子替换，不会写出半个文件。
		const tmpPath = `${this.filePath}.${process.pid}.tmp`;
		await this.io.writeText(tmpPath, text);
		await this.io.rename(tmpPath, this.filePath);
		await this.refreshCache(value, text);
	}

	/** 写后刷新缓存：由本次写入的完整内容与新指纹取代旧缓存。 */
	private async refreshCache(value: T, text: string): Promise<void> {
		try {
			const fingerprint = await this.io.fingerprint(this.filePath);
			this.cache = { fingerprint, value, raw: text };
		} catch {
			// 写后 stat 失败（极少）：保守失效，下次 read 直接重读磁盘
			this.cache = null;
		}
	}
}
