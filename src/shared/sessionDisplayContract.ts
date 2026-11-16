/**
 * 会话展示契约（SessionDisplayContract）—— 服务端序列化、桌面时间线、手机端共用的
 * **唯一**展示推导规则。
 *
 * 为什么需要这一层（deep module）：同一条 ChatMessage 会被三个消费者各自解释：
 *   - 主进程 Web 服务（compact 轮询、会话列表过滤）；
 *   - 桌面渲染层（ToolCards 副标题、TurnRow 投递标签、时间/路径格式化）；
 *   - 手机端 classic script（mobile.js，无法 import TS）。
 * 迁移前三处各写了一份「工具参数取哪个键」「投递策略怎么标」「哪些会话算顶层」
 * 「时间怎么格式化」「ANSI 怎么清」「路径怎么截断」，
 * 并且已经漂移（手机按 command 优先、桌面按 path 优先；手机只认中文标签）。
 *
 * 规则：本模块只做纯推导（无 IO、无 DOM；不读 ambient locale 以外的环境）。
 * 客户端只负责把结果排版：
 *   - 桌面端 import 语义值，再用 i18n 本地化文案；
 *   - 手机端不 import，只消费服务端附加的派生字段（`meta.summary` / `meta.delivery` /
 *     `meta.deliveryText` / `meta.statusKind` / `meta.statusText` / `meta.statusGlyph`、
 *     agent 的 `statusText`）。手机端是单语 UI（不接 i18n），所以契约同时产出**中文文案**；
 *     文案与桌面 zh 词条保持一致，避免同一状态两端说法不同。
 */
import type { AgentStatus, ChatMessage } from "./types";

/* ── 时间展示 ── */

/** 时间呈现形式：`short` 给侧栏/时间线，`full` 给日志等需要完整日期时间的场景。 */
export type TimestampStyle = "short" | "full";

// 复用同一个 Intl 实例：侧栏/时间线/大纲会按行大量调用，每次新建格式化器很贵。
const SHORT_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
});

/**
 * 时间格式化的唯一实现。`short`（月/日 时:分）与 `full`（本地完整日期时间）
 * 只是同一算法下的两种呈现形式，调用方按场景选择，不要各自复制一份格式化器。
 */
export function formatTimestamp(timestamp: number, style: TimestampStyle = "short"): string {
	return style === "full"
		? new Date(timestamp).toLocaleString()
		: SHORT_TIME_FORMATTER.format(timestamp);
}

/* ── ANSI 清理 ── */

// 匹配 \x1b[...m 等终端颜色/样式序列。
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** 去除 pi 输出中的 ANSI 终端转义码（桌面与主进程共用这一份实现）。 */
export function stripAnsi(text: string): string {
	// 绝大多数消息文本不含转义码；先做一次 O(n) 扫描，命中则原样返回同一字符串对象，
	// 省掉 replace 的整串分配（20Hz 流式重算整窗消息文本时就是这条路径）。
	return text.includes("\x1b") ? text.replace(ANSI_RE, "") : text;
}

/* ── 路径展示 ── */

/**
 * 截断策略（显式选择，避免各调用方自己发明省略号规则）：
 * - `tail`：保留**尾部**（`.../a/b.ts` 的语义是「离用户更近的后半段」），
 *   用于侧栏项目路径：先折叠 home 前缀，再按字符数截断；
 * - `head`：保留**末 N 段**（`.../parent/file`），用于导入弹框的会话源路径。
 */
export type PathDisplayStyle = "tail" | "head";

/** `tail` 策略：超过该长度才截断。 */
const PATH_TAIL_MAX_CHARS = 36;
/** `tail` 策略：截断后保留的尾部字符数（省略号 3 个字符另算）。 */
const PATH_TAIL_KEEP_CHARS = 35;
/** `head` 策略：保留的路径段数。 */
const PATH_HEAD_SEGMENTS = 2;

/**
 * 路径展示的唯一实现。`home` 由调用方注入（渲染层从 location 解析；纯函数不碰 DOM）。
 */
