import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ConvertedSession, ParsedSession, SourceAdapter } from "../importPipeline";
import {
	cleanTitle,
	extractPiText,
	makeId,
	normalizePath,
	zeroUsage,
} from "../importShared";

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

	constructor(private readonly dbPath: string) {}

	/**
	 * 轻量摘要：只提取 title/preview/messageCount，不构造 pi JSONL 行。
	 * 逐条镜像 convert 的 part 组装与 pushMessage 过滤规则（tool part 在非
	 * assistant role 下即时计数、toolCall 的 name 参与 extractPiText）。
	 */
	summarize(
		projectPath: string,
		session: ParsedSession,
	): { title: string; preview: string; messageCount: number } {
		const messages = session.entries as OpenCodeMessage[];
		const titleState = { title: "", preview: "" };
		let messageCount = 0;

		const pushMessageLike = (role: "user" | "assistant" | "toolResult", content: unknown[]) => {
			if (content.length === 0) return;
			messageCount += 1;
			const text = extractPiText(content).trim();
			if (text && !titleState.preview) titleState.preview = text.slice(0, 160);
			if (role === "user" && text && !titleState.title) titleState.title = cleanTitle(text);
		};

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
						// 与 convert 一致：非 assistant 的 tool part 立即计一条 toolResult
						pushMessageLike("toolResult", [
							{ type: "text", text: this.extractToolOutput(partData) },
						]);
					}
				}
			}

			if (role === "user") {
				pushMessageLike("user", content);
			} else if (role === "assistant") {
				pushMessageLike("assistant", content);
			}
		}

		const meta = session.meta as Record<string, unknown>;
		return {
			// 与 convert 的 fallback 顺序完全一致：meta.title → 首条 user → sourcePath 尾部 → 默认
			title:
				cleanTitle(String(meta.title ?? "")) ||
				titleState.title ||
				cleanTitle(session.sourcePath.split("#")[1] ?? session.sourcePath) ||
				"OpenCode 会话",
			preview: titleState.preview || "OpenCode imported session",
			messageCount,
		};
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
		const messages = session.entries as OpenCodeMessage[];
		const titleState = { title: "", preview: "" };
		const lines: string[] = [];
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;

		const pushEntry = (entry: Record<string, unknown>) => lines.push(JSON.stringify(entry));
		const pushMessage = (
			role: "user" | "assistant" | "toolResult",
			content: unknown[],
			extra: Record<string, unknown> = {},
			timestampValue?: number,
		) => {
			if (content.length === 0) return;
			const id = makeId(sessionId, sequence++);
			const messageTimestamp = Number(timestampValue ?? session.sourceMtime + sequence);
			pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: new Date(messageTimestamp).toISOString(),
				message: {
					role,
					content,
					timestamp: messageTimestamp,
					...(role === "assistant" ? { usage: this.toUsage((extra as Record<string, unknown>).tokens) } : {}),
					...extra,
				},
			});
			parentId = id;
			messageCount += 1;

			const text = extractPiText(content).trim();
			if (text && !titleState.preview) titleState.preview = text.slice(0, 160);
			if (role === "user" && text && !titleState.title) titleState.title = cleanTitle(text);
		};

		pushEntry({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectPath });
		pushEntry({
			type: "opencode_import",
			version: 1,
			openCodeSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
		});
		const modelChangeId = makeId(sessionId, sequence++);
		pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: model.providerID || "opencode",
			model: `${model.providerID || "opencode"}/${model.id || model.modelID || "opencode"}`,
		});
		parentId = modelChangeId;

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
					const toolCallId = String(partData.callID ?? part.id);
					if (role === "assistant") {
						content.push({
							type: "toolCall",
							id: toolCallId,
							name: String(partData.tool ?? "tool"),
							arguments: (partData.state as Record<string, unknown>)?.input ?? {},
						});
					} else {
						pushMessage(
							"toolResult",
							[{ type: "text", text: this.extractToolOutput(partData) }],
							{
								toolCallId,
								toolName: String(partData.tool ?? "tool"),
								isError: (partData.state as Record<string, unknown>)?.status === "error",
							},
							part.time_created,
						);
					}
				}
			}

			if (role === "user") {
				pushMessage("user", content, {}, message.time_created);
			} else if (role === "assistant") {
				pushMessage(
					"assistant",
					content,
					{
						api: "opencode-import",
						provider: (messageData.providerID as string) ?? model.providerID ?? "opencode",
						model: (messageData.modelID as string) ?? model.id ?? model.modelID ?? "opencode",
						stopReason: (messageData.finish as string) ?? "stop",
						tokens: messageData.tokens,
					},
					message.time_created,
				);
			}
		}

		const title =
			cleanTitle(String(meta.title ?? "")) ||
			titleState.title ||
			cleanTitle(session.sourcePath.split("#")[1] ?? session.sourcePath) ||
			"OpenCode 会话";
		lines.splice(1, 0, JSON.stringify({ sessionName: title, cwd: projectPath }));
		return {
			raw: `${lines.join("\n")}\n`,
			title,
			preview: titleState.preview || "OpenCode imported session",
			messageCount,
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
