/**
 * 会话展示契约（SessionDisplayContract）—— 服务端序列化、桌面时间线、手机端共用的
 * **唯一**展示推导规则。
 *
 * 为什么需要这一层（deep module）：同一条 ChatMessage 会被三个消费者各自解释：
 *   - 主进程 Web 服务（compact 轮询、会话列表过滤）；
 *   - 桌面渲染层（ToolCards 副标题、TurnRow 投递标签）；
 *   - 手机端 classic script（mobile.js，无法 import TS）。
 * 迁移前三处各写了一份「工具参数取哪个键」「投递策略怎么标」「哪些会话算顶层」，
 * 并且已经漂移（手机按 command 优先、桌面按 path 优先；手机只认中文标签）。
 *
 * 规则：本模块只做纯推导（无 IO、无 DOM、无 locale），客户端只负责把结果排版。
 * 手机端不 import 本模块，而是消费服务端 compact 后附加的 `meta.summary` /
 * `meta.delivery` 字段——因此这里的推导必须与 mobile.js 的渲染字段保持一一对应。
 */
import type { ChatMessage } from "./types";

/** compact 轮询只回传折叠内容预览；完整内容走单条消息详情端点。 */
export const COMPACT_TOOL_TEXT_LIMIT = 1024;
export const COMPACT_THINKING_LIMIT = 800;
/** 工具副标题（命令 / 路径）单行展示上限，与旧手机端 shortText 默认值一致。 */
export const TOOL_SUMMARY_MAX_CHARS = 120;

/**
 * 顶层会话规则：扩展 worker / reviewer 子会话不占首页。
 *
 * 服务端（/api/projects/:id/sessions?topLevel=1）与手机首页共用这一条；
 * 桌面侧栏另有树形投影（含 orphan 恢复），语义不同，不复用这个扁平谓词。
 */
export function isTopLevelSessionSummary(session: {
	parentSessionPath?: unknown;
	codexParentThreadId?: unknown;
	codexThreadSource?: unknown;
}): boolean {
	return (
		Boolean(session) &&
		!session.parentSessionPath &&
		!session.codexParentThreadId &&
		session.codexThreadSource !== "subagent"
	);
}

/** 投递策略语义值：服务端把它写进 `meta.delivery`，客户端只做本地化。 */
export type DeliveryKind = "follow-up" | "steer";

export function deliveryKind(value: unknown): DeliveryKind | null {
	if (value === "followUp") return "follow-up";
	if (value === "steer") return "steer";
	return null;
}

/**
 * 工具参数里「最能说明这次调用做了什么」的键，按优先级排列。
 *
 * 顺序即产品语义：先看操作对象（路径/文件），再看命令，然后搜索词、URL、待办内容。
 * 桌面端曾用 path 优先、手机端曾用 command 优先，同一张卡片两边显示不同结果；
 * 现在两边都从这一份顺序取第一个非空字符串。
 */
const TOOL_ARG_KEYS = [
	// 文件操作类
	"filePath",
	"file_path",
	"path",
	"file",
	// bash/shell 命令
	"command",
	"cmd",
	// 搜索/查询类（grep、web_search 等）
	"pattern",
	"query",
	"queries",
	// 网络获取类
	"url",
	"urls",
	// 待办/描述类
	"action",
	"text",
	"description",
	"title",
	"question",
	"prompt",
] as const;

/** 历史平铺写法（meta.path / meta.command / meta.file）的兜底顺序。 */
const LEGACY_META_KEYS = ["path", "command", "file"] as const;

function asArgsRecord(args: unknown): Record<string, unknown> | undefined {
	if (args && typeof args === "object" && !Array.isArray(args)) {
		return args as Record<string, unknown>;
	}
	if (typeof args === "string" && args.trim()) {
		try {
			const parsed: unknown = JSON.parse(args);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// pi 参数也可能被截断成非法 JSON；退回 meta 兜底，不抛错
		}
	}
	return undefined;
}

function firstString(value: unknown): string | undefined {
	if (typeof value === "string" && value) return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === "string" && item) return item;
		}
	}
	return undefined;
}

/**
 * 从工具参数里取一行可读摘要（不折叠空白、不截断）：桌面端拿它做副标题，
 * 手机端由服务端预先算好放进 `meta.summary`。
 */
export function toolArgSummary(
	args: unknown,
	meta?: Record<string, unknown>,
): string | undefined {
	const parsed = asArgsRecord(args);
	if (parsed) {
		for (const key of TOOL_ARG_KEYS) {
			const found = firstString(parsed[key]);
			if (found) return found;
		}
	}
	for (const key of LEGACY_META_KEYS) {
		const found = firstString(meta?.[key]);
		if (found) return found;
	}
	if (parsed) {
		for (const value of Object.values(parsed)) {
			const found = firstString(value);
			if (found) return found;
		}
	}
	return undefined;
}

/** 折叠空白并截断到 max（含省略号），用于单行展示。 */
export function shortText(value: unknown, max = TOOL_SUMMARY_MAX_CHARS): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** 手机端工具卡片副标题：摘要 → detailText 首个正文行 → 结果文本。 */
export function toolSummaryFromMeta(meta: Record<string, unknown> | undefined): string {
	if (!meta) return "";
	// 已是 compact 产物（或调用方预先算好）时直接复用，保证重复 compact 幂等。
	if (typeof meta.summary === "string" && meta.summary) return meta.summary;
	const summary = toolArgSummary(meta.args, meta);
	if (summary) return shortText(summary);
	const detailLine = String(meta.detailText ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line && !/^(工具|状态|参数|结果|详情)：/.test(line));
	if (detailLine) return shortText(detailLine);
	return shortText(meta.result);
}

/**
 * compact 序列化：折叠超长工具输出 / 思考，并附加客户端展示需要的派生字段。
 *
 * - 截断标记（hasMore/fullLength、thinkingHasMore/fullThinkingLength）是「展开全文」
 *   唯一的判定依据，手机端直接读它们；
 * - `summary` / `delivery` 让手机端不必再复制参数键表与投递策略映射（见模块注释）。
 */
export function compactChatMessage(message: ChatMessage): ChatMessage {
	let next = message;
	const meta: Record<string, unknown> = { ...(message.meta ?? {}) };
	let metaChanged = false;

	if (message.role === "tool" && message.text.length > COMPACT_TOOL_TEXT_LIMIT) {
		next = { ...next, text: message.text.slice(0, COMPACT_TOOL_TEXT_LIMIT) };
		meta.hasMore = true;
		meta.fullLength = message.text.length;
		metaChanged = true;
	}
	if (typeof message.thinking === "string" && message.thinking.length > COMPACT_THINKING_LIMIT) {
		next = { ...next, thinking: message.thinking.slice(0, COMPACT_THINKING_LIMIT) };
		meta.thinkingHasMore = true;
		meta.fullThinkingLength = message.thinking.length;
		metaChanged = true;
	}
	if (message.role === "tool" && typeof meta.summary !== "string") {
		const summary = toolSummaryFromMeta(meta);
		if (summary) {
			meta.summary = summary;
			metaChanged = true;
		}
	}
	if (meta.delivery === undefined) {
		const delivery = deliveryKind(meta.streamingBehavior);
		if (delivery) {
			meta.delivery = delivery;
			metaChanged = true;
		}
	}
	return metaChanged ? { ...next, meta } : next;
}
