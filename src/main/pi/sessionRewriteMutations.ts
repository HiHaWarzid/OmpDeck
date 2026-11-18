import type { ChatMessage } from "../../shared/types";
import { isJsonRecord } from "../sessions/sessionEntries";
import { extractMessageText } from "./messageContent";
import {
	assertResendRootEntry,
	collectDescendantEntryIds,
	findLastUserMessageLine,
} from "./sessionEntryIds";

/**
 * 三条会话改写的行级变换（纯函数 + 定位器注入）。
 *
 * 与 sessionRewrite（锁/重载/回滚编排）分开，是因为这里才是业务规则密集区：
 * 「只认 user/assistant」「删一条要重挂子节点」「重发只允许截断最后一条 user」。
 * 把这些规则留在编排模块里，测试就得同时伪造锁、空闲闸与 RPC；抽出来后
 * 直接用字符串行数组断言文件内容即可覆盖边界。
 *
 * 行内容是外部持久化数据，解析后先按 unknown 收窄成 ParsedEntry 视图再读字段，
 * 不让 any 从 JSON.parse 一路流到改写逻辑里。
 */

/** 一条 JSONL 行的已收窄视图：raw 保留原始对象以便写回，其余是只读投影。 */
export interface ParsedEntry {
	raw: Record<string, unknown>;
	id?: string;
	parentId?: unknown;
	type?: unknown;
	role?: unknown;
	content?: unknown;
}

/** `SessionJsonl.locateEntry` 的形状（避免把整个 SessionJsonl 类型拖进来）。 */
export type LocateEntry = (
	lines: string[],
	messages: ChatMessage[],
	msg: ChatMessage,
) => { lineIndex: number; entry: Record<string, unknown> };

function parseLine(line: string | undefined): ParsedEntry | null {
	const trimmed = line?.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!isJsonRecord(parsed)) return null;
	const message = parsed.message;
	const typed = isJsonRecord(message) ? message : undefined;
	return {
		raw: parsed,
		id: typeof parsed.id === "string" ? parsed.id : undefined,
		parentId: parsed.parentId,
		type: parsed.type,
		role: typed?.role,
		content: typed?.content,
	};
}

/**
 * 编辑：把目标 entry 的首个 text block 换成 newText（没有 text block 时追加一个）。
 *
 * 只允许 user/assistant：toolResult 的正文来自工具输出，改写会与 pi 的执行记录
 * 分叉；system 卡片是桌面端派生视图，文件里并没有对应可编辑文本。
 */
export function editEntryText(args: {
	lines: string[];
	messages: ChatMessage[];
	messageId: string;
	newText: string;
	locate: LocateEntry;
}): void {
	const { lines, messages, messageId, newText, locate } = args;
	const msg = messages.find((m) => m.id === messageId);
	if (!msg) throw new Error("Message not found");

	const { lineIndex, entry } = locate(lines, messages, msg);
	const message = isJsonRecord(entry.message) ? entry.message : undefined;
	if (message?.role !== "user" && message?.role !== "assistant") {
		throw new Error("Only user and assistant messages can be edited");
	}

	const content = message.content;
	if (Array.isArray(content)) {
		const textBlock = content.find((block) => isJsonRecord(block) && block.type === "text");
		if (isJsonRecord(textBlock)) {
			textBlock.text = newText;
		} else {
			content.push({ type: "text", text: newText });
		}
	} else {
		message.content = [{ type: "text", text: newText }];
	}
	lines[lineIndex] = JSON.stringify(entry);
}

/**
 * 删除：用 `{type:"deleted"}` 占位行替换原行，并把它的直接子节点重挂到父节点。
 *
 * 两个刻意的选择：
 *   - 保留行号（不删行）：pi 的 session tree 按 parentId 串接，行数偏移会让
 *     entry 与 messages 的对应关系错位；
 *   - 重挂子节点：父节点消失会让子分支变成 dangling orphan，pi 重载时会
 *     丢弃整个分支——这正是「删一条丢多条」的成因。
 * 占位行不带 id：pi 的 get_entries 若仍返回已删 entry，activeEntryIds 会与
 * messages 不匹配。
 */
