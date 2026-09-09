import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ConvertedSession, ParsedSession, SourceAdapter } from "../importPipeline";
import {
	accumulateSummary,
	PiJsonlWriter,
	type WalkedMessage,
} from "../importWalk";
import { cleanTitle, extractPiText, makeId, normalizePath } from "../importShared";

/**
 * OpenCode 适配器：从 SQLite 数据库读取会话历史。
 * OpenCode 所有项目的历史集中在同一个 opencode.db 中，
 * discover 按项目路径过滤，sourcePath 用虚拟路径 db#sessionId。
 */

type OpenCodeMessage = {
	id: string;
	time_created: number;
	time_updated: number;
	data: Record<string, unknown>;
	parts: OpenCodePart[];
};

type OpenCodePart = {
	id: string;
	message_id: string;
	time_created: number;
	time_updated: number;
	data: Record<string, unknown>;
};

export class OpenCodeImportAdapter implements SourceAdapter {
	readonly source = "opencode" as const;
	readonly filePrefix = "opencode_";

	private readonly dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	/**
	 * 轻量摘要：分类器 + 统一摘要派生，不构造 pi JSONL 行。
	 * 与 convert 消费同一中间表示——无镜像。
	 */
	summarize(
		projectPath: string,
		session: ParsedSession,
	): { title: string; preview: string; messageCount: number } {
		const summary = accumulateSummary(this.classifyEntries(session));
		const meta = session.meta as Record<string, unknown>;
		return {
			// convert 的 fallback 顺序：meta.title → 首条 user → sourcePath 尾部 → 默认
			title:
				cleanTitle(String(meta.title ?? "")) ||
				summary.title ||
				cleanTitle(session.sourcePath.split("#")[1] ?? session.sourcePath) ||
				"OpenCode 会话",
			preview: summary.preview || "OpenCode imported session",
			messageCount: summary.messageCount,
		};
	}

	/**
	 * 源条目分类器：OpenCode message/parts -> WalkedMessage[]（纯）。
	 * part 组装与 push 过滤规则的唯一事实来源。
	 */
	private classifyEntries(session: ParsedSession): WalkedMessage[] {
		const messages = session.entries as OpenCodeMessage[];
		const walked: WalkedMessage[] = [];
		for (const message of messages) {
			const messageData = message.data as Record<string, unknown>;
			const role = messageData.role as string | undefined;
			const content: unknown[] = [];
			for (const part of message.parts) {
				const partData = part.data as Record<string, unknown>;
				if (partData.type === "text" && partData.text) {
					content.push({ type: "text", text: String(partData.text) });
				} else if (partData.type === "reasoning" && partData.text) {
					content.push({ type: "thinking", thinking: String(partData.text), thinkingSignature: "opencode_reasoning" });
				} else if (partData.type === "tool") {
					if (role === "assistant") {
						content.push({
							type: "toolCall",
							name: String(partData.tool ?? "tool"),
						});
					} else {
						// 非 assistant 的 tool part 即时计一条 toolResult
						walked.push({
							role: "toolResult",
							content: [{ type: "text", text: this.extractToolOutput(partData) }],
							extra: {
								toolCallId: String((partData as Record<string, unknown>).callID ?? part.id),
								toolName: String(partData.tool ?? "tool"),
								isError: (partData.state as Record<string, unknown>)?.status === "error",
							},
							timestampValue: part.time_created,
						});
					}
				}
			}

			if (role === "user" || role === "assistant") {
				walked.push({
					role,
					content,
					extra:
						role === "assistant"
							? {
								api: "opencode-import",
								provider: (messageData.providerID as string) ?? "opencode",
								model: (messageData.modelID as string) ?? "opencode",
								stopReason: (messageData.finish as string) ?? "stop",
								tokens: messageData.tokens,
							}
							: undefined,
					timestampValue: message.time_created,
				});
			}
		}
		return walked;
	}

	async discover(projectPath: string): Promise<ParsedSession[]> {
		const info = await stat(this.dbPath);
		const normalizedProject = normalizePath(projectPath);
		const db = new DatabaseSync(this.dbPath, { readOnly: true });
		try {
			const sessions = db.prepare(`
				select s.*, p.worktree
				from session s
				join project p on p.id = s.project_id
				where lower(replace(p.worktree, '\\', '/')) = lower(?)
				   or lower(replace(s.directory, '\\', '/')) = lower(?)
				   or lower(replace(s.directory, '\\', '/')) like lower(? || '/%')
				order by s.time_updated desc
			`).all(normalizedProject, normalizedProject, normalizedProject) as Array<Record<string, unknown>>;

			return sessions.map((session) => {
				const sessionId = String(session.id);
				const messages = this.readMessages(db, sessionId);
				return {
					id: sessionId,
					sourcePath: `${this.dbPath}#${sessionId}`,
					sourceSize: this.estimateSessionSize(session, messages),
					sourceMtime: info.mtimeMs,
					meta: session,
					entries: messages,
					cwd: String(session.directory ?? projectPath),
					createdAt: Number(session.time_created ?? info.mtimeMs),
					updatedAt: Number(session.time_updated ?? info.mtimeMs),
				};
			});
		} finally {
			db.close();
		}
	}

