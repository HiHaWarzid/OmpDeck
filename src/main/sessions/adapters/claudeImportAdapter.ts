import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ConvertedSession, ParsedSession, SourceAdapter } from "../importPipeline";
import {
	cleanTitle,
	extractPiText,
	makeId,
	normalizePath,
	zeroUsage,
} from "../importShared";

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

	constructor(private readonly claudeRoot: string) {}

	/**
	 * 轻量摘要：只提取 title/preview/messageCount，不构造 pi JSONL 行。
	 * 计数与标题规则与 convert 完全一致（pushMessage 的过滤条件逐条镜像），
	 * 一致性由 importPipeline.test.ts 的对照测试兜底。
	 */
	summarize(
		projectPath: string,
		session: ParsedSession,
	): { title: string; preview: string; messageCount: number } {
		const entries = session.entries as Array<Record<string, unknown>>;
		let title = "";
		let preview = "";
		let messageCount = 0;

		for (const entry of entries) {
			if (entry.type === "user") {
				const message = entry.message as Record<string, unknown> | undefined;
				const text = String(message?.content ?? "").trim();
				// 与 convert 的 user 分支一致：text 非空才计一条；preview 取第一条非空文本
				if (text) {
					messageCount += 1;
					if (!preview) preview = text.slice(0, 160);
					if (!title) title = cleanTitle(text);
				}
				continue;
			}
			if (entry.type === "assistant") {
				const message = entry.message as Record<string, unknown> | undefined;
				if (!message) continue;
				let hasContent = false;
				const msgContent = message.content;
				if (Array.isArray(msgContent)) {
					for (const item of msgContent as Array<Record<string, unknown>>) {
						if (item.type === "text") {
							const text = String(item.text ?? "").trim();
							if (text && !preview) preview = text.slice(0, 160);
							hasContent = true;
						} else if (item.type === "thinking" || item.type === "tool_use") {
							hasContent = true;
						}
					}
				}
				// 与 convert 一致：content 非空才计一条
				if (hasContent) messageCount += 1;
				continue;
			}
			// tool_result 与 convert 一致：无条件计一条（输出为空也 push）
			if (entry.type === "tool_result") {
				messageCount += 1;
			}
		}

		return {
			title: title || cleanTitle(basename(session.sourcePath)) || "Claude 会话",
			preview: preview || "Claude imported session",
			messageCount,
		};
	}


	convert(projectPath: string, session: ParsedSession): ConvertedSession {
		const meta = session.meta as unknown as ParsedClaudeSession["meta"];
		const entries = session.entries as Array<Record<string, unknown>>;
		const sessionId = meta.sessionId;
		const timestamp = new Date(meta.firstTimestamp).toISOString();
		const titleState = { title: "", preview: "" };
		const lines: string[] = [];
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;

		const pushEntry = (entry: Record<string, unknown>) => {
			lines.push(JSON.stringify(entry));
		};

		const pushMessage = (
			role: "user" | "assistant" | "toolResult",
			content: unknown[],
			extra: Record<string, unknown> = {},
			timestampValue?: string,
		) => {
			if (content.length === 0) return;
			const id = makeId(sessionId, sequence++);
			const ts = timestampValue || new Date().toISOString();
			pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: ts,
				message: {
					role,
					content,
					timestamp: new Date(ts).getTime(),
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

		// 写入会话头
		pushEntry({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp,
			cwd: projectPath,
		});

		pushEntry({
			type: "claude_import",
			version: 1,
			claudeSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
		});

		// Claude 历史没有记录模型名，假设使用 Claude 模型
		const modelChangeId = makeId(sessionId, sequence++);
		pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: "anthropic",
			model: "anthropic/claude-sonnet-4",
		});
		parentId = modelChangeId;

		// 转换消息
		for (const entry of entries) {
			// 跳过非消息类型
			if (entry.type === "file-history-snapshot") continue;
			if (entry.type === "system" && entry.subtype === "turn_duration") continue;
			if (entry.type === "system" && entry.subtype === "api_error") continue;

			if (entry.type === "user") {
				const message = entry.message as Record<string, unknown> | undefined;
				const text = String(message?.content ?? "").trim();
				if (text) {
					pushMessage("user", [{ type: "text", text }], {}, entry.timestamp as string);
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
					pushMessage(
						"assistant",
						content,
						{
							api: "claude-import",
							provider: "anthropic",
							model: (message.model as string) || "claude-sonnet-4",
							stopReason: (message.stop_reason as string) || "stop",
						},
						entry.timestamp as string,
					);
				}
				continue;
			}

			// 处理工具结果
			if (entry.type === "tool_result") {
				const toolCallId = String(entry.tool_use_id ?? "");
				const output = this.extractToolOutput(entry);
				pushMessage(
					"toolResult",
					[{ type: "text", text: output }],
					{
						toolCallId,
						toolName: "tool",
						isError: Boolean(entry.is_error),
					},
					entry.timestamp as string,
				);
			}
		}

		const title =
			titleState.title ||
			cleanTitle(basename(session.sourcePath)) ||
			"Claude 会话";
		lines.splice(1, 0, JSON.stringify({ sessionName: title, cwd: projectPath }));

		return {
			raw: `${lines.join("\n")}\n`,
			title,
			preview: titleState.preview || "Claude imported session",
			messageCount,
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
