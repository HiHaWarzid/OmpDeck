import { readFile, writeFile, readdir, copyFile, unlink, open } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

import type { ChatMessage } from "../../shared/types";
import type { RpcResponse } from "./PiRpcClient";
import { extractMessageText } from "./messageContent";
import { convertAgentMessages, trimHistoryMessages } from "./messageTimeline";
import { findLastUserMessageLine } from "./sessionEntryIds";

/**
 * 会话 JSONL 文件读写模块 —— 把 pi 会话文件（.jsonl）的所有磁盘 IO 与纯行级定位
 * 逻辑从 AgentManager 中抽出，形成单一深度模块。
 *
 * 设计动机（deep module）：
 *   - AgentManager 原本内联了 7 个 JSONL 相关方法（读尾部消息、解析压缩归档、缓存命中率、
 *     按 entryId 定位行、备份/恢复、读改写），与 agent 运行时状态、RPC、消息内存缓存耦合在一起。
 *   - 这里把它们收拢为一个模块，对外只暴露 8 个方法，把「文件路径解析 + 日志」作为依赖注入，
 *     使其可在无 Electron/无 WSL 环境下测试（resolveHostPath 传 identity 即可）。
 *
 * 依赖方向：SessionJsonl 不依赖 AgentManager，不依赖 PiProcess/RPC。
 *   - 路径解析（WSL ↔ Windows host）由调用方通过 resolveHostPath 注入，
 *     这样 SessionJsonl 本身是 path-agnostic 的纯文件模块。
 *   - 日志同样可选注入，未提供时静默。
 *
 * 保留的耦合点（刻意的）：
 *   - locateEntry 保留原有 console 调试日志，行为与原 AgentManager.locateJsonlEntry 完全一致；
 *     清理调试日志属于独立清理任务，不在本次抽取范围内。
 *   - 各读取方法的换行切分策略（"\n" vs /\r?\n/）逐方法保持原样，避免引入行为差异。
 */

/** SessionJsonl 使用的最小日志结构（与 AppLogger 结构兼容，避免硬依赖 AppLogger）。 */
export interface SessionJsonlLogger {
	warn(scope: string, message: string, detail?: unknown): void;
	info(scope: string, message: string, detail?: unknown): void;
	error(scope: string, message: string, detail?: unknown): void;
}

/** SessionJsonl 的注入依赖。 */
export interface SessionJsonlDeps {
	/**
	 * 把 pi 协议会话路径（WSL 模式下为 Linux 逻辑路径）解析为桌面进程可访问的 host 路径。
	 * 调用方（AgentManager）传入的闭包应读取「当前」的 wslEnvironment，以支持运行时切换。
	 */
	resolveHostPath: (sessionPath: string) => string;
	/** 可选日志；未提供时静默。 */
	logger?: SessionJsonlLogger;
}

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

/** locateEntry 返回的定位结果。 */
export interface LocatedEntry {
	lineIndex: number;
	entry: Record<string, any>;
}

/** 备份文件命名约定，backup / findLatestBackup / restoreFromBackup 共用。 */
const BACKUP_SUFFIX = ".edit-backup";
/** 最多保留的最近备份数量，超出时删除最旧。 */
const MAX_BACKUPS = 3;

/** 尾部读取初始窗口：大会话只需读末尾 ~1MB 即可覆盖最近几十轮对话。 */
const TAIL_READ_INITIAL_BYTES = 1024 * 1024;
/** 尾部读取总窗口上限：单行 JSON（巨型工具结果）超过此值时不再扩展。 */
const TAIL_READ_MAX_BYTES = 16 * 1024 * 1024;

export class SessionJsonl {
	private readonly deps: SessionJsonlDeps;
	constructor(deps: SessionJsonlDeps) {
		this.deps = deps;
	}

	private resolve(sessionPath: string): string {
		return this.deps.resolveHostPath(sessionPath);
	}

