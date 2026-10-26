/**
 * 会话图片 blob 解析 —— omp 持久化会话时把图片内容块外置为 `blob:sha256:<hash>`，
 * 只有运行时加载会话才会从 blob store 还原成 base64。
 *
 * 桌面端有两条路径直接读 JSONL 而不经过 omp（大会话 get_messages 兜底、Viewer），
 * 拿到的就是 blob 引用串；渲染层只认 `data:<mime>;base64,...`，
 * 不还原会得到无法解码的图片。这里按 blob store 目录就地还原。
 *
 * 压缩归档只是一张纯文本卡片（DiagnosticCards 的 ArchivedMessage），不还原：
 * 解码只会多出同步读盘和 IPC 体积，渲染端没有消费点。
 *
 * blob store 是全局去重目录（不属于单个会话）：`<agent dir>/blobs/<sha256>`。
 * WSL 模式下 `<agent dir>` 由调用方换算成 host 可读路径（`\\wsl$...`）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonRecord } from "../sessions/sessionEntries";

const BLOB_PREFIX = "blob:sha256:";
const BLOB_HASH_RE = /^[0-9a-f]{64}$/;

/** 是否 omp blob 引用（而不是 base64 数据）。 */
export function isBlobImageRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

/**
 * 就地还原 message.content 里的 blob 图片引用。
 * 读取失败（blob 被清理、WSL 不可达）时保留原引用：extractToolResultImages 会把它过滤掉，
 * 时间线退化为「只有文本」，不会渲染半张坏图。
 */
export function resolveBlobImagesInMessages(
	messages: unknown[],
	blobsDir: string | null,
): void {
	if (!blobsDir) return;
	const cache = new Map<string, string | null>();
	for (const message of messages) {
		if (!isJsonRecord(message)) continue;
		resolveContentBlobs(message.content, blobsDir, cache);
	}
}

/** 单次解析共享同一条消息列表的 blob 缓存，避免同一张图片在多条消息里重复读盘。 */
function resolveContentBlobs(
	content: unknown,
	blobsDir: string,
	cache: Map<string, string | null>,
): void {
	if (!Array.isArray(content)) return;
	for (const item of content) {
		if (!isJsonRecord(item)) continue;
		if (item.type !== "image" || typeof item.data !== "string") continue;
		if (!isBlobImageRef(item.data)) continue;
		let base64 = cache.get(item.data);
		if (base64 === undefined) {
			base64 = readBlobBase64(item.data, blobsDir);
			cache.set(item.data, base64);
		}
		if (base64) item.data = base64;
	}
}

/** 按引用串读取 blob 文件并编码为 base64；非法 hash / 缺失文件返回 null。 */
function readBlobBase64(ref: string, blobsDir: string): string | null {
	const hash = ref.slice(BLOB_PREFIX.length);
	if (!BLOB_HASH_RE.test(hash)) return null;
	try {
		return readFileSync(join(blobsDir, hash)).toString("base64");
	} catch {
		return null;
	}
}
