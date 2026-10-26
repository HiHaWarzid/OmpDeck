/**
 * 消息文本工具 -- 从 pi 原始消息中提取/格式化文本的通用函数。
 *
 * 从 messageTimeline 提取的纯函数模块，无业务语义，可被任何需要处理 pi 消息文本的模块复用：
 *   - safeJson: 安全序列化（处理循环引用）
 *   - stripAnsi: 清理 ANSI 转义码（模型思考内容常见终端颜色序列）
 *   - extractImages: 从 content 数组提取图片附件
 *   - extractThinking: 从 content 数组提取 thinking 块文本（自动 stripAnsi）
 *   - truncateForDetail: 超长文本首尾截断（保留头部和尾部以兼顾开头信息和错误堆栈）
 *   - extractToolResultText: 从 toolResult.content 提取文本
 *   - estimateMessageBytes: 估算单条消息过 IPC / 驻留的体积（容量预算的度量口径）
 */

import type { ChatMessage, ImageContent } from "../../shared/types";
import { isBlobImageRef } from "./sessionBlobs";

/** 工具结果文本截断阈值（字符数）；超出时 meta 标记 truncated 并缓存全文供「查看完整输出」。 */
export const MAX_TOOL_RESULT_CHARS = 8000;

/** 安全序列化任意值为 JSON 字符串，处理循环引用等异常。 */
export function safeJson(value: unknown): string {
	try {
		const serialized = JSON.stringify(value, null, 2);
		// JSON.stringify(undefined/function/symbol) 返回 undefined 而非字符串，
		// 违反 ": string" 契约；调用方会直接对其 .length / 拼接，必须归一为 ""。
		return serialized === undefined ? "" : serialized;
	} catch {
		return String(value);
	}
}

/** 清理 ANSI 转义码（模型思考内容中常见终端颜色序列）。 */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** 工具结果单次保留的图片上限：截图/读图类工具一次通常 1~3 张，超出部分只留文本。 */
export const MAX_TOOL_RESULT_IMAGES = 8;
/** 单张图片的 base64 上限（约 3MB 原图），防止一张超大图把 IPC 撑爆。 */
export const MAX_TOOL_IMAGE_BASE64_CHARS = 4 * 1024 * 1024;
/**
 * 单条工具消息的图片总量上限（base64 字符）。
 *
 * 时间线总预算是 8MB（`MAX_TRANSCRIPT_BYTES`），裁剪只从头部裁、尾部消息始终保留，
 * 所以单条消息必须自己设上限：否则 8 张 4MB 的图片能到 32MB，把整段历史挤出预算且
 * 仍原样过 IPC。4MB 约为预算的一半，同时容得下多张普通截图（单张约 50~200KB）。
 */
export const MAX_TOOL_IMAGES_TOTAL_BASE64_CHARS = 4 * 1024 * 1024;

/**
 * 从工具结果 content 中提取可直接渲染的图片块。
 *
 * 与 extractImages 的差异：
 *   - `blob:sha256:` 引用串不是图片数据，渲染层无法解码，直接丢弃；
 *     历史读取路径会先用 sessionBlobs 还原，还原失败时这里退化为无图而非坏图。
 *   - 条数、单张体积、总量都设上限：工具结果图片会随消息一起过 IPC 并计入时间线预算。
 *     超限时按原顺序保留前面的图片，后面的只留文本。
 */
export function extractToolResultImages(content: unknown): ImageContent[] {
	const images: ImageContent[] = [];
	let totalChars = 0;
	for (const image of extractImages(content)) {
		if (images.length >= MAX_TOOL_RESULT_IMAGES) break;
		if (isBlobImageRef(image.data)) continue;
		if (image.data.length > MAX_TOOL_IMAGE_BASE64_CHARS) continue;
		if (totalChars + image.data.length > MAX_TOOL_IMAGES_TOTAL_BASE64_CHARS) break;
		images.push(image);
		totalChars += image.data.length;
	}
	return images;
}

/** 从 pi 历史消息 content 中恢复图片附件，用于历史会话重新打开后的图片展示。 */
export function extractImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap<ImageContent>((item) => {
		if (!item || typeof item !== "object") return [];
		const typed = item as Record<string, unknown>;
		if (typed.type !== "image") return [];
		const data = typeof typed.data === "string" ? typed.data : "";
		const mimeType =
			typeof typed.mimeType === "string"
				? typed.mimeType
				: typeof typed.mime_type === "string"
					? typed.mime_type
					: "image/png";
		return data ? [{ type: "image", data, mimeType }] : [];
	});
}

/**
 * 从历史消息 content 数组中提取 thinking 内容块的文本。
 * 自动清理 ANSI 转义码。
 */
export function extractThinking(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const raw = content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const typed = item as Record<string, unknown>;
			if (typed.type !== "thinking") return "";
			return String(typed.thinking ?? typed.text ?? "");
		})
		.filter(Boolean)
		.join("\n");
	return stripAnsi(raw);
}