	/**
	 * 从 JSONL 文件尾部读取最近若干完整行（含文件末尾未换行的残行，与旧整文件 split 行为一致）。
	 * 窗口不足时按 2x 向前扩展，直到收集够 minLines 或到达文件头 / 达到 maxBytes 上限。
	 * 窗口首行若从字节中部开始（UTF-8 多字节字符可能被截断），整行丢弃——该行必然不是
	 * 我们需要的尾部最近行，且避免了解码损坏。
	 */
	private async readTailLines(
		hostPath: string,
		minLines: number,
		maxBytes: number,
	): Promise<string[]> {
		const handle = await open(hostPath, "r");
		try {
			const { size } = await handle.stat();
			if (size === 0) return [];
			const limit = Math.min(size, maxBytes);
			let readSize = Math.min(TAIL_READ_INITIAL_BYTES, limit);
			for (;;) {
				const start = size - readSize;
				const buffer = Buffer.alloc(readSize);
				await handle.read(buffer, 0, readSize, start);
				const text = buffer.toString("utf8");
				const firstLf = text.indexOf("\n");
				// 窗口内首个换行之前的部分可能跨窗口边界（不完整行），丢弃；
				// 整个文件就是一个超长行时（start===0），它就是唯一且完整的行。
				const completeFrom = firstLf === -1 ? (start === 0 ? 0 : -1) : firstLf + 1;
				if (completeFrom >= 0) {
					const lines = text.slice(completeFrom).split("\n");
					// 已确认完整的行数（最后一段可能残，不计数）
					const completeCount = lines.length - 1;
					if (start === 0 || completeCount >= minLines || readSize >= limit) {
						return lines.map((line) => line.trim()).filter(Boolean);
					}
				}
				const nextSize = Math.min(readSize * 2, limit);
				if (nextSize <= readSize) return [];
				readSize = nextSize;
			}
		} finally {
			await handle.close();
		}
	}

	// ── 读取 ───────────────────────────────────────────────