export function displayPath(
	path?: string,
	options: { style?: PathDisplayStyle; home?: string } = {},
): string {
	if (!path) return "";
	const normalized = path.replace(/\\/g, "/");
	const home = options.home?.replace(/\\/g, "/").replace(/\/+$/, "");
	const friendly =
		home && normalized.toLowerCase().startsWith(home.toLowerCase())
			? `~${normalized.slice(home.length)}`
			: normalized;
	if (options.style === "head") {
		const parts = friendly.split("/");
		return parts.length <= PATH_HEAD_SEGMENTS
			? friendly
			: `.../${parts.slice(-PATH_HEAD_SEGMENTS).join("/")}`;
	}
	return friendly.length > PATH_TAIL_MAX_CHARS
		? `...${friendly.slice(-PATH_TAIL_KEEP_CHARS)}`
		: friendly;
}

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

/** 投递策略语义值：服务端把它写进 `meta.delivery` / `meta.deliveryText`。 */
export type DeliveryKind = "follow-up" | "steer";

export function deliveryKind(value: unknown): DeliveryKind | null {
	// 语义值本身也接受，保证「已派生字段再 compact 一次」仍然幂等。
	if (value === "followUp" || value === "follow-up") return "follow-up";
	if (value === "steer") return "steer";
	return null;
}

/** 手机端（单语 UI）投递标签文案：与桌面 zh 词条 app.messageDelivery* 一致。 */
export const DELIVERY_LABELS: Readonly<Record<DeliveryKind, string>> = {
	"follow-up": "结束后排队",
	steer: "下次调用前",
};

/* ── 运行状态 ── */

/** Agent 运行状态的契约值：与 shared/types 的 AgentStatus 同集，未知值归一到 idle。 */
export type SessionStatusKind = AgentStatus;

export function sessionStatusKind(value: unknown): SessionStatusKind {
	return value === "running" || value === "starting" || value === "error" || value === "closed"
		? value
		: "idle";
}

/** 手机端状态文案：与桌面 zh 词条 app.status* 一致（error 桌面也用「失败」）。 */
export const SESSION_STATUS_LABELS: Readonly<Record<SessionStatusKind, string>> = {
	idle: "空闲",
	running: "运行中",
	starting: "启动中",
	error: "失败",
	closed: "已关闭",
};

/** 工具执行状态的三态语义值（原始 meta.status 还可能是 done/running/error 之外的写法）。 */
export type ToolStatusKind = "running" | "error" | "done";

export const TOOL_STATUS_LABELS: Readonly<Record<ToolStatusKind, string>> = {
	running: "运行中",
	error: "失败",
	done: "完成",
};

export const TOOL_STATUS_GLYPHS: Readonly<Record<ToolStatusKind, string>> = {
	running: "▶",
	error: "✗",
	done: "✓",
};

/**
 * 工具状态推导：显式 meta 优先，缺失时回退正文首字符标记（历史消息常见）。
 * `text` 可省略——桌面端只关心是否 error，手机端拿服务端算好的三件套。
 */
export function toolStatusKind(
	meta: Record<string, unknown> | undefined,
	text?: string,
): ToolStatusKind {
	if (meta?.isError === true || meta?.status === "error") return "error";
	if (meta?.status === "running") return "running";
	const head = text?.charAt(0);
	if (head === "✗") return "error";
	if (head === "▶") return "running";
	// 显式成功标记或历史截断文本都按完成处理，与旧手机端一致。
	return "done";
}

/**
 * 工具参数里「最能说明这次调用做了什么」的键，按优先级排列。
 *
 * 顺序即产品语义：先看操作对象（路径/文件），再看命令，然后搜索词、URL、待办内容。
 * 桌面端曾用 path 优先、手机端曾用 command 优先，同一张卡片两边显示不同结果；
 * 现在两边都从这一份顺序取第一个非空字符串。
 */
