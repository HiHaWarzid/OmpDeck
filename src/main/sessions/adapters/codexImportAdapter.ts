import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { getCodexSessionThreadInfo } from "../../../shared/codexSessionMeta";
import type { ConvertedSession, ParsedSession, SourceAdapter } from "../importPipeline";
import {
	accumulateSummary,
	PiJsonlWriter,
	type WalkedMessage,
} from "../importWalk";
import { cleanTitle, extractPiText, hash, makeId, normalizePath, zeroUsage } from "../importShared";

/**
 * Codex 适配器：从 ~/.codex/sessions/ 下的 JSONL 文件读取会话。
 * discover 扫描全部 session 文件后按 cwd 过滤。
 * Codex 特有：线程元数据（子代理溯源）和 reasoning 累积（pendingThinking）。
 */

type ParsedCodexSession = {
	meta: Record<string, unknown>;
	entries: Array<Record<string, unknown>>;
};

export class CodexImportAdapter implements SourceAdapter {
	readonly source = "codex" as const;
	readonly filePrefix = "codex_";

	private readonly codexRoot: string;

	constructor(codexRoot: string) {
		this.codexRoot = codexRoot;
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
		return {
			title: summary.title || cleanTitle(basename(session.sourcePath)) || "Codex 会话",
			preview: summary.preview || "Codex imported session",
			messageCount: summary.messageCount,
		};
	}

	/**
	 * 源条目分类器：Codex JSONL 条目 -> WalkedMessage[]（纯）。
	 * reasoning 累积（pendingThinking）与 toolCall 映射的唯一事实来源。
	 */
	private classifyEntries(session: ParsedSession): WalkedMessage[] {
		const entries = session.entries as Array<Record<string, unknown>>;
		const messages: WalkedMessage[] = [];
		let pendingThinking = "";

		for (const entry of entries) {
			if (
				entry.type === "event_msg" &&
				(entry.payload as Record<string, unknown> | undefined)?.type === "user_message"
			) {
				const payload = entry.payload as Record<string, unknown>;
				const text = String(payload.message ?? "").trim();
				if (text) {
					messages.push({
						role: "user",
						content: [{ type: "text", text }],
						timestampValue: this.timestampOf(entry.timestamp),
					});
				}
				continue;
			}
			if (entry.type !== "response_item") continue;
			const payload = (entry.payload ?? {}) as Record<string, unknown>;

			if (payload.type === "reasoning") {
				const reasoning = this.extractCodexText(payload).trim();
				if (reasoning) pendingThinking = this.joinText(pendingThinking, reasoning);
				continue;
			}

			if (payload.type === "message" && payload.role === "assistant") {
				const text = this.extractCodexText(payload).trim();
				messages.push({
					role: "assistant",
					content: [
						...(pendingThinking
							? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]
							: []),
						...(text ? [{ type: "text", text }] : []),
					],
				});
				pendingThinking = "";
				continue;
			}

			if (payload.type === "function_call") {
				pendingThinking = "";
				// convert 中 content 含 toolCall（name 参与 extractPiText），恒非空必计数
				messages.push({
					role: "assistant",
					content: [{ type: "toolCall", name: String(payload.name ?? "tool") }],
					extra: this.functionCallExtra(session, payload),
				});
				continue;
			}

			if (payload.type === "function_call_output") {
				const output = this.extractToolOutput(payload);
				messages.push({
					role: "toolResult",
					content: [{ type: "text", text: output }],
					extra: this.functionCallOutputExtra(session, entry, payload),
					timestampValue: this.timestampOf(entry.timestamp),
				});
			}
		}

