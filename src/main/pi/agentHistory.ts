import type { ChatMessage, WebAgentHistoryPage } from "../../shared/types";
import { fullTextOf, type AgentTranscriptState } from "./agentTranscript";
import { convertAgentMessages } from "./messageTimeline";

/** 分页模块只读运行时的三件事：会话文件、当前时间线、文件基线游标。 */
export type HistoryRuntime = {
	tab: { sessionPath?: string };
	transcript: AgentTranscriptState;
	/** 文件基线记录的窗口起点（字节偏移）；未跑过 loadMessages 时为空。 */
	historyCursor?: number;
};

export type HistoryJsonl = {
	findEntryOffset(sessionPath: string, entryId: string): Promise<number | undefined>;
	readOlderMessages(
		sessionPath: string,
		beforeOffset: number | undefined,
		maxTurns: number,
	): Promise<{ messages: unknown[]; entryIds: string[]; cursor: number; hasMore: boolean }>;
	readDisplayMessages(sessionPath: string, agentId: string, preloadedEntries?: readonly unknown[]): Promise<ChatMessage[]>;
	readEntryTextById(sessionPath: string, entryId: string): Promise<string | null>;
};

export type AgentHistoryHost = {
	/** 取运行时；agent 不存在时抛错，与 AgentManager.requireRuntime 语义一致。 */
	runtime(agentId: string): HistoryRuntime;
	jsonl: HistoryJsonl;
	log?: {
		info(scope: string, message: string, detail?: Record<string, unknown>): void;
	};
};

/** 桌面端一页历史默认覆盖的轮数（每轮 user + assistant，另含工具消息）。 */
export const HISTORY_PAGE_TURNS = 30;
/** 手机端一页历史条数上限；超出会撑爆单次 HTTP 响应。 */
export const WEB_HISTORY_PAGE_MAX = 100;
export const WEB_HISTORY_PAGE_DEFAULT = 40;

/**
 * 会话历史读取：向前翻页（桌面字节游标 / 手机下标游标）与按需取全文。
 *
 * 这些规则原先散在 AgentManager 三个方法里，且每种游标各写一套边界处理：
 * - 桌面游标是**字节偏移**，首屏要回落到文件基线或最旧消息的 entryId；
 * - 手机游标是**数组下标**，越界必须报错而不是静默返回空页；
 * - 全文优先命中运行时缓存，再按 entryId 读文件。
 * 集中后可以用打开的会话文件代替整套 RPC 来测。
 */
export class AgentHistory {
	constructor(private readonly host: AgentHistoryHost) {}

	/**
	 * 向前读取一页更早的会话历史，供活动会话突破尾窗限制。
	 * 只读会话文件并按字节 cursor 反向翻页；消息带 `meta.historyPage`，渲染层据此
	 * 把这些只读旧页与可编辑的尾窗消息区分开（编辑/删除仍按 entryId 定位）。
	 */
	async page(
		agentId: string,
		beforeOffset?: number,
	): Promise<{ messages: ChatMessage[]; cursor: number; hasMore: boolean }> {
		const runtime = this.host.runtime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) return { messages: [], cursor: 0, hasMore: false };
		let cursor = typeof beforeOffset === "number" && Number.isFinite(beforeOffset)
			? Math.max(0, Math.trunc(beforeOffset))
			: undefined;
		// 首次加载没有 cursor：优先用文件基线自己记录的窗口起点（精确到字节），
		// 否则以当前时间线最旧一条消息的 entryId 作为上界。两条路都只返回基线之前
		// 的内容，否则会先返回一页与基线重叠的最近消息，用户点一次却看不到新内容。
		if (cursor === undefined) {
			if (typeof runtime.historyCursor === "number" && runtime.historyCursor >= 0) {
				cursor = runtime.historyCursor;
			} else {
				const oldestEntryId = runtime.transcript.messages
					.map((message) => message.meta?.entryId)
					.find((entryId): entryId is string => typeof entryId === "string" && entryId.length > 0);
				if (oldestEntryId) {
					const offset = await this.host.jsonl.findEntryOffset(sessionPath, oldestEntryId);
					if (offset === undefined) {
						return { messages: [], cursor: 0, hasMore: false };
					}
					cursor = offset;
				}
			}
		}
		const page = await this.host.jsonl.readOlderMessages(sessionPath, cursor, HISTORY_PAGE_TURNS);
		if (page.messages.length === 0) {
			return { messages: [], cursor: page.cursor, hasMore: page.hasMore };
		}
		const messages = convertAgentMessages(agentId, page.messages, page.entryIds, false);
		for (const message of messages) {
			message.meta = { ...message.meta, historyPage: true };
		}
		this.host.log?.info("agent", "Older history page loaded", {
			agentId,
			sessionPath,
			beforeOffset: cursor,
			cursor: page.cursor,
			hasMore: page.hasMore,
			messages: messages.length,
		});
		return { messages, cursor: page.cursor, hasMore: page.hasMore };
	}

	/**
	 * 手机端历史分页：以「从旧到新的数组下标」为游标，每次返回 before 之前的 limit 条。
	 * 必须带 agentId 生成历史消息 id：实时 transcript 也用同一个 agentId 前缀，
	 * 手机端才能把 history-page 与 messages 窗口按 id 去重、按 id 拉完整详情。
	 */
	async webPage(agentId: string, before?: string, limit = WEB_HISTORY_PAGE_DEFAULT): Promise<WebAgentHistoryPage> {
		const runtime = this.host.runtime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) return { messages: [], nextCursor: null, hasMore: false };
		const messages = await this.host.jsonl.readDisplayMessages(sessionPath, agentId);
		const pageSize = Math.min(
			WEB_HISTORY_PAGE_MAX,
			Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : WEB_HISTORY_PAGE_DEFAULT),
		);
		const end = before === undefined || before === "" ? messages.length : Number(before);
		// 越界游标说明客户端拿的是别的会话/旧版本的下标：报错让客户端重置，
		// 而不是静默返回空页（会让手机端以为历史已经读完）。
		if (!Number.isInteger(end) || end < 0 || end > messages.length) {
			throw new Error("历史分页游标无效");
		}
		const start = Math.max(0, end - pageSize);
		return {
			messages: messages.slice(start, end),
			nextCursor: start > 0 ? String(start) : null,
			hasMore: start > 0,
		};
	}

	/**
	 * 按需读取消息完整文本（工具结果截断后的「查看完整输出」）。
	 * 优先运行时全文缓存（仅截断下发时才写入），回退按 entryId 在会话文件里定位；
	 * 都拿不到就抛错，由上游转结构化错误，不能静默返回空文本。
	 */
	async fullText(agentId: string, messageId: string, entryId?: string): Promise<{ text: string }> {
		const runtime = this.host.runtime(agentId);
		const cached = fullTextOf(runtime.transcript, messageId);
		if (cached !== undefined) return { text: cached };
		const sessionPath = runtime.tab.sessionPath;
		if (sessionPath && entryId) {
			const text = await this.host.jsonl.readEntryTextById(sessionPath, entryId);
			if (text !== null) return { text };
		}
		throw new Error("Message full text unavailable");
	}
}
