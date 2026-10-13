import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * 清理上次异常退出遗留在磁盘上的原子写临时文件（`<目标文件>.<pid>.tmp`，见
 * JsonFileStore.writeAtomic）。
 *
 * 为什么需要：进程在「写 tmp」与「rename 替换」之间被杀（崩溃、强杀、断电）时，
 * tmp 既不会被删也不会被复用（文件名带 pid），会永久留在 userData 里——实测
 * userData 根目录就躺着一个三天前的 `settings.json.22088.tmp`。它不含有效数据，
 * 只是噪音；但会让人误判「上次写入失败了」，也让配置文件目录越积越乱。
 *
 * 边界（避免误删）：
 *   - 只扫传入目录的**顶层文件**，不递归：JsonFileStore 的落地文件都在这一层；
 *   - 只认 `.<数字>.tmp` 后缀，与 JsonFileStore 的命名一一对应；
 *   - 只删年龄超过 minAgeMs 的：正在写的那份 tmp 寿命是毫秒级，留足余量就不会
 *     踩到同进程刚开始、尚未 rename 的写入（同路径写入本身由 JsonFileStore 队列串行）；
 *   - 调用方只传本应用的 userData，不要扫 pi 自己的配置目录——那里的 tmp 可能属于 pi CLI。
 */
export type StaleTempFile = { path: string; ageMs: number };

/** 默认最小残留年龄：远大于单次原子写的耗时，留出充足余量。 */
export const STALE_TEMP_FILE_MIN_AGE_MS = 5 * 60 * 1000;

/** JsonFileStore 的临时文件名：`${目标路径}.${process.pid}.tmp`。 */
const STALE_TEMP_FILE_PATTERN = /\.\d+\.tmp$/;

/**
 * 删除目录顶层所有「已陈旧」的原子写临时文件，返回被删清单（含年龄，供日志与验证）。
 * 目录不存在、单个文件无权删除等情形都按「无可清理」处理——启动清理不该成为失败点。
 */
export async function cleanupStaleTempFiles(
	dir: string,
	options: { minAgeMs?: number } = {},
): Promise<StaleTempFile[]> {
	const minAgeMs = options.minAgeMs ?? STALE_TEMP_FILE_MIN_AGE_MS;
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		// 首次启动目录尚未创建，或路径不可读：没有可清理的东西。
		return [];
	}

	const now = Date.now();
	const removed: StaleTempFile[] = [];
	for (const entry of entries) {
		if (!STALE_TEMP_FILE_PATTERN.test(entry)) continue;
		const filePath = join(dir, entry);
		try {
			const info = await stat(filePath);
			if (!info.isFile()) continue;
			const ageMs = now - info.mtimeMs;
			if (ageMs < minAgeMs) continue;
			await unlink(filePath);
			removed.push({ path: filePath, ageMs });
		} catch {
			// 与其它实例/清理任务竞争或权限不足：跳过这一个，继续处理其余文件。
		}
	}
	return removed;
}