		if (pendingThinking) {
			messages.push({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" },
				],
			});
		}
		return messages;
	}

	/** function_call 的附加字段（派生耗时/工具名）：writer 落盘用。 */
	private functionCallExtra(
		session: ParsedSession,
		payload: Record<string, unknown>,
	): Record<string, unknown> {
		const sessionId = String(session.meta.id ?? hash(session.sourcePath));
		const callId = String(payload.call_id ?? payload.id ?? makeId(sessionId, 0));
		const meta = session.meta;
		return {
			id: callId,
			api: "codex-import",
			provider: String(meta.model_provider ?? "codex"),
			model: String(meta.model ?? "codex"),
			stopReason: "toolUse",
		};
	}

	/** function_call_output 的附加字段（工具名回填 + 派生耗时）：writer 落盘用。 */
	private functionCallOutputExtra(
		session: ParsedSession,
		entry: Record<string, unknown>,
		payload: Record<string, unknown>,
	): Record<string, unknown> {
		const sessionId = String(session.meta.id ?? hash(session.sourcePath));
		const callId = String(payload.call_id ?? payload.id ?? makeId(sessionId, 0));
		const completedAt = this.parseTimestamp(entry.timestamp);
		return {
			toolCallId: callId,
			toolName: String(payload.name ?? "tool"),
			isError: Boolean(payload.is_error),
			...(completedAt !== undefined ? { completedAt } : {}),
		};
	}

	/** 源条目时间戳归一化：parseTimestamp 失败 → undefined（writer 回退）。 */
	private timestampOf(value: unknown): number | undefined {
		return this.parseTimestamp(value);
	}

	async discover(projectPath: string): Promise<ParsedSession[]> {
		const files = await this.collectJsonl(this.codexRoot).catch(() => []);
		const sessions = await Promise.all(
			files.map(async (file) => {
				try {
					const parsed = await this.readCodexSession(file);
					const info = await stat(file);
					return { parsed, sourceSize: info.size, sourceMtime: info.mtimeMs, sourcePath: file };
				} catch {
					return null;
				}
			}),
		);

		const normalizedProject = normalizePath(projectPath);

		return sessions
			.filter((s): s is NonNullable<typeof s> => Boolean(s))
			.filter((s) => normalizePath(s.parsed.meta.cwd as string) === normalizedProject)
			.map(({ parsed, sourceSize, sourceMtime, sourcePath }) => {
				const threadInfo = getCodexSessionThreadInfo(parsed.meta);
				const originalTimestamp =
					Date.parse(String(parsed.meta.timestamp ?? "")) || sourceMtime;
				return {
					id: String(parsed.meta.id ?? sourcePath),
					sourcePath,
					sourceSize,
					sourceMtime,
					meta: parsed.meta,
					entries: parsed.entries,
					cwd: String(parsed.meta.cwd ?? ""),
					createdAt: originalTimestamp,
					updatedAt: originalTimestamp,
					threadSource: threadInfo.threadSource,
					parentThreadId: threadInfo.parentThreadId,
					agentRole: threadInfo.agentRole,
					agentNickname: threadInfo.agentNickname,
				};
			});
	}

	convert(projectPath: string, session: ParsedSession): ConvertedSession {
		const meta = session.meta;
		const sessionId = String(meta.id ?? hash(session.sourcePath));
		const threadInfo = getCodexSessionThreadInfo(meta);
		const timestamp = new Date(
			Date.parse(String(meta.timestamp ?? "")) || session.sourceMtime,
		).toISOString();
		const messages = this.classifyEntries(session);
		const summary = accumulateSummary(messages);

		const writer = new PiJsonlWriter((sequence) => makeId(sessionId, sequence));
		writer.pushHeader({
			sessionId,
			timestamp,
			cwd: projectPath,
			importType: "codex_import",
			importMeta: {
				codexSessionId: sessionId,
				sourcePath: session.sourcePath,
				sourceMtime: session.sourceMtime,
				sourceSize: session.sourceSize,
				threadSource: threadInfo.threadSource,
				parentThreadId: threadInfo.parentThreadId,
				agentRole: threadInfo.agentRole,
				agentNickname: threadInfo.agentNickname,
			},
			provider: String(meta.model_provider ?? "codex"),
			model: `${String(meta.model_provider ?? "codex")}/${String(meta.model ?? "codex")}`,
		});
		for (const message of messages) {
			writer.pushMessage(this.withCodexUsage(message, session));
		}

		const title =
			summary.title || cleanTitle(basename(session.sourcePath)) || "Codex 会话";
		writer.insertAt(1, { sessionName: title, cwd: projectPath });

		return {
			raw: writer.build(),
			title,
			preview: summary.preview || "Codex imported session",
			messageCount: summary.messageCount,
		};
	}

	/**
	 * assistant 消息补 usage 零值占位（pi 上下文统计读 assistant.usage.totalTokens；
	 * Codex 原始历史无该字段）。opencode 在 extra 里自带 tokens，claude 的 extra
	 * 已含占位——只有 codex 需要在此统一补。
	 */
	private withCodexUsage(message: WalkedMessage, session: ParsedSession): WalkedMessage {
		if (message.role !== "assistant") return message;
		return {
			...message,
			extra: { usage: zeroUsage(), ...(message.extra ?? {}) },
		};
	}

	// ── 私有：源文件读取 ───────────────────────────────────

	private async readCodexSession(filePath: string): Promise<ParsedCodexSession> {
		this.assertCodexSourcePath(filePath);
		const raw = await readFile(filePath, "utf8");
		const entries = raw
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const metaEntry = entries.find((entry) => entry.type === "session_meta");
		const meta = (metaEntry?.payload ?? {}) as Record<string, unknown>;
		if (!meta?.id || !meta?.cwd) throw new Error("Missing Codex session metadata");
		return { meta, entries };
	}

	private assertCodexSourcePath(filePath: string) {
		const root = normalizePath(this.codexRoot);
		const target = normalizePath(filePath);
		if (target !== root && !target.startsWith(`${root}/`)) {
			throw new Error("Codex session path is outside ~/.codex/sessions");
		}
	}

	private async collectJsonl(dir: string): Promise<string[]> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			const files: string[] = [];
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) files.push(...(await this.collectJsonl(path)));
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
			}
			return files;
		} catch {
			return [];
		}
	}

	// ── 私有：格式解析 ─────────────────────────────────────

	private extractCodexText(payload: Record<string, unknown>): string {
		const content = payload.content ?? payload.summary ?? payload.text ?? payload.output;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((item) => {
				if (typeof item === "string") return item;
				if (!item || typeof item !== "object") return "";
				const obj = item as Record<string, unknown>;
				return String(obj.text ?? obj.message ?? obj.content ?? "");
			})
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * Codex 工具输出格式：payload.output / payload.content，委托 extractCodexText 处理数组。
	 * 与 OpenCode/Claude 的 payload 形状不同，每适配器保留自己的实现。
	 */
	private extractToolOutput(payload: Record<string, unknown>): string {
		const output = payload.output ?? payload.content;
		if (typeof output === "string") return output;
		if (Array.isArray(output)) return this.extractCodexText({ content: output });
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
	}

	private parseArguments(value: unknown): unknown {
		if (typeof value !== "string") return value ?? {};
		try {
			return JSON.parse(value);
		} catch {
			return { input: value };
		}
	}

	private parseTimestamp(value: unknown): number | undefined {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "string") return undefined;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private joinText(a: string, b: string): string {
		if (!a) return b;
		if (!b) return a;
		return `${a}\n\n${b}`;
	}
}
