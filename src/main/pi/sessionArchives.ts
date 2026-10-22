import type { ChatMessage } from "../../shared/types";
import { convertAgentMessages } from "./messageTimeline";
import { isJsonRecord, parseSessionText } from "../sessions/sessionEntries";

/** parseArchives 返回的压缩记录结构。 */
export interface SessionCompaction {
	id: string;
	summary: string;
	timestamp: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
}

/** parseArchives 返回值：压缩段列表 + 每段对应的归档消息（ChatMessage 格式）。 */
export interface SessionArchives {
	compactions: SessionCompaction[];
	/** key 为压缩条目 id */
	archivedMessagesByCompactionId: Map<string, ChatMessage[]>;
}

export function emptySessionArchives(): SessionArchives {
	return { compactions: [], archivedMessagesByCompactionId: new Map() };
}

/**
 * 从原始 JSONL 文本解析压缩归档。
 *
 * 关键前提：没有 compaction 条目时结果必然为空。JSONL 里 compaction 条目的
 * `"type":"compaction"` 会以字面量出现在原文中，因此先用一次 substring 扫描
 * 排除绝大多数会话，避免对其整份 JSON.parse + 构建 parentId 索引。
 * 这是打开普通长会话时主线程最大的一块同步 CPU。
 *
 * 放在独立模块里是为了让 worker 与主线程两条路径共用同一实现（零行为差异）。
 */
export function extractSessionArchives(
	raw: string,
	agentId: string,
	onConvertError?: (detail: {
		compactionId: string;
		rawCount: number;
		error: unknown;
	}) => void,
): SessionArchives {
	// 误报（消息正文里出现该字面量）只会退化为正常解析，不会影响正确性。
	if (!raw.includes('"compaction"')) return emptySessionArchives();

	return extractSessionArchivesFromEntries(parseSessionText(raw).entries, agentId, onConvertError);
}

/**
 * 调用方已经解析过 JSONL（如 Viewer 的 readDisplayMessages）时直接复用条目，
 * 避免为了归档再对同一份原文跑第二遍 JSON.parse。
 */
export function extractSessionArchivesFromEntries(
	entries: unknown[],
	agentId: string,
	onConvertError?: (detail: {
		compactionId: string;
		rawCount: number;
		error: unknown;
	}) => void,
): SessionArchives {
	const allEntries: Array<{
		id: string;
		parentId: string | null;
		type: string;
		message?: unknown;
		summary?: string;
		firstKeptEntryId?: string;
		tokensBefore?: number;
		timestamp: string;
	}> = [];
	const rawMessagesByEntryId = new Map<string, unknown>();

	for (const entry of entries) {
		// 单行解析失败已由 sessionEntries 隔离：跳过该行，其余记录照常参与归档回溯。
		if (!isJsonRecord(entry)) continue;
		const entryId = typeof entry.id === "string" ? entry.id : "";
		allEntries.push({
			id: entryId,
			parentId: typeof entry.parentId === "string" ? entry.parentId : null,
			type: typeof entry.type === "string" ? entry.type : "",
			message: entry.message,
			summary: typeof entry.summary === "string" ? entry.summary : undefined,
			firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
			tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
		});
		// 缓存消息型 entry 的原始 message 对象，供后续 convertAgentMessages 使用
		if (entry.type === "message" && entry.message && typeof entry.message === "object" && entryId) {
			rawMessagesByEntryId.set(entryId, entry.message);
		}
	}

	// 建立 entryId → entry 索引（含 parentId 关系）
	const entryById = new Map<string, (typeof allEntries)[number]>();
	for (const entry of allEntries) {
		if (entry.id) entryById.set(entry.id, entry);
	}

	// 提取压缩条目（按文件顺序，即时间顺序）
	const compactionEntries = allEntries.filter((e) => e.type === "compaction");
	const compactions: SessionCompaction[] = compactionEntries.map((c) => ({
		id: c.id,
		summary: c.summary ?? "",
		timestamp: c.timestamp,
		firstKeptEntryId: c.firstKeptEntryId,
		tokensBefore: c.tokensBefore,
	}));

	// 为每个压缩条目收集其归档范围内的消息。
	// 归档范围：从压缩条目的 parentId 沿 parentId 链向上，收集所有 type=message 的条目，
	// 直到遇到该压缩条目的 firstKeptEntryId 或上一个压缩条目的 firstKeptEntryId（避免重复归组）。
	const archivedMessagesByCompactionId = new Map<string, ChatMessage[]>();
	const coveredEntryIds = new Set<string>();

	// 按文件顺序处理（从旧到新），确保较早的压缩条目优先确定范围
	for (const compEntry of compactionEntries) {
		const rawMessages: unknown[] = [];
		const seenIds = new Set<string>();

		// 从压缩条目的 parentId 开始向上回溯
		let currentId: string | null = compEntry.parentId;
		while (currentId) {
			if (seenIds.has(currentId)) break; // 防止循环
			seenIds.add(currentId);

			const entry = entryById.get(currentId);
			if (!entry) break;

			// 遇到 firstKept 或已被上一个压缩条目覆盖的条目时停止
			if (currentId === compEntry.firstKeptEntryId) break;
			if (coveredEntryIds.has(currentId)) break;

			// 收集消息型 entry
			if (entry.type === "message") {
				const rawMsg = rawMessagesByEntryId.get(currentId);
				if (rawMsg) {
					rawMessages.push(rawMsg);
					coveredEntryIds.add(currentId);
				}
			}

			currentId = entry.parentId;
		}

		if (rawMessages.length === 0) continue;

		// 反转消息顺序（回溯得到的是从新到旧，需反转为从旧到新）
		rawMessages.reverse();
		try {
			const chatMessages = convertAgentMessages(agentId, rawMessages, undefined, false);
			if (chatMessages.length > 0) {
				archivedMessagesByCompactionId.set(compEntry.id, chatMessages);
			}
		} catch (error) {
			onConvertError?.({
				compactionId: compEntry.id,
				rawCount: rawMessages.length,
				error,
			});
		}
	}

	return { compactions, archivedMessagesByCompactionId };
}