const TOOL_ARG_PATH_KEYS = [
	// 文件操作类
	"filePath",
	"file_path",
	"path",
	"file",
] as const;

const TOOL_ARG_KEYS = [
	...TOOL_ARG_PATH_KEYS,
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

/**
 * diff / 修改清单只认路径类键。前四项与摘要优先级同源，其余是写入类工具的别名；
 * 合并进同一张表，避免 timelineProjection 再维护一份自己的键序。
 */
const TOOL_PATH_KEYS = [
	...TOOL_ARG_PATH_KEYS,
	"targetPath",
	"target_path",
	"outputPath",
	"output_path",
	"fileName",
	"filename",
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

/**
 * 只取路径类参数（diff 目标、修改清单用）。与摘要共用同一份路径键优先级，
 * 差别只在于「没有路径就返回 undefined」，不会拿 command / pattern 冒充文件路径。
 */
export function toolArgPath(args: unknown): string | undefined {
	const parsed = asArgsRecord(args);
	if (!parsed) return undefined;
	for (const key of TOOL_PATH_KEYS) {
		const found = firstString(parsed[key]);
		if (found) return found;
	}
	return undefined;
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
 * 附加客户端展示需要的派生字段（**不截断**，因此单条消息详情端点也复用它）。
 *
 * 派生字段是「唯一实现」的落地点：手机端只读这些字段渲染，不再复制参数键表、
 * 投递策略映射、状态中文表（见模块注释）。重复调用幂等：值相同就不产生新对象。
 */
export function attachDisplayMeta(message: ChatMessage): ChatMessage {
	const base: Record<string, unknown> = message.meta ?? {};
	const derived: Array<[string, unknown]> = [];
	if (message.role === "tool") {
		const kind = toolStatusKind(base, message.text);
		derived.push(
			["statusKind", kind],
			["statusText", TOOL_STATUS_LABELS[kind]],
			["statusGlyph", TOOL_STATUS_GLYPHS[kind]],
		);
		const summary = toolSummaryFromMeta(base);
		if (summary) derived.push(["summary", summary]);
	}
	// 语义值本身也接受（deliveryKind 幂等），历史消息则从 streamingBehavior 推导。
	const delivery = deliveryKind(base.delivery) ?? deliveryKind(base.streamingBehavior);
	if (delivery) {
		derived.push(["delivery", delivery], ["deliveryText", DELIVERY_LABELS[delivery]]);
	}
	if (!derived.some(([key, value]) => base[key] !== value)) return message;
	const meta = { ...base };
	for (const [key, value] of derived) meta[key] = value;
	return { ...message, meta };
}

/**
 * compact 序列化：折叠超长工具输出 / 思考，并附加客户端展示需要的派生字段。
 *
 * - 截断标记（hasMore/fullLength、thinkingHasMore/fullThinkingLength）是「展开全文」
 *   唯一的判定依据，手机端直接读它们；
 * - `summary` / `delivery` / `status*` 等派生字段由 attachDisplayMeta 产出，手机端只渲染。
 */
export function compactChatMessage(message: ChatMessage): ChatMessage {
	let next = attachDisplayMeta(message);
	const meta: Record<string, unknown> = { ...(next.meta ?? {}) };
	let metaChanged = false;

	if (next.role === "tool" && next.text.length > COMPACT_TOOL_TEXT_LIMIT) {
		const fullLength = next.text.length;
		next = { ...next, text: next.text.slice(0, COMPACT_TOOL_TEXT_LIMIT) };
		meta.hasMore = true;
		meta.fullLength = fullLength;
		metaChanged = true;
	}
	if (typeof next.thinking === "string" && next.thinking.length > COMPACT_THINKING_LIMIT) {
		const fullThinkingLength = next.thinking.length;
		next = { ...next, thinking: next.thinking.slice(0, COMPACT_THINKING_LIMIT) };
		meta.thinkingHasMore = true;
		meta.fullThinkingLength = fullThinkingLength;
		metaChanged = true;
	}
	return metaChanged ? { ...next, meta } : next;
}