export function deleteEntry(args: {
	lines: string[];
	messages: ChatMessage[];
	messageId: string;
	locate: LocateEntry;
}): void {
	const { lines, messages, messageId, locate } = args;
	const msg = messages.find((m) => m.id === messageId);
	if (!msg) throw new Error("Message not found");

	const { lineIndex, entry } = locate(lines, messages, msg);
	const deletedEntryId = typeof entry.id === "string" ? entry.id : undefined;
	const deletedParentId = entry.parentId;

	// 子节点重挂：只处理直接子节点即可——孙节点仍指向自己的父节点，间接挂在
	// 被删 entry 的父节点之下，不需要递归改写。
	if (deletedEntryId && deletedParentId !== undefined) {
		for (let i = 0; i < lines.length; i++) {
			if (i === lineIndex) continue;
			const child = parseLine(lines[i]);
			if (!child || child.parentId !== deletedEntryId) continue;
			child.raw.parentId = deletedParentId;
			lines[i] = JSON.stringify(child.raw);
		}
	}

	lines[lineIndex] = JSON.stringify({
		type: "deleted",
		originalEntryId: deletedEntryId ?? `unknown-${messageId}`,
		ts: Date.now(),
	});
}

/** 重发截断的结果，供调用方日志与返回值使用。 */
export interface ResendTruncationResult {
	/** 被 tombstone 的 entry 数（含 root 本身）。 */
	removed: number;
	rootEntryId: string;
}

/**
 * 重发：tombstone「目标 user 及其全部后代」，保留 root 之前的历史。
 *
 * 定位有三层纠错，全部因为 entryId 可能错位：
 *   1. locateEntry 的 entryId 定位可能落到 assistant 或更早的同文案 user；
 *   2. 纯文本消息再按「最后一次同文案 user」校正；
 *   3. 最后扫一遍文件取真正最后一条 role=user，若 root 不是它则拒绝截断。
 *
 * 第 3 步是硬护栏：截断 root 的后代会把它之后的历史一并删掉，这正是
 * 「点重发把之前消息全没了」的根因，宁可失败也不误删。
 *
 * 不做 re-parent：重发语义是丢掉本轮失败回复再重跑，而不是把失败分支挂回父节点。
 */
