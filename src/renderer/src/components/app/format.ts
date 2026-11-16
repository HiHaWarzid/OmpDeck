/**
 * 纯文本/时间格式化工具（无组件）：供多个组件模块共用，集中一处避免各自重复实现。
 *
 * 展示规则（时间、ANSI、路径、工具摘要）的唯一实现在 shared/sessionDisplayContract；
 * 本文件只是渲染层的薄转发入口，禁止在这里再写第二套算法。
 */
import removeMarkdown from "remove-markdown";
import { stripAnsi } from "../../../../shared/sessionDisplayContract";

export {
	formatTimestamp as formatTime,
	stripAnsi,
} from "../../../../shared/sessionDisplayContract";

export function formatCompact(value?: number | null) {
	if (value == null) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}
export function formatBytes(value: number) {
	if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${value} B`;
}
/** 将毫秒数格式化为短可读形式,如 "3.2s" "1m23s" */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return remaining > 0 ? `${minutes}m${remaining}s` : `${minutes}m`;
}
/**
 * 单行摘要：去 ANSI、去围栏代码块后取首个非空行，超长截断。
 * 会话大纲、多选弹窗、会话引用弹窗共用同一截断策略，避免三处各写一遍。
 */
export function summarizeMessage(text: string) {
	const cleaned = stripAnsi(text);
	const firstLine =
		cleaned
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
}

/** 去除文本中的 <thinking> 标签 */
export function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}
/** 将 Markdown 语法转换为纯文本，保留可读的文字内容 */
export function stripMarkdown(text: string): string {
	return removeMarkdown(text, {
		// 保留列表项文本，移除列表标记符号
		stripListLeaders: true,
		// 使用 Unicode 字符替换列表标记
		listUnicodeChar: "",
		// 启用 GFM 表格/任务列表等处理
		gfm: true,
		// 图片保留 alt 文本
		useImgAltText: true,
	});
}
