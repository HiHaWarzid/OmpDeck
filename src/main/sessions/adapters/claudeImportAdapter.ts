import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ConvertedSession, ParsedSession, SourceAdapter } from "../importPipeline";
import {
	accumulateSummary,
	PiJsonlWriter,
	type WalkedMessage,
} from "../importWalk";
import { cleanTitle, extractPiText, makeId, normalizePath, zeroUsage } from "../importShared";

/**
 * Claude 适配器：从 ~/.claude/projects/<project-dir>/ 下的 JSONL 文件读取会话。
 * discover 递归扫描目录，每个 .jsonl 文件是一个会话。
 */

type ParsedClaudeSession = {
	meta: {
		sessionId: string;
		cwd: string;
		firstTimestamp: number;
		lastTimestamp: number;
	};
	entries: Array<Record<string, unknown>>;
};
export class ClaudeImportAdapter implements SourceAdapter {
	readonly source = "claude" as const;
	readonly filePrefix = "claude_";

	private readonly claudeRoot: string;

	constructor(claudeRoot: string) {
		this.claudeRoot = claudeRoot;
	}

	/**
	 * 轻量摘要：分类器 + unify 摘要派生，不构造 pi JSONL 行。
	 * 与 convert 消费同一中间表示（classifyClaudeEntries）——无镜像。
	 */
	summarize(
		projectPath: string,
		session: ParsedSession,
	): { title: string; preview: string; messageCount: number } {
		const summary = accumulateSummary(this.classifyEntries(session));
		return {
			title: summary.title || cleanTitle(basename(session.sourcePath)) || "Claude 会话",
			preview: summary.preview || "Claude imported session",
			messageCount: summary.messageCount,
		};
	}

	/**
	 * 源条目分类器：Claude JSONL 条目 -> WalkedMessage[]（纯）。
	 * 过滤/提取规则的唯一事实来源；convert 的行构造与 summarize 的计数都走它。
	 */
	private classifyEntries(session: ParsedSession): WalkedMessage[] {
		const entries = session.entries as Array<Record<string, unknown>>;
		const messages: WalkedMessage[] = [];
		for (const entry of entries) {
			// 跳过非消息类型
			if (entry.type === "file-history-snapshot") continue;
			if (entry.type === "system" && entry.subtype === "turn_duration") continue;
			if (entry.type === "system" && entry.subtype === "api_error") continue;

			if (entry.type === "user") {
				const message = entry.message as Record<string, unknown> | undefined;
				const text = String(message?.content ?? "").trim();
				if (text) {
					messages.push({
						role: "user",
						content: [{ type: "text", text }],
						timestampValue: this.timestampOf(entry.timestamp),
					});
				}
				continue;
			}

			if (entry.type === "assistant") {
				const message = entry.message as Record<string, unknown> | undefined;
				if (!message) continue;

				const content: unknown[] = [];
				const msgContent = message.content;
				if (Array.isArray(msgContent)) {
					for (const item of msgContent as Array<Record<string, unknown>>) {
						if (item.type === "text") {
							content.push({ type: "text", text: item.text });
						} else if (item.type === "thinking") {
							content.push({
								type: "thinking",
								thinking: item.thinking,
								thinkingSignature: "claude_thinking",
							});
						} else if (item.type === "tool_use") {
							content.push({
								type: "toolCall",
								id: item.id,
								name: item.name,
								arguments: item.input,
							});
						}
					}
				}

				if (content.length > 0) {
					messages.push({
						role: "assistant",
						content,
						extra: {
							api: "claude-import",
							provider: "anthropic",
							model: (message.model as string) || "claude-sonnet-4",
							stopReason: (message.stop_reason as string) || "stop",
							usage: zeroUsage(),
						},
						timestampValue: this.timestampOf(entry.timestamp),
					});
				}
				continue;
			}

			// 处理工具结果
			if (entry.type === "tool_result") {
				const toolCallId = String(entry.tool_use_id ?? "");
				const output = this.extractToolOutput(entry);
				messages.push({
					role: "toolResult",
					content: [{ type: "text", text: output }],
					extra: {
						toolCallId,
						toolName: "tool",
						isError: Boolean(entry.is_error),
					},
					timestampValue: this.timestampOf(entry.timestamp),
				});
			}
		}
		return messages;
	}

	/** 源条目时间戳归一化：字符串 ISO → ms；未知形状 → undefined（writer 回退）。 */
	private timestampOf(value: unknown): number | undefined {
		if (typeof value === "string" && value) {
			const parsed = Date.parse(value);
			return Number.isNaN(parsed) ? undefined : parsed;
		}
		return undefined;
	}


