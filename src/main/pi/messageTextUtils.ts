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
 */

import type { ImageContent } from "../../shared/types";

/** 工具结果文本截断阈值（字符数）。 */
const MAX_TOOL_RESULT_CHARS = 8000;

/** 安全序列化任意值为 JSON 字符串，处理循环引用等异常。 */
export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** 清理 ANSI 转义码（模型思考内容中常见终端颜色序列）。 */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
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