export function truncateForResend(args: {
	lines: string[];
	messages: ChatMessage[];
	/**
	 * 已解析的目标消息，而不是 messageId。
	 *
	 * 重发的身份校验（存在 + role=user）必须发生在**读文件之前**才符合原错误优先级，
	 * 因此由调用方的 prepare 解析一次后传进来。这里不能再从 messages 里查一遍：
	 * `messages` 在读取文件期间可能已被替换成新转录，二次查找会让「已通过校验的
	 * 重发」在写盘路径上突然变成 Message not found，而旧实现用的是同一次查找结果。
	 */
	msg: ChatMessage;
	locate: LocateEntry;
	onLocateMismatch?: (detail: { messageId: string; error: unknown }) => void;
	onDuplicateCorrected?: (detail: {
		messageId: string;
		originalLine: number;
		correctedLine: number;
		originalEntryId?: string;
		correctedEntryId?: string;
	}) => void;
	onBlocked?: (detail: {
		messageId: string;
		rootEntryId: string;
		lastUserEntryId?: string;
		rootLine: number;
		lastUserLine: number;
	}) => void;
}): ResendTruncationResult {
	const { lines, messages, msg, locate } = args;
	const messageId = msg.id;

	const textOf = (content: unknown) => extractMessageText(content);

	let lineIndex = -1;
	let entry: Record<string, unknown> = {};
	try {
		const located = locate(lines, messages, msg);
		lineIndex = located.lineIndex;
		entry = located.entry;
		// entryId 错位时可能定位到 assistant 或更早的 user；
		// 校验失败则回退到「最后一条同文案 user」，禁止带着错误根继续截断。
		assertResendRootEntry(entry, msg.text, textOf);
	} catch (locateError) {
		const fallback = findLastUserMessageLine(lines, msg.text, textOf);
		if (!fallback) throw locateError;
		args.onLocateMismatch?.({ messageId, error: locateError });
		lineIndex = fallback.lineIndex;
		entry = fallback.entry;
		assertResendRootEntry(entry, msg.text, textOf);
	}

	// 兜底验证：确保定位到的 entry 是文件中最后一条同文本 user 消息。
	// 纯文本消息用 findLastUserMessageLine 做二次校验；图片消息（text="[图片]"）
	// 的占位文案会命中所有图片消息，不能作为唯一标识。
	if (msg.text !== "[图片]") {
		const lastMatch = findLastUserMessageLine(lines, msg.text, textOf);
		if (lastMatch && lastMatch.lineIndex !== lineIndex) {
			args.onDuplicateCorrected?.({
				messageId,
				originalLine: lineIndex,
				correctedLine: lastMatch.lineIndex,
				originalEntryId: typeof entry.id === "string" ? entry.id : undefined,
				correctedEntryId:
					typeof lastMatch.entry.id === "string" ? lastMatch.entry.id : undefined,
			});
			lineIndex = lastMatch.lineIndex;
			entry = lastMatch.entry;
			assertResendRootEntry(entry, msg.text, textOf);
		}
	}

	const rootEntryId = typeof entry.id === "string" ? entry.id : undefined;
	if (!rootEntryId) throw new Error("User message entryId missing");

	// 不依赖文案：扫描文件中最后一条 role=user，防止「最后一条 user 文本不同」时误判。
	let lastUserLineIndex = -1;
	let lastUserEntryId: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseLine(lines[i]);
		if (!parsed || parsed.type === "deleted") continue;
		if (parsed.role === "user" && parsed.id) {
			lastUserLineIndex = i;
			lastUserEntryId = parsed.id;
		}
	}
	if (
		lastUserEntryId &&
		(lastUserEntryId !== rootEntryId || lastUserLineIndex !== lineIndex)
	) {
		args.onBlocked?.({
			messageId,
			rootEntryId,
			lastUserEntryId,
			rootLine: lineIndex,
			lastUserLine: lastUserLineIndex,
		});
		throw new Error("Resend root is not the last user message; refusing to truncate earlier history");
	}

	const removeIds = collectDescendantEntryIds(lines, rootEntryId);
	let removed = 0;
	for (let i = 0; i < lines.length; i++) {
		const parsed = parseLine(lines[i]);
		// 已 tombstone 的行跳过（与旧实现一致）：重写会把它的 originalEntryId 换成新值，
		// 也会把 removed 数算重。正常 tombstone 没有 id，这里是给残留脏行兜底。
		if (!parsed || !parsed.id || parsed.type === "deleted") continue;
		if (!removeIds.has(parsed.id)) continue;
		lines[i] = JSON.stringify({
			type: "deleted",
			originalEntryId: parsed.id,
			ts: Date.now(),
			reason: "resend-truncate",
		});
		removed += 1;
	}

	// 兜底：定位行本身若因 id 异常未进集合，至少 tombstone 该行。
	if (lineIndex >= 0 && lineIndex < lines.length) {
		const current = lines[lineIndex]?.trim();
		if (current && !current.includes('"type":"deleted"')) {
			lines[lineIndex] = JSON.stringify({
				type: "deleted",
				originalEntryId: rootEntryId,
				ts: Date.now(),
				reason: "resend-truncate",
			});
			removed += 1;
		}
	}

	return { removed, rootEntryId };
}