	convert(projectPath: string, session: ParsedSession): ConvertedSession {
		const meta = session.meta as unknown as ParsedClaudeSession["meta"];
		const sessionId = meta.sessionId;
		const timestamp = new Date(meta.firstTimestamp).toISOString();
		const messages = this.classifyEntries(session);
		const summary = accumulateSummary(messages);

		const writer = new PiJsonlWriter((sequence) => makeId(sessionId, sequence));
		writer.pushHeader({
			sessionId,
			timestamp,
			cwd: projectPath,
			importType: "claude_import",
			importMeta: {
				claudeSessionId: sessionId,
				sourcePath: session.sourcePath,
				sourceMtime: session.sourceMtime,
				sourceSize: session.sourceSize,
			},
			provider: "anthropic",
			model: "anthropic/claude-sonnet-4",
		});
		for (const message of messages) writer.pushMessage(message);

		const title =
			summary.title || cleanTitle(basename(session.sourcePath)) || "Claude 会话";
		writer.insertAt(1, { sessionName: title, cwd: projectPath });

		return {
			raw: writer.build(),
			title,
			preview: summary.preview || "Claude imported session",
			messageCount: summary.messageCount,
		};
	}

	// ── 私有：源文件读取 ───────────────────────────────────

	/**
	 * discover 需要返回 sourceSize/sourceMtime，但 ParsedSession 接口要求这两个字段。
	 * 这里重写 discover 逻辑，在 readClaudeSession 中同时返回文件 stat 信息。
	 */
	async discover(projectPath: string): Promise<ParsedSession[]> {
		const projectDir = this.getClaudeProjectDir(projectPath);
		const files = await this.collectJsonl(projectDir).catch(() => []);
		const sessions = await Promise.all(
			files.map(async (file) => {
				try {
					const parsed = await this.readClaudeSession(file);
					const info = await stat(file);
					return { parsed, sourceSize: info.size, sourceMtime: info.mtimeMs, sourcePath: file };
				} catch {
					return null;
				}
			}),
		);

		return sessions
			.filter((s): s is NonNullable<typeof s> => Boolean(s))
			.map(({ parsed, sourceSize, sourceMtime, sourcePath }) => ({
				id: parsed.meta.sessionId,
				sourcePath,
				sourceSize,
				sourceMtime,
				meta: parsed.meta as unknown as Record<string, unknown>,
				entries: parsed.entries,
				cwd: parsed.meta.cwd,
				createdAt: parsed.meta.firstTimestamp,
				updatedAt: parsed.meta.lastTimestamp,
			}));
	}

	private async readClaudeSession(filePath: string): Promise<ParsedClaudeSession> {
		this.assertClaudeSourcePath(filePath);
		const raw = await readFile(filePath, "utf8");
		const entries = raw
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		// 从第一个 user 消息中提取元数据
		const firstUserEntry = entries.find((e) => e.type === "user");
		if (!firstUserEntry?.sessionId || !firstUserEntry?.cwd) {
			throw new Error("Missing Claude session metadata");
		}

		const timestamps = entries
			.filter((e) => e.timestamp)
			.map((e) => new Date(e.timestamp as string).getTime());

		return {
			meta: {
				sessionId: firstUserEntry.sessionId as string,
				cwd: firstUserEntry.cwd as string,
				firstTimestamp: Math.min(...timestamps),
				lastTimestamp: Math.max(...timestamps),
			},
			entries,
		};
	}

	private assertClaudeSourcePath(filePath: string) {
		const root = normalizePath(this.claudeRoot);
		const target = normalizePath(filePath);
		if (target !== root && !target.startsWith(`${root}/`)) {
			throw new Error("Claude session path is outside ~/.claude/projects");
		}
	}

	private async collectJsonl(dir: string): Promise<string[]> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			const files: string[] = [];
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					files.push(...(await this.collectJsonl(path)));
				} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					files.push(path);
				}
			}
			return files;
		} catch {
			return [];
		}
	}

	private getClaudeProjectDir(projectPath: string): string {
		// 将项目路径转换为 Claude 的目录名格式
		// 例如：C:\Users\14012\pi-desktop -> C--Users-14012-pi-desktop
		const normalized = projectPath.replace(/\\/g, "/");
		const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
		if (win) {
			const dirName = `${win[1]}--${win[2].replace(/\//g, "-")}`;
			return join(this.claudeRoot, dirName);
		}
		const dirName = normalized.replace(/^\//, "").replace(/\//g, "-");
		return join(this.claudeRoot, dirName);
	}

	/**
	 * Claude 工具输出格式：payload.content / payload.output，处理数组。
	 * 与 OpenCode/Codex 的 payload 形状不同，每适配器保留自己的实现。
	 */
	private extractToolOutput(payload: Record<string, unknown>): string {
		const output = payload.content ?? payload.output;
		if (typeof output === "string") return output;
		if (Array.isArray(output)) {
			return output
				.map((item) => {
					if (typeof item === "string") return item;
					const obj = item as Record<string, unknown>;
					return String(obj?.text ?? obj?.content ?? "");
				})
				.filter(Boolean)
				.join("\n");
		}
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
	}
}