	/**
	 * 大会话兜底：直接从历史会话 JSONL 文件尾部读取最近 maxTurns 轮对话的消息条目。
	 * 用于绕过 get_messages RPC 的整文件 JSON 传输瓶颈，避免大会话加载导致界面冻结。
	 * 返回兼容 RpcResponse 格式的对象，可复用 loadMessages 的消息处理管线。
	 *
	 * 旧实现整文件 readFile + 逐行 JSON.parse（40MB 级会话每次加载都全量解析）；
	 * 现在只读尾部窗口（默认 1MB，按需扩展），解析最近几十轮所需的行数即可。
	 */
	async readRecentMessages(
		sessionPath: string,
		maxTurns: number,
	): Promise<RpcResponse> {
		const t0 = Date.now();
		const hostPath = this.resolve(sessionPath);
		let lines: string[];
		try {
			// 每轮对话至少需要 user + assistant 两行；按 8 行/轮预留工具消息余量
			lines = await this.readTailLines(hostPath, maxTurns * 8 + 8, TAIL_READ_MAX_BYTES);
		} catch (error) {
			void this.deps.logger?.warn("agent", "Failed to read session file for recent messages", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}

		const messageEntries: unknown[] = [];

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message) {
					messageEntries.push(entry.message);
				}
			} catch {
				// 跳过单行解析失败，不影响后续行
			}
		}

		// 只保留最近 maxTurns 轮对话
		const trimmed = trimHistoryMessages(messageEntries, maxTurns);
		const t1 = Date.now();

		void this.deps.logger?.info("agent", "Recent messages read from session file", {
			sessionPath,
			windowLines: lines.length,
			messageEntries: messageEntries.length,
			trimmedTurns: maxTurns,
			trimmedMessages: trimmed.length,
			readMs: t1 - t0,
		});

		return {
			type: "response" as const,
			command: "get_messages",
			success: true,
			data: { messages: trimmed },
		};
	}

	/**
	 * 计算会话文件中最后一条 assistant 消息的 cache hit rate（百分比）。
	 * 从文件尾部向前扫描，命中第一条带 usage 的 assistant 消息即返回；
	 * 无可用数据（文件不可读 / 无 assistant / promptTokens 为 0）时返回 undefined。
	 * 只读尾部窗口（最近几十行足够定位最后一条 assistant），
	 * 避免每次运行态刷新都整文件读入解析（工具边沿会高频触发）。
	 */
	async getLatestCacheMessageHitRate(
		sessionPath: string,
	): Promise<number | undefined> {
		try {
			const lines = await this.readTailLines(this.resolve(sessionPath), 32, TAIL_READ_MAX_BYTES);
			// 从后往前遍历，找到最后一条 assistant 消息
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i].trim();
				if (!line) continue;
				try {
					const entry = JSON.parse(line) as Record<string, any>;
					if (entry?.message?.role === "assistant" && entry.message?.usage) {
						const usage = entry.message.usage;
						const input = usage.input ?? 0;
						const cacheRead = usage.cacheRead ?? 0;
						const cacheWrite = usage.cacheWrite ?? 0;
						const promptTokens = input + cacheRead + cacheWrite;
						if (promptTokens > 0) {
							return (cacheRead / promptTokens) * 100;
						}
						return undefined;
					}
				} catch {
					// 单行解析失败忽略，继续往前找
				}
			}
		} catch {
			// 文件不存在或无法读取，返回 undefined
		}
		return undefined;
	}

	/**
	 * 从原始会话文件解析压缩（compaction）记录。
	 * pi 的 get_messages 对压缩后的会话只返回压缩后的消息，不携带压缩摘要，
	 * 因此桌面端直接从 JSONL 里扫描 type:="compaction" 和 type:="message" 条目，用于：
	 *   1) 在时间线最前面补回"压缩摘要"卡片（与 pi 行为一致）；
	 *   2) 统计压缩次数，供前端展示"已压缩 N 次";
	 *   3) 提取每个压缩段归档的消息，支持在时间线中展开查看压缩前内容。
	 *
	 * sessionContent 可选：调用方若已读取过文件内容可传入以避免重复 IO。
	 */
	async parseArchives(
		sessionPath: string,
		agentId: string,
		sessionContent?: string,
	): Promise<SessionArchives> {
		let content: string;
		try {
			content = sessionContent ?? await readFile(this.resolve(sessionPath), "utf8");
		} catch (error) {
			void this.deps.logger?.warn("agent", "Failed to read session file for archive parsing", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return { compactions: [], archivedMessagesByCompactionId: new Map() };
		}

		// 一次遍历收集所有 entry 和原始消息
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

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (!entry || typeof entry !== "object") continue;
				allEntries.push({
					id: typeof entry.id === "string" ? entry.id : "",
					parentId: typeof entry.parentId === "string" ? entry.parentId : null,
					type: typeof entry.type === "string" ? entry.type : "",
					message: entry.message,
					summary: typeof entry.summary === "string" ? entry.summary : undefined,
					firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
					tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
				});
				// 缓存消息型 entry 的原始 message 对象，供后续 convertAgentMessages 使用
				if (entry.type === "message" && entry.message && typeof entry.message === "object" && entry.id) {
					rawMessagesByEntryId.set(entry.id, entry.message);
				}
			} catch {
				// 跳过单行解析失败
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

			if (rawMessages.length > 0) {
				// 反转消息顺序（回溯得到的是从新到旧，需反转为从旧到新）
				rawMessages.reverse();
				// 转换为 ChatMessage 格式
				try {
					const chatMessages = convertAgentMessages(agentId, rawMessages, undefined, false);
					if (chatMessages.length > 0) {
						archivedMessagesByCompactionId.set(compEntry.id, chatMessages);
					}
				} catch (err) {
					void this.deps.logger?.warn("agent", "Failed to convert archived messages", {
						agentId,
						compactionId: compEntry.id,
						rawCount: rawMessages.length,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		return { compactions, archivedMessagesByCompactionId };
	}

	// ── 纯查找（不读文件，对已读取的 lines 操作）──────────

	/**
	 * 根据 entryId 在 JSONL 文件中找到对应的行号。
	 * 先遍历每一行查找 entry 的 id 字段是否匹配 entryId。
	 * 匹配时返回行号（0-based），找不到返回 -1。
	 * 跳过 type=deleted 的行（早期版本保留了 id），避免定位到已删条目。
	 */
	findLineByEntryId(lines: string[], targetEntryId: string): number {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const parsed = JSON.parse(line);
				// 跳过已删条目：旧版本在 deleted 标记中保留了 id，
				// 后续版本不再保留；两种情况下都不应匹配。
				if (parsed.type === "deleted") continue;
				if (parsed.id === targetEntryId || parsed.entryId === targetEntryId) {
					return i;
				}
			} catch { /* 跳过不可解析的行 */ }
		}
		return -1;
	}

	/**
	 * 根据 chatMessage.meta.entryId（首选）或 _piDeckMsgSeq（回退）
	 * 在 JSONL 中找到对应行并返回行号和解析后的 entry。
	 * 优先使用 entryId 定位（O(n) 扫描 JSONL，n=文件行数），
	 * 回退使用 msg.id 提取 entryId（兼容旧版本已创建的聊天记录），
	 * 最后回退到角色 + 文本内容匹配。
	 *
	 * @returns { lineIndex, entry } 找到时返回；否则抛出错误
	 */
	locateEntry(
		lines: string[],
		messages: ChatMessage[],
		msg: ChatMessage,
	): LocatedEntry {
		const entryId = msg.meta?.entryId as string | undefined;

		// ── 调试日志（输出到控制台） ──
		console.log(`[locateJsonlEntry] msg.id=${msg.id}, meta.entryId=${entryId?.slice(0, 12) ?? "(none)"}, role=${msg.role}, text=[${msg.text.slice(0, 60)}]`);

		// 方案一：按 entryId 精确定位（首选）
		if (entryId) {
			const lineIndex = this.findLineByEntryId(lines, entryId);
			if (lineIndex !== -1) {
				console.log(`[locateJsonlEntry] scheme1(entryId) found at line=${lineIndex}`);
				return { lineIndex, entry: JSON.parse(lines[lineIndex]) };
			}
			console.warn(`[locateJsonlEntry] EntryId ${entryId} not found in JSONL, trying msg.id extraction`);
		}

		// 调试：记录 JSONL 前 10 行的 id，辅助排查 entryId 为何找不到
		const lineIds = lines.slice(0, 10).map((l, idx) => {
			try { const p = JSON.parse(l); return `${idx}:id=${p.id?.slice(0, 12) ?? "(no id)"}${p.entryId ? `,entryId=${String(p.entryId).slice(0, 12)}` : ""}`; }
			catch { return `${idx}:(parse error)`; }
		}).join("; ");
		console.log(`[locateJsonlEntry] first 10 JSONL ids: [${lineIds}]`);

		// 方案二：从 msg.id 提取 entryId（id 格式: `${agentId}-history-${entryId}`）
		// 当 get_entries 返回的 entryId 在 JSONL 中找不到时尝试此方案；
		// 也可用于 get_entries 失败时仍能从 msg.id 中恢复 entryId。
		const idPrefix = `${msg.agentId}-history-`;
		if (msg.id.startsWith(idPrefix)) {
			const extracted = msg.id.slice(idPrefix.length);
			console.log(`[locateJsonlEntry] scheme2 extracting from msg.id, extracted=[${extracted}]`);
			const lineIndex = this.findLineByEntryId(lines, extracted);
			if (lineIndex !== -1) {
				console.log(`[locateJsonlEntry] scheme2 found at line=${lineIndex}`);
				return { lineIndex, entry: JSON.parse(lines[lineIndex]) };
			}
			console.warn(`[locateJsonlEntry] scheme2 extracted [${extracted}] not found in JSONL`);
		} else {
			console.warn(`[locateJsonlEntry] msg.id does NOT start with prefix [${idPrefix}], cannot try scheme2`);
		}

		// 方案三：按角色 + 文本内容匹配（兜底方案）
		// 当 JSONL 中存在多个分支时，计数方案会错误统计非活跃分支的条目。
		// 用户消息优先取「最后一次」匹配：重复文案时第一个命中往往是更早的历史，
		// 重发若绑到更早 root 会把中间整段对话当后代删掉。
		console.log(`[locateJsonlEntry] scheme3 scanning by role=${msg.role} + text match`);
		if (msg.role === "user") {
			const last = findLastUserMessageLine(lines, msg.text, (content) => extractMessageText(content));
			if (last) {
				console.log(`[locateJsonlEntry] scheme3 last-user found at line=${last.lineIndex}`);
				return last;
			}
		} else {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line) continue;
				try {
					const entry = JSON.parse(line);
					if ((entry as any)?.type === "deleted") continue;
					const entryRole = (entry as any)?.message?.role;
					if (
						entryRole === msg.role ||
						(entryRole === "toolResult" && msg.role === "tool")
					) {
						const text = extractMessageText((entry as any)?.message?.content);
						if (text === msg.text) {
							console.log(`[locateJsonlEntry] scheme3 found at line=${i}, role=${entryRole}`);
							return { lineIndex: i, entry };
						}
					}
				} catch { /* 跳过不可解析的行 */ }
			}
		}

		console.error(`[locateJsonlEntry] ALL SCHEMES FAILED. msg.id=${msg.id}, role=${msg.role}, text=[${msg.text.slice(0, 100)}], jsonlLines=${lines.length}`);
		throw new Error("Message not found in session file");
	}

	// ── 备份 / 恢复 ────────────────────────────────────────

	/**
	 * 修改 JSONL 前备份文件，最多保留最近 3 个备份，用于意外恢复。
	 * 备份文件命名格式：{sessionPath}.{timestamp}.edit-backup
	 * 备份失败不影响主流程（仅记录日志）。
	 */
	async backup(sessionPath: string): Promise<void> {
		try {
			const sessionHostPath = this.resolve(sessionPath);
			const dir = dirname(sessionHostPath);
			const base = basename(sessionHostPath);
			const backupPrefix = `${base}.`;

			// 列出已有备份，按时间排序
			const allFiles = await readdir(dir).catch(() => [] as string[]);
			const backups = allFiles
				.filter((f) => f.startsWith(backupPrefix) && f.endsWith(BACKUP_SUFFIX))
				.sort()
				.reverse();

			// 超出限制时删除最旧的
			while (backups.length >= MAX_BACKUPS) {
				const old = backups.pop();
				if (old) await unlink(join(dir, old)).catch(() => {});
			}

			// 创建新备份
			const backupPath = join(dir, `${base}.${Date.now()}${BACKUP_SUFFIX}`);
			await copyFile(sessionHostPath, backupPath);
		} catch {
			// 备份失败不影响主流程
			void this.deps.logger?.warn("agent", "Session file backup failed", { sessionPath });
		}
	}

	/**
	 * 查找最近的会话文件备份路径，用于 reload 失败时恢复 JSONL。
	 * 无备份时返回 null。
	 */
	findLatestBackup(sessionPath: string): string | null {
		try {
			const sessionHostPath = this.resolve(sessionPath);
			const dir = dirname(sessionHostPath);
			const base = basename(sessionHostPath);
			const backupPrefix = `${base}.`;
			const allFiles = readdirSync(dir).filter(
				(f: string) => f.startsWith(backupPrefix) && f.endsWith(BACKUP_SUFFIX),
			);
			if (allFiles.length === 0) return null;
			// 按文件名排序（时间戳在文件名中，排序即按时间），取最新的
			allFiles.sort().reverse();
			return join(dir, allFiles[0]);
		} catch {
			return null;
		}
	}

	/**
	 * 从最新备份恢复会话文件。用于 reloadSession 失败后回滚 JSONL。
	 * @returns 是否找到了备份并完成恢复
	 */
	async restoreFromBackup(sessionPath: string): Promise<boolean> {
		const backupPath = this.findLatestBackup(sessionPath);
		if (!backupPath) return false;
		const sessionHostPath = this.resolve(sessionPath);
		const backupContent = await readFile(backupPath, "utf8");
		await writeFile(sessionHostPath, backupContent, "utf8");
		return true;
	}

	// ── 读改写原子封装 ─────────────────────────────────────

	/**
	 * 会话文件 read-modify-write 的原子封装：读取 → 调用 mutator 修改 → 备份 → 写回。
	 *
	 * 关键语义：
	 *   - mutator 接收当前 lines（原地修改即可），返回值即 modifyLines 的返回值，
	 *     用于 prepareResendFromMessage 需要把从文件中读出的原文/图片回传给调用方的场景。
	 *   - mutator 抛出时（定位失败、角色校验失败等）立即中止，**不会备份也不会写回**，
	 *     与原 editMessage/deleteMessage 中「先 locate 再 backup 再 mutate 再 write」的失败语义一致
	 *     （mutate 仅是内存操作，备份前后的 in-memory 变更对磁盘备份内容无影响）。
	 *   - 不负责 reload：调用方（AgentManager）负责后续 reloadSession 以及 reload 失败时的
	 *     restoreFromBackup + loadMessages 回滚。
	 *
	 * 文件读取失败或为空时抛出 "Session file is empty"，与原 orchestrator 行为一致。
	 */
	async modifyLines<T>(
		sessionPath: string,
		mutator: (lines: string[]) => T,
	): Promise<T> {
		const sessionHostPath = this.resolve(sessionPath);
		const raw = await readFile(sessionHostPath, "utf8").catch(() => "");
		if (!raw) throw new Error("Session file is empty");
		const lines = raw.split(/\r?\n/);

		// mutator 可能抛出（定位/校验失败）——此时不备份、不写回，直接向上传播
		const result = mutator(lines);

		await this.backup(sessionPath);
		await writeFile(sessionHostPath, lines.join("\n"), "utf8");
		return result;
	}
}
