import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { getCodexSessionThreadInfo } from "../../../shared/codexSessionMeta";
import type { ConvertedSession, ParsedSession, SourceAdapter } from "../importPipeline";
import {
	cleanTitle,
	extractPiText,
	hash,
	makeId,
	normalizePath,
	zeroUsage,
} from "../importShared";

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

	constructor(private readonly codexRoot: string) {}

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
		const entries = session.entries as Array<Record<string, unknown>>;
		const sessionId = String(meta.id ?? hash(session.sourcePath));
		const threadInfo = getCodexSessionThreadInfo(meta);
		const timestamp = new Date(
			Date.parse(String(meta.timestamp ?? "")) || session.sourceMtime,
		).toISOString();
		const titleState = { title: "", preview: "" };
		const toolNames = new Map<string, string>();
		const toolStartedAt = new Map<string, number>();
		const lines: string[] = [];
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;
		let pendingThinking = "";

		const pushEntry = (entry: Record<string, unknown>) => {
			lines.push(JSON.stringify(entry));
		};
		const pushMessage = (
			role: "user" | "assistant" | "toolResult",
			content: unknown[],
			extra: Record<string, unknown> = {},
			timestampValue?: unknown,
		) => {
			if (content.length === 0) return;
			const id = makeId(sessionId, sequence++);
			const messageTimestamp = this.parseTimestamp(timestampValue) ?? session.sourceMtime + sequence;
			const ts = new Date(messageTimestamp).toISOString();
			pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: ts,
				message: {
					role,
					content,
					timestamp: messageTimestamp,
					// pi 的上下文统计会读取 assistant.usage.totalTokens；Codex 原始历史没有该字段，导入时用 0 值占位保证可继续对话。
					...(role === "assistant" ? { usage: zeroUsage() } : {}),
					...extra,
				},
			});
			parentId = id;
			messageCount += 1;

			const text = extractPiText(content).trim();
			if (text && !titleState.preview) titleState.preview = text.slice(0, 160);
			if (role === "user" && text && !titleState.title) {
				titleState.title = cleanTitle(text);
			}
		};

		pushEntry({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp,
			cwd: projectPath,
		});
		pushEntry({
			type: "codex_import",
			version: 1,
			codexSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
			threadSource: threadInfo.threadSource,
			parentThreadId: threadInfo.parentThreadId,
			agentRole: threadInfo.agentRole,
			agentNickname: threadInfo.agentNickname,
		});
		const modelChangeId = makeId(sessionId, sequence++);
		pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: String(meta.model_provider ?? "codex"),
			model: `${String(meta.model_provider ?? "codex")}/${String(meta.model ?? "codex")}`,
		});
		parentId = modelChangeId;

		for (const entry of entries) {
			if (entry.type === "event_msg" && (entry.payload as Record<string, unknown> | undefined)?.type === "user_message") {
				const payload = entry.payload as Record<string, unknown>;
				const text = String(payload.message ?? "").trim();
				if (text) pushMessage("user", [{ type: "text", text }], {}, entry.timestamp);
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
				const content = [
					...(pendingThinking
						? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]
						: []),
					...(text ? [{ type: "text", text }] : []),
				];
				pendingThinking = "";
				pushMessage(
					"assistant",
					content,
					{
						api: "codex-import",
						provider: String(meta.model_provider ?? "codex"),
						model: String(meta.model ?? "codex"),
						stopReason: "stop",
					},
					entry.timestamp,
				);
				continue;
			}

			if (payload.type === "function_call") {
				const callId = String(payload.call_id ?? payload.id ?? makeId(sessionId, sequence));
				const toolName = String(payload.name ?? "tool");
				toolNames.set(callId, toolName);
				const callStartedAt = this.parseTimestamp(entry.timestamp);
				if (callStartedAt !== undefined) toolStartedAt.set(callId, callStartedAt);
				const args = this.parseArguments(payload.arguments);
				const content = [
					...(pendingThinking
						? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]
						: []),
					{ type: "toolCall", id: callId, name: toolName, arguments: args },
				];
				pendingThinking = "";
				pushMessage(
					"assistant",
					content,
					{
						api: "codex-import",
						provider: String(meta.model_provider ?? "codex"),
						model: String(meta.model ?? "codex"),
						stopReason: "toolUse",
					},
					entry.timestamp,
				);
				continue;
			}

			if (payload.type === "function_call_output") {
				const callId = String(payload.call_id ?? payload.id ?? makeId(sessionId, sequence));
				const output = this.extractToolOutput(payload);
				const completedAt = this.parseTimestamp(entry.timestamp);
				const startedAt = toolStartedAt.get(callId);
				pushMessage(
					"toolResult",
					[{ type: "text", text: output }],
					{
						toolCallId: callId,
						toolName: toolNames.get(callId) ?? "tool",
						isError: Boolean(payload.is_error),
						// Codex 历史只有 function_call / output 时间戳，导入时保存派生耗时，
						// 让桌面端工具卡片与原生 pi 会话保持一致。
						...(startedAt !== undefined ? { startedAt } : {}),
						...(startedAt !== undefined && completedAt !== undefined
							? { durationMs: Math.max(0, completedAt - startedAt) }
							: {}),
					},
					entry.timestamp,
				);
			}
		}

		// 处理最后未flush的 reasoning
		if (pendingThinking) {
			pushMessage("assistant", [
				{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" },
			]);
		}

		const title = titleState.title || cleanTitle(basename(session.sourcePath)) || "Codex 会话";
		lines.splice(1, 0, JSON.stringify({ sessionName: title, cwd: projectPath }));

		return {
			raw: `${lines.join("\n")}\n`,
			title,
			preview: titleState.preview || "Codex imported session",
			messageCount,
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
