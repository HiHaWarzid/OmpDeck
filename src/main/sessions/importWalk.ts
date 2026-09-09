import { cleanTitle, extractPiText } from "./importShared";

/**
 * 导入适配器共享的条目分类器（walker）+ pi JSONL 写入器（候选 7）。
 *
 * 背景：三个适配器（claude/codex/opencode）各自手写了一遍"首段文本遍历"
 * （title/preview/messageCount）且 summarize 与 convert 逐条镜像、由对照测试
 * 兜底。本模块把逐源的"条目形状映射"（classifier）与"pi JSONL 骨架"
 * （writer）拆开：
 *
 * - classifier：源条目 -> WalkedMessage[]（role + content + extra + ts），纯；
 *   title/preview/count 的派生规则一次实现（accumulateSummary），summarize 与
 *   convert 消费同一中间表示——镜像在结构上不可能。
 * - writer：session 头 + import marker + model_change + parentId/sequence 链，
 *   适配器只给 header 专属字段与 model 字段。
 */

export type WalkedRole = "user" | "assistant" | "toolResult";

export interface WalkedMessage {
	role: WalkedRole;
	content: unknown[];
	extra?: Record<string, unknown>;
	/** 源条目时间戳（未知形状时由调用方归一化为 number）；undefined = writer 回退 */
	timestampValue?: number;
}

export interface WalkSummary {
	title: string;
	preview: string;
	messageCount: number;
}

/**
 * 对分类后的消息做统一的 title/preview/count 派生：
 * - 空 content 不计数；
 * - 首个非空文本取 preview（160 字符）；
 * - 首条 user 非空文本取 title。
 */
export function accumulateSummary(messages: WalkedMessage[]): WalkSummary {
	let title = "";
	let preview = "";
	let messageCount = 0;
	for (const message of messages) {
		if (message.content.length === 0) continue;
		messageCount += 1;
		const text = extractPiText(message.content).trim();
		if (text && !preview) preview = text.slice(0, 160);
		if (message.role === "user" && text && !title) title = cleanTitle(text);
	}
	return { title, preview, messageCount };
}

export interface PiJsonlHeader {
	sessionId: string;
	timestamp: string;
	cwd: string;
	importType: "claude_import" | "codex_import" | "opencode_import";
	importMeta: Record<string, unknown>;
	provider: string;
	model: string;
}

export interface WrittenMessage {
	id: string;
	parentId: string | null;
	timestamp: string;
	entry: Record<string, unknown>;
}

/**
 * pi JSONL 写入器骨架：header 三段（session / import marker / model_change，
 * id=`makeId` 序列）+ parentId 链。与三适配器原 pushEntry/pushMessage
 * 逐字同构；唯一特异是 assistant 的 usage 占位（opencode 传 tokens，
 * claude/codex 传零值占位）。
 */
export class PiJsonlWriter {
	private readonly lines: string[] = [];
	private parentId: string | null = null;
	private sequence = 0;
	private messageCount = 0;

	constructor(
		private readonly makeEntryId: (sequence: number) => string,
		private readonly nowIso: () => string = () => new Date().toISOString(),
	) {}

	get count(): number {
		return this.messageCount;
	}

	pushRaw(entry: Record<string, unknown>): void {
		this.lines.push(JSON.stringify(entry));
	}

	pushHeader(header: PiJsonlHeader): void {
		this.pushRaw({
			type: "session",
			version: 3,
			id: header.sessionId,
			timestamp: header.timestamp,
			cwd: header.cwd,
		});
		this.pushRaw({
			type: header.importType,
			version: 1,
			...header.importMeta,
			importedAt: this.nowIso(),
		});
		const modelChangeId = this.makeEntryId(this.sequence++);
		this.pushRaw({
			type: "model_change",
			id: modelChangeId,
			parentId: this.parentId,
			timestamp: header.timestamp,
			provider: header.provider,
			model: header.model,
		});
		this.parentId = modelChangeId;
	}

	pushMessage(message: WalkedMessage): WrittenMessage | undefined {
		if (message.content.length === 0) return undefined;
		const id = this.makeEntryId(this.sequence++);
		const timestampValue = message.timestampValue ?? Date.now() + this.sequence;
		const entry = {
			type: "message",
			id,
			parentId: this.parentId,
			timestamp: new Date(timestampValue).toISOString(),
			message: {
				role: message.role,
				content: message.content,
				timestamp: timestampValue,
				...(message.extra ?? {}),
			},
		};
		this.pushRaw(entry);
		this.parentId = id;
		this.messageCount += 1;
		return { id, parentId: this.parentId, timestamp: entry.timestamp, entry };
	}

	/** 在指定行号插入条目（sessionName 头插 used）。 */
	insertAt(index: number, entry: Record<string, unknown>): void {
		this.lines.splice(index, 0, JSON.stringify(entry));
	}

	build(): string {
		return `${this.lines.join("\n")}\n`;
	}
}