	convert(projectPath: string, session: ParsedSession): ConvertedSession {
		const sessionId = session.id;
		const meta = session.meta as Record<string, unknown>;
		const timestamp = new Date(Number(meta.time_created ?? session.sourceMtime)).toISOString();
		const model = this.parseModel(meta.model);
		const messages = this.classifyEntries(session);
		const summary = accumulateSummary(messages);

		const writer = new PiJsonlWriter((sequence) => makeId(sessionId, sequence));
		writer.pushHeader({
			sessionId,
			timestamp,
			cwd: projectPath,
			importType: "opencode_import",
			importMeta: {
				openCodeSessionId: sessionId,
				sourcePath: session.sourcePath,
				sourceMtime: session.sourceMtime,
				sourceSize: session.sourceSize,
			},
			provider: String(model.providerID ?? "opencode"),
			model: `${String(model.providerID ?? "opencode")}/${String(model.id ?? model.modelID ?? "opencode")}`,
		});
		for (const message of messages) {
			writer.pushMessage(this.withOpenCodeUsage(message));
		}

		const title =
			cleanTitle(String(meta.title ?? "")) ||
			summary.title ||
			cleanTitle(session.sourcePath.split("#")[1] ?? session.sourcePath) ||
			"OpenCode 会话";
		writer.insertAt(1, { sessionName: title, cwd: projectPath });
		return {
			raw: writer.build(),
			title,
			preview: summary.preview || "OpenCode imported session",
			messageCount: summary.messageCount,
		};
	}

	/**
	 * assistant 消息的 tokens 换算为 usage 占位（pi 上下文统计读
	 * assistant.usage.totalTokens）。usage 拼装逻辑是 opencode 特有的 toUsage，
	 * 保留在此；claude/codex 走各自 extra。
	 */
	private withOpenCodeUsage(message: WalkedMessage): WalkedMessage {
		if (message.role !== "assistant") return message;
		const tokens = (message.extra as Record<string, unknown> | undefined)?.tokens;
		return {
			...message,
			extra: { usage: this.toUsage(tokens), ...(message.extra ?? {}) },
		};
	}

	// ── 私有：SQLite 读取 ─────────────────────────────────

	private readMessages(db: DatabaseSync, sessionId: string): OpenCodeMessage[] {
		const messages = db.prepare(
			"select id, time_created, time_updated, data from message where session_id = ? order by time_created asc",
		).all(sessionId) as Array<Record<string, unknown>>;
		const parts = db.prepare(
			"select id, message_id, session_id, time_created, time_updated, data from part where session_id = ? order by time_created asc",
		).all(sessionId) as Array<Record<string, unknown>>;

		const partsByMessage = new Map<string, OpenCodePart[]>();
		for (const part of parts) {
			const parsedPart = { ...part, data: this.parseJson(part.data) } as OpenCodePart;
			const current = partsByMessage.get(parsedPart.message_id) ?? [];
			current.push(parsedPart);
			partsByMessage.set(parsedPart.message_id, current);
		}

		return messages.map((message) => ({
			id: String(message.id),
			time_created: Number(message.time_created),
			time_updated: Number(message.time_updated),
			data: this.parseJson(message.data),
			parts: partsByMessage.get(String(message.id)) ?? [],
		}));
	}

	// ── 私有：格式解析 ─────────────────────────────────────

	private parseJson(value: unknown): Record<string, unknown> {
		if (typeof value !== "string") return value && typeof value === "object" ? value as Record<string, unknown> : {};
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}

	private estimateSessionSize(meta: Record<string, unknown>, messages: OpenCodeMessage[]): number {
		return Buffer.byteLength(JSON.stringify({ meta, messages }), "utf8");
	}

	private parseModel(value: unknown): Record<string, unknown> {
		if (typeof value === "string") return this.parseJson(value);
		return value && typeof value === "object" ? value as Record<string, unknown> : {};
	}

	private toUsage(tokens: unknown) {
		const t = tokens as Record<string, unknown> | undefined;
		const cache = t?.cache as Record<string, unknown> | undefined;
		return {
			input: Number(t?.input ?? 0),
			output: Number(t?.output ?? 0),
			cacheRead: Number(cache?.read ?? 0),
			cacheWrite: Number(cache?.write ?? 0),
			totalTokens: Number(t?.total ?? 0),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	/**
	 * OpenCode 工具输出格式：state.output / state.error / part.output
	 * 与 Claude/Codex 的 payload 形状不同，每适配器保留自己的实现。
	 */
	private extractToolOutput(part: Record<string, unknown>): string {
		const state = (part.state ?? {}) as Record<string, unknown>;
		const output = state.output ?? state.error ?? part.output ?? "";
		if (typeof output === "string") return output;
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
	}
}