/** 对超长工具文本做首尾截断，保留头部和尾部以兼顾开头信息和错误堆栈。 */
export function truncateForDetail(text: unknown): string {
	const str = typeof text === "string" ? text : text == null ? "" : String(text);
	if (str.length <= MAX_TOOL_RESULT_CHARS) return str;
	const keep = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
	const omitted = str.length - keep * 2;
	return (
		`${str.slice(0, keep)}\n` +
		`…（已省略中间 ${omitted} 字符，完整内容共 ${str.length} 字符）\n` +
		str.slice(-keep)
	);
}

/** 从 toolResult.content（数组形式）中提取文本，拼接为单个字符串。 */
export function extractToolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as Record<string, unknown>).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (typeof (item as Record<string, unknown>)?.text === "string" ? (item as Record<string, unknown>).text as string : ""))
		.filter(Boolean)
		.join("\n");
}

/** meta 中被截断过的长文本字段：按字符串长度累加即可（不走序列化）。 */
export const TEXTUAL_META_BYTES_KEYS = ["detailText", "result", "args"] as const;
/** meta 中未截断的嵌套结构：值本身可能很大，只能在存在时序列化估算（绝大多数消息没有）。 */
export const NESTED_META_BYTES_KEYS = ["details", "archivedMessages", "_askCard"] as const;

/**
 * 紧凑序列化的字符数（估算专用）。
 *
 * 只求量级，不构造 pretty 字符串：safeJson 走 `null, 2`（给 UI 展示用），
 * 拿它估算同一份 details 会把口径放大 20% 以上，还白分配一份大字符串。
 * 预算度量的是跨进程结构化克隆的对象体积，紧凑形式更贴近。
 */
export function compactJsonLength(value: unknown): number {
	try {
		const serialized = JSON.stringify(value);
		// JSON.stringify(undefined/function/symbol) 返回 undefined，归一为 0 长度。
		return serialized === undefined ? 0 : serialized.length;
	} catch {
		return String(value).length;
	}
}

/**
 * 嵌套 meta 序列化长度缓存（WeakMap 以 meta 对象为键，每个 meta 最多 3 条）。
 *
 * 为什么需要：details / archivedMessages / _askCard 未截断，可能是 MB 级结构；
 * getMessages 在渲染层流式推送、Web 轮询与 transcript 预算校验中反复估算同一条
 * 消息，每次都 JSON.stringify 这些嵌套结构是纯重复 CPU。meta 在消息更新时整体
 * 替换、普通消息的 meta 更是终生不变，因此按对象身份缓存测得长度即可。
 *
 * 条目里同时记录嵌套值的引用：同一个 meta 对象上的嵌套值若被就地替换（引用不再
 * 相等），就重算，保证返回值与不走缓存的路径完全一致。
 * 只缓存嵌套结构长度，不缓存消息总字节 —— text/thinking 是流式增长的，必须按当前值重算。
 */
const nestedMetaLengthCache = new WeakMap<
	object,
	Map<string, { value: unknown; length: number }>
>();

function memoizedNestedMetaLength(meta: object, key: string, value: unknown): number {
	let perMeta = nestedMetaLengthCache.get(meta);
	if (!perMeta) {
		perMeta = new Map();
		nestedMetaLengthCache.set(meta, perMeta);
	}
	const cached = perMeta.get(key);
	if (cached && cached.value === value) return cached.length;
	const length = compactJsonLength(value);
	perMeta.set(key, { value, length });
	return length;
}

/**
 * 估算单条消息的驻留 / IPC 体积（字节），作为 transcript 容量预算的度量口径。
 *
 * 只求量级正确：文本按 UTF-16（2 字节/字符）计，图片按 base64 串长计，另加固定开销。
 * 精确测量要先拼出整份 JSON——那正是容量保护要避免的成本。
 * 必须计入 meta：detailText / result / args 每条最多 8K 字符，工具卡详情与压缩归档
 * （details / archivedMessages）未截断。旧实现只算 text/thinking/images，于是
 * 「几十条工具卡详情 + 归档」的会话对预算完全不可见，5MB 快照上限形同虚设。
 */
export function estimateMessageBytes(message: ChatMessage): number {
	let bytes = 256 + message.text.length * 2 + (message.thinking?.length ?? 0) * 2;
	for (const image of message.images ?? []) bytes += image.data.length;
	const meta = message.meta;
	if (!meta) return bytes;
	// 已被 truncateForDetail 截断的字段直接按长度累加，不触发序列化。
	for (const key of TEXTUAL_META_BYTES_KEYS) {
		const value = meta[key];
		if (typeof value === "string") bytes += value.length * 2;
	}
	for (const key of NESTED_META_BYTES_KEYS) {
		const value = meta[key];
		if (value === undefined || value === null) continue;
		bytes += memoizedNestedMetaLength(meta, key, value) * 2;
	}
	return bytes;
}
