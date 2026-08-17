import { app, type BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
	AgentManagerEvent,
	AgentManagerEventListener,
	AgentRuntimeState,
	AgentStatus,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ForkMessage,
	ImageContent,
	Project,
	SendPromptInput,
	SendPromptResult,
	ThinkingUpdate,
} from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import {
	extractResultDetails,
} from "../../shared/todo";
import { PiProcess } from "./PiProcess";
import type { RpcResponse } from "./PiRpcClient";
import { formatBashToolMessage } from "./bashResult";
import { extractMessageText } from "./messageContent";
import { mergeHistoryWithPreservedMessages } from "./historyMessages";
import {
	buildActiveBranchEntryIds,
	convertAgentMessages,
	formatToolDetail,
	getToolPathFromArgs,
	trimHistoryMessages,
} from "./messageTimeline";
import { perfEnd, perfStart } from "../perf";
import {
	buildAskCard,
	extractAskQuestionDetails,
	tryParseBatchAskEnvelope,
} from "./askQuestionCard";
import {
	MAX_TOOL_RESULT_CHARS,
	extractImages,
	extractThinking,
	extractToolResultText,
	safeJson,
	stripAnsi,
	truncateForDetail,
} from "./messageTextUtils";
import {
	assertResendRootEntry,
	collectDescendantEntryIds,
	findLastUserMessageLine,
	takeActiveEntryId,
} from "./sessionEntryIds";
import { SessionJsonl } from "./sessionJsonl";
import { describeImage, isVisionBridgeReady } from "../vision/VisionBridge";
import { LatestByKeyEmitter } from "./LatestByKeyEmitter";
import {
	createStreamGateState,
	isStreamGateSealed,
	noteAbortSettled,
	openStreamGateForNewRun,
	sealStreamGate,
	type StreamGateState,
} from "./streamGate";
import {
  updateActiveToolCalls,
  type ActiveToolCallState,
} from "../../shared/toolRuntimeState";
import type { SettingsStore } from "../settings/SettingsStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { RpcLogger } from "../logging/RpcLogger";
import type { AppLogger } from "../logging/AppLogger";
import {
	toWindowsHostPath,
	toWslLinuxPath,
	type WslEnvironment,
} from "../wsl/WslPaths";

/** 项目信任确认弹窗的用户选择 */
export type ProjectTrustChoice = "trust-remember" | "trust-session" | "deny";

export class AgentManager {
	/**
	 * 所有 agent 的运行态。per-agent 状态（消息/思考/工具/闸门/flag 等）全部收拢在
	 * AgentRuntime 对象内，本 Map 是唯一的 agent 索引——见 `AgentRuntime` 类型注释。
	 */
	private readonly agents = new Map<string, AgentRuntime>();
	/**
	 * 同一历史会话正在创建 Agent 时共享同一个 Promise，避免快速重复点击/IPC 竞态创建多个进程。
	 * 按 sessionKey（非 agentId）索引，因为 runtime 尚未创建前就需要去重。
	 */
	private readonly creatingSessionAgents = new Map<string, Promise<AgentTab>>();
	private readonly thinkingEmitter = new LatestByKeyEmitter<string, string>(
		50,
		(agentId, thinking) => this.emitThinkingNow(agentId, thinking),
	);
	/** 流式 emit 合并窗口（毫秒）。50ms 兼顾流畅度与传输量，肉眼几乎无延迟。 */
	private static readonly MESSAGE_FLUSH_INTERVAL_MS = 50;
	/**
	 * agent_end / 压缩完成后到最终空闲检查的延迟（毫秒）。
	 * 旧 pi 有 agent_settled 事件可立即恢复 idle；omp 没有该事件，用短延迟 +
	 * get_state 校验（isStreaming/isCompacting/pendingMessageCount）确认无后续工作。
	 * 延迟过短会频繁查询 get_state，过长则 agent 完成后 UI 长时间停在 running。
	 */
	private static readonly AGENT_SETTLED_TIMEOUT_MS = 1200;
	/**
	 * 超过该大小的历史会话跳过 get_messages RPC，改为直接从 JSONL 文件尾部读取最近 N 条消息。
	 * pi 当前不支持 limit/cursor，40MB JSONL 会以单行大 JSON 返回，主进程 JSON.parse 会短暂冻结整个应用。
	 * 文件直接读取仅解析近尾部少量消息，避免大会话加载导致的界面冻结。
	 */
	private static readonly MAX_AUTO_HISTORY_LOAD_BYTES = 5 * 1024 * 1024;
	/**
	 * 大会话直接从文件尾部读取时，最多保留的最近消息轮次（每条 user 消息算一轮）。
	 * 原值 8 对于一些需要回看较多历史的长会话偏少，提高至 30 轮。
	 */
	private static readonly MAX_HISTORY_LOAD_TURNS = 30;
	/** 本地事件监听器（用于 FeishuBridge 等主进程内部订阅） */
	private readonly localEventListeners = new Set<(agentId: string, event: unknown) => void>();
	/** 状态变更监听器（用于 PetStateBridge 等主进程内部模块订阅 AgentTab[] 聚合状态） */
	private readonly stateListeners = new Set<(tabs: AgentTab[]) => void>();
	/**
	 * 语义事件监听器（AFK 编排器/后续 renderer 语义订阅用）。
	 * 与 stateListeners 不同：这里订阅的是增量语义事件（消息追加/状态变更/运行态/已稳定），
	 * 而非整表快照；回调在汇聚点同步执行，单个监听器抛异常不影响其它监听器。
	 */
	private readonly eventListeners = new Set<AgentManagerEventListener>();
	/**
	 * statusChanged 语义事件的去重基准：记录每个 agent 上次已向语义订阅者发表的 status。
	 * emitStateNow 是 50ms 聚合快照，若每次都全量发 statusChanged，会把「无变化」也当成
	 * 变更流（AFK 编排器按增量消费）；diff 上次已发表值，只发实际变化的 agent。
	 */
	private readonly lastEmittedTabStatus = new Map<string, AgentStatus>();
	/** abort settled 兜底超时：覆盖多数管道残留，同时不让“立刻重发”永久卡死。 */
	private static readonly ABORT_SETTLED_FALLBACK_MS = 1500;
	/** 待处理的项目信任确认请求。key 为 requestId，用于在 Agent 启动前等待用户的信任决策。 */
	private readonly pendingTrustRequests = new Map<string, { resolve: (choice: ProjectTrustChoice) => void }>();
	/**
	 * 工具结果全文缓存（仅存被截断下发的完整文本），供「查看完整输出」按需读取。
	 * LRU 上限 200 条防止长会话无界增长；agent 退出时由 stopAll/删除路径清空关联条目
	 * （messageId 全局唯一，直接按 id 删除即可）。
	 */
	private readonly toolFullTextByMessageId = new Map<string, string>();
	private static readonly TOOL_FULL_TEXT_LRU_MAX = 200;
	/**
	 * emitRuntimeState 并发合并：工具密集循环（tool_start/end 交替）每个边沿都会
	 * 触发一次 get_state + get_session_stats RPC 与文件尾部读取；同一时刻只允许
	 * 一个在途请求，期间到达的新请求只标记 pending，在途请求完成后补发一次最新状态
	 * （latest-wins，中间态对渲染层无意义）。
	 */
	private readonly runtimeStateInFlight = new Set<string>();
	private readonly runtimeStatePending = new Set<string>();
	/**
	 * emitRuntimeState 最小间隔节流的最近发射时间戳与延迟补发定时器：
	 * 工具密集循环（tool_start/end 交替）每个边沿都会触发 get_state + get_session_stats
	 * RPC，间隔 <150ms 的请求延后到间隔满时补发最新状态，减少 RPC 往返次数。
	 */
	private static readonly RUNTIME_STATE_MIN_INTERVAL_MS = 150;
	private readonly runtimeStateLastEmitAt = new Map<string, number>();
	private readonly runtimeStateThrottleTimers = new Map<string, NodeJS.Timeout>();
	private wslEnvironment: WslEnvironment | null = null;
	/**
	 * 会话 JSONL 文件读写模块：从本类抽出的深度模块，负责所有会话文件的磁盘 IO
	 * （读尾部消息、解析压缩归档、缓存命中率、按 entryId 定位、备份/恢复、读改写）。
	 * 路径解析闭包读取「当前」wslEnvironment，以支持运行时 configureWsl 切换。
	 */
	private readonly sessionJsonl: SessionJsonl;

	constructor(
		private readonly getProject: (id: string) => Project | undefined,
		private readonly getWindow: () => BrowserWindow | null,
		private readonly settingsStore: SettingsStore,
		private readonly configManager: ConfigManager,
		private readonly rpcLogger?: RpcLogger,
		private readonly appLogger?: AppLogger,
	) {
		this.sessionJsonl = new SessionJsonl({
			resolveHostPath: (sessionPath) => this.toSessionHostPath(sessionPath),
			logger: this.appLogger,
		});
	}

	configureWsl(environment: WslEnvironment | null): void {
		this.wslEnvironment = environment;
	}

	/** Windows 主进程文件操作必须使用可由 host 访问的路径。 */
	private toSessionHostPath(sessionPath: string): string {
		return this.wslEnvironment
			? toWindowsHostPath(sessionPath, this.wslEnvironment)
			: sessionPath;
	}

	/** Pi/RPC/session identity 在 WSL 模式下始终使用 Linux 逻辑路径。 */
	private toSessionProtocolPath(sessionPath: string): string {
		return this.wslEnvironment
			? toWslLinuxPath(sessionPath, this.wslEnvironment)
			: sessionPath;
	}

	list() {
		return [...this.agents.values()]
			.map((runtime) => runtime.tab)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	}

	/**
	 * 判断指定项目是否仍有运行中的 Agent（pi 子进程未退出）。
	 * 用于删除项目前拦截，避免删除后 pi 进程悬挂后台继续占用资源。
	 */
	hasAgentForProject(projectId: string): boolean {
		for (const runtime of this.agents.values()) {
			if (runtime.tab.projectId === projectId) return true;
		}
		return false;
	}

	/**
	 * 返回某 agent 当前内存中的完整消息数组（只读快照）。
	 * 供渲染层增量失同步自愈（渲染层重载后 agent 仍在流式，期间只有尾部增量、缺会话头）、
	 * FeishuBridge/WebService 同步时间线使用。不存在该 agent 时返回空数组，
	 * 不抛错——这些调用方只读展示，缺失时降级为空比中断流程更合理。
	 */
	getMessages(agentId: string): ChatMessage[] {
		return this.agents.get(agentId)?.messages ?? [];
	}

	/**
	 * 不启动 pi 进程，直接从 JSONL 构造与运行态相同的时间线数据。
	 * Viewer 必须复用 AgentManager 的压缩归档与消息转换规则，避免维护第二套显示模型。
	 */
	async readSessionDisplayMessages(
		sessionPath: string,
		agentId = "_viewer",
		sessionContent?: string,
	): Promise<ChatMessage[]> {
		const content = sessionContent ?? await readFile(this.toSessionHostPath(sessionPath), "utf8");
		const entries: Array<{
			id: string;
			parentId: string | null;
			type: string;
			message?: unknown;
			summary?: string;
			firstKeptEntryId?: string;
			tokensBefore?: number;
			timestamp?: string;
		}> = [];

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
				entries.push({
					id: entry.id,
					parentId: typeof entry.parentId === "string" ? entry.parentId : null,
					type: typeof entry.type === "string" ? entry.type : "",
					message: entry.message,
					summary: typeof entry.summary === "string" ? entry.summary : undefined,
					firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
					tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
				});
			} catch {
				// 单行损坏不应阻断整个 Viewer。
			}
		}
		if (entries.length === 0) return [];

		// JSONL 最后一个 entry 是 pi 当前叶节点；沿 parentId 回溯得到与 get_messages 一致的活动分支。
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const activeBranch: typeof entries = [];
		const seen = new Set<string>();
		let current: (typeof entries)[number] | undefined = entries[entries.length - 1];
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			activeBranch.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		activeBranch.reverse();

		const lastCompactionIndex = activeBranch.findLastIndex((entry) => entry.type === "compaction");
		const lastCompaction = lastCompactionIndex >= 0 ? activeBranch[lastCompactionIndex] : undefined;
		const firstKeptIndex = lastCompaction?.firstKeptEntryId
			? activeBranch.findIndex((entry) => entry.id === lastCompaction.firstKeptEntryId)
			: -1;
		// pi 压缩后上下文由 summary + firstKeptEntryId 起的保留消息 + 后续消息组成；
		// 不能只取 compaction entry 之后，否则会漏掉压缩时明确保留的尾部消息。
		const currentStartIndex = firstKeptIndex >= 0
			? firstKeptIndex
			: lastCompactionIndex >= 0
				? lastCompactionIndex + 1
				: 0;
		const currentEntries = activeBranch
			.slice(currentStartIndex)
			.filter((entry) => entry.type === "message" && entry.message);
		const rawMessages = currentEntries.map((entry) => entry.message);
		const trimmed = trimHistoryMessages(rawMessages);
		const trimStart = trimmed.length > 0 ? rawMessages.indexOf(trimmed[0]) : 0;
		const activeEntryIds = currentEntries.slice(Math.max(0, trimStart)).map((entry) => entry.id);

		let finalRaw: unknown[] = trimmed;
		if (lastCompaction) {
			const compactionEntry = lastCompaction;
			const archiveData = await this.sessionJsonl.parseArchives(sessionPath, agentId, content);
			const archivedMessages = archiveData.archivedMessagesByCompactionId.get(compactionEntry.id) ?? [];
			finalRaw = [{
				role: "compactionSummary",
				summary: compactionEntry.summary || "[摘要]",
				timestamp: compactionEntry.timestamp ? Date.parse(compactionEntry.timestamp) : Date.now(),
				meta: {
					compactionId: compactionEntry.id,
					compactionCount: archiveData.compactions.length,
					firstKeptEntryId: compactionEntry.firstKeptEntryId,
					tokensBefore: compactionEntry.tokensBefore,
					archivedMessages,
				},
			}, ...trimmed];
		}

		return convertAgentMessages(agentId, finalRaw, activeEntryIds, false);
	}

	recordHostExchange(agentId: string, userText: string, assistantText: string) {
		const runtime = this.requireRuntime(agentId);
		this.addMessage(runtime, "user", userText);
		this.addMessage(runtime, "assistant", assistantText);
	}

	getCwd(agentId: string) {
		return this.requireRuntime(agentId).tab.cwd;
	}

	/**
	 * 从会话文件提取最近的用户消息文本（最新在前），供渲染层补全上下键 prompt history。
	 * 大会话只向渲染层推送最近窗口（readRecentMessages 30 轮），窗口外的更早发送记录
	 * 只有直接读会话文件才能拿到；路径为协议路径，由 sessionJsonl 的 resolveHostPath 转换。
	 */
	async readSessionUserPrompts(filePath: string, maxCount: number): Promise<string[]> {
		return this.sessionJsonl.readRecentUserPrompts(filePath, maxCount);
	}

	async loadMessages(
		agentId: string,
		skipEntries = false,
		earlyMessagesPromise?: Promise<RpcResponse>,
		options?: { preserveMessagesAfter?: number },
	) {
		const t0 = Date.now();
		const runtime = this.requireRuntime(agentId);

		// 并行请求：get_messages 和 get_entries 互不依赖，可以同时发起
		// 如果已有提前发出的请求（earlyMessagesPromise），直接复用，避免重复发送
		const messagesPromise = earlyMessagesPromise ?? runtime.process.client.request({
			type: "get_messages",
		});

		let entriesPromise: Promise<any> | undefined;
		if (!skipEntries) {
			entriesPromise = runtime.process.client.request({
				type: "get_entries",
			}, 15_000).catch(() => {
				// get_entries 失败时不阻塞消息加载；编辑/删除走 fallback（_piDeckMsgSeq 计数）
				void this.appLogger?.warn("agent", "Failed to get_entries for entryId mapping", { agentId });
				return undefined;
			});
		}

		const [response, entriesResult] = await Promise.all([
			messagesPromise,
			entriesPromise ?? Promise.resolve(undefined),
		]);
		const t1 = Date.now();

		let rawMessages = (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];

		// 兜底：get_messages 成功但返回空数组时，若会话文件确实存在且有内容，
		// 说明 pi 进程 resume 会话时未完整加载（如同一会话被并发打开、或文件尚在写入），
		// 直接回退到文件直读，避免历史消息在 UI 中空白。
		// 仅对带 sessionPath 的历史加载生效；全新会话（无 sessionPath）空消息是合法状态。
		if (rawMessages.length === 0 && skipEntries && runtime.tab.sessionPath) {
			const sessionHostPath = this.toSessionHostPath(runtime.tab.sessionPath);
			try {
				if (existsSync(sessionHostPath) && statSync(sessionHostPath).size > 0) {
					const fileFallback = await this.sessionJsonl.readRecentMessages(
						runtime.tab.sessionPath,
						AgentManager.MAX_HISTORY_LOAD_TURNS,
					).catch(() => undefined);
					if (fileFallback) {
						const fallbackMessages =
							(fileFallback.data as { messages?: unknown[] } | undefined)?.messages ?? [];
						if (fallbackMessages.length > 0) {
							rawMessages = fallbackMessages;
							void this.appLogger?.warn("agent", "get_messages returned empty; fell back to session file read", {
								agentId,
								sessionPath: runtime.tab.sessionPath,
								fileMessages: fallbackMessages.length,
							});
						}
					}
				}
			} catch {
				// 文件不可读时维持 RPC 结果，不阻断加载
			}
		}

		// 解析 entryId 列表（需要先于 convertAgentMessages，用于把消息关联到 pi 的会话分支）。
		let activeEntryIds: string[] | undefined;
		if (entriesResult) {
			const entriesData = entriesResult.data as
				| { entries?: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>; leafId?: string }
				| undefined;
			if (entriesData?.entries && entriesData?.leafId) {
				activeEntryIds = buildActiveBranchEntryIds(entriesData.entries, entriesData.leafId);
			}
		}

		// 按对话轮次截断（保留最近若干轮 user 消息）。压缩摘要不是 user 消息，会被此逻辑保留在尾部，
		// 因此下方会单独把它插到最前面，确保不被按 user 轮次切掉。
		const trimmed = trimHistoryMessages(rawMessages);

		// 解析会话文件里的压缩记录：拿到所有压缩段摘要 + 归档消息。
		// pi 的 get_messages 对压缩会话只返回压缩后的消息，通常不带压缩摘要；
		// 这里从原始会话文件补回：压缩摘要卡片 + 归档消息（支持展开查看压缩前内容）。
		// 若 RPC 已经返回了压缩/分支摘要，则不再重复补，避免时间线出现两张摘要卡片。
		let compactionSummaryRaw: unknown | null = null;
		const rpcAlreadyHasSummary = rawMessages.some(
			(m) => (m as { role?: unknown })?.role === "compactionSummary"
				|| (m as { role?: unknown })?.role === "branchSummary",
		);
		void this.appLogger?.info("agent", "Compaction check", {
			agentId,
			hasSessionPath: !!runtime.tab.sessionPath,
			rpcAlreadyHasSummary,
			rawMessageCount: rawMessages.length,
		});
		if (runtime.tab.sessionPath) {
			const archiveData = await this.sessionJsonl.parseArchives(runtime.tab.sessionPath, agentId).catch((err) => {
			void this.appLogger?.warn("agent", "Failed to parse session archives", {
				agentId,
				sessionPath: runtime.tab.sessionPath,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		});
			if (archiveData && archiveData.compactions.length > 0) {
				void this.appLogger?.info("agent", "Session archives parsed", {
					agentId,
					compactionCount: archiveData.compactions.length,
					rpcAlreadyHasSummary,
					archivedMessageCounts: [...archiveData.archivedMessagesByCompactionId.entries()].map(([id, msgs]) => ({ compactionId: id, count: msgs.length })),
				});

				const last = archiveData.compactions[archiveData.compactions.length - 1];
				const archivedMessages = archiveData.archivedMessagesByCompactionId.get(last.id) ?? [];

				if (!rpcAlreadyHasSummary) {
					// RPC 未返回摘要 → 我们自己创建压缩卡片
					compactionSummaryRaw = {
						role: "compactionSummary",
						summary: last.summary || "[摘要]",
						timestamp: last.timestamp ? Date.parse(last.timestamp) : Date.now(),
						meta: {
							compactionId: last.id || null,
							compactionCount: archiveData.compactions.length,
							firstKeptEntryId: last.firstKeptEntryId,
							tokensBefore: last.tokensBefore,
							archivedMessages,
						},
					};
				} else {
					// RPC 已返回摘要 → 找到它并注入 archivedMessages（pi 的摘要不带归档消息）
					for (const msg of trimmed) {
						const m = msg as Record<string, unknown>;
						if (m.role === "compactionSummary") {
							m.meta = (m.meta as Record<string, unknown> | null) ?? {};
							(m.meta as Record<string, unknown>).archivedMessages = archivedMessages;
							break;
						}
					}
				}
				// 把压缩次数写回 tab，供前端（会话头/标签）展示"已压缩 N 次"。
				if (runtime.tab.compactionCount !== archiveData.compactions.length) {
					runtime.tab.compactionCount = archiveData.compactions.length;
					this.emitState();
				}
			}
		}

		// 将压缩摘要插到消息最前面（在 trim 之后，避免被按 user 轮次切掉）。
		const finalRaw = compactionSummaryRaw ? [compactionSummaryRaw, ...trimmed] : trimmed;

		const messages = convertAgentMessages(agentId, finalRaw, activeEntryIds, runtime.abortedDuringAsk);
		const t2 = Date.now();
		void this.appLogger?.info("agent", "Agent messages loaded", {
			agentId,
			skipEntries,
			rawMessages: rawMessages.length,
			trimmedMessages: trimmed.length,
			requestMs: t1 - t0,
			convertMs: t2 - t1,
			totalMs: t2 - t0,
		});
		// abort 时 ask_question 的 answer 已被覆写为 null，不再需要跟踪
		runtime.abortedDuringAsk = false;
		const nextMessages = mergeHistoryWithPreservedMessages(
			messages,
			runtime.messages,
			options?.preserveMessagesAfter,
		);
		runtime.messages = nextMessages;
		// 整组重建：下一次 flush 必须是全量基线（渲染层整体替换），不能用增量合并。
		this.markAllMessagesDirty(runtime);
		this.refreshAutoTitle(runtime);
		this.scheduleMessageEmit(runtime, true);
		return nextMessages;
	}

	async create(input: CreateAgentInput) {
		const normalizedInput = input.sessionPath
			? { ...input, sessionPath: this.toSessionProtocolPath(input.sessionPath) }
			: input;
		const sessionKey = this.normalizeSessionPathForCompare(normalizedInput.sessionPath);
		if (!sessionKey) return this.createUnlocked(normalizedInput);

		const existingForSession = this.findRuntimeBySessionKey(sessionKey);
		if (existingForSession) return existingForSession.tab;

		const pendingCreate = this.creatingSessionAgents.get(sessionKey);
		if (pendingCreate) return pendingCreate;

		// 历史会话激活属于“一个 sessionPath 只能对应一个 Agent”的业务规则；
		// 先登记 in-flight Promise，再启动真实创建，防止第二次点击绕过 agents map 检查。
		const createPromise = this.createUnlocked(normalizedInput).finally(() => {
			this.creatingSessionAgents.delete(sessionKey);
		});
		this.creatingSessionAgents.set(sessionKey, createPromise);
		return createPromise;
	}

	private normalizeSessionPathForCompare(sessionPath?: string) {
		if (!sessionPath) return undefined;
		const normalized = this.toSessionProtocolPath(sessionPath)
			.replace(/\\/g, "/")
			.replace(/\/+$/, "");
		// Native Windows and /mnt drive paths inherit case-insensitive host semantics.
		// WSL-internal paths retain Linux case sensitivity so distinct sessions are not deduplicated.
		return !this.wslEnvironment || /^\/mnt\/[a-z](?:\/|$)/i.test(normalized)
			? normalized.toLowerCase()
			: normalized;
	}

	private getHistoryAutoLoadDecision(sessionPath?: string): { shouldLoad: boolean; sizeBytes?: number } {
		if (!sessionPath) return { shouldLoad: true };
		try {
			const sizeBytes = statSync(this.toSessionHostPath(sessionPath)).size;
			return {
				shouldLoad: sizeBytes <= AgentManager.MAX_AUTO_HISTORY_LOAD_BYTES,
				sizeBytes,
			};
		} catch {
			// 无法读取大小时保留旧行为尝试加载，避免临时文件/权限异常直接导致历史不可见。
			return { shouldLoad: true };
		}
	}

	private findRuntimeBySessionKey(sessionKey: string) {
		return [...this.agents.values()].find(
			(runtime) =>
				this.normalizeSessionPathForCompare(runtime.tab.sessionPath) === sessionKey,
		);
	}

	private async createUnlocked(input: CreateAgentInput) {
		const t0 = Date.now();
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);

		const id = randomUUID();
		void this.appLogger?.info("agent", "Agent create requested", {
			agentId: id,
			projectId: input.projectId,
			projectPath: project.path,
			sessionPath: input.sessionPath,
			title: input.title,
		});
		const existingForSessionKey = this.normalizeSessionPathForCompare(input.sessionPath);
		const existingForSession = existingForSessionKey
			? this.findRuntimeBySessionKey(existingForSessionKey)
			: undefined;
		if (existingForSession) {
			void this.appLogger?.info("agent", "Agent create reused existing session", {
				agentId: existingForSession.tab.id,
				sessionPath: input.sessionPath,
			});
			return existingForSession.tab;
		}

		const tab: AgentTab = {
			id,
			projectId: project.id,
			cwd: project.path,
			title: input.title || `${project.name} agent`,
			status: "starting",
			sessionPath: input.sessionPath,
			noSession: input.noSession,
			createdAt: Date.now(),
		};

		const t1 = Date.now();
		const trustOverride = await this.ensureProjectTrust(project);
		const t2 = Date.now();

		void this.appLogger?.info("agent", "Agent pi process start", { agentId: id });
		// agentHomeDir：WSL 模式下扩展目录在映射的 Windows home，需与 ExtensionManager 一致。
		const process = new PiProcess(project.path, this.settingsStore.get(), undefined, {
			agentHomeDir: this.wslEnvironment?.windowsHome,
		});
		process.on("version-check", (payload) => {
			void this.appLogger?.info("agent", "Pi version check completed", {
				agentId: id,
				...(payload && typeof payload === "object" ? payload : {}),
			});
		});
		const runtime = createAgentRuntime(tab, process);
		this.agents.set(id, runtime);
		this.emitState();

		// 关键：监听器必须在 process.start() 之前挂上。
		// spawn 的 ENOENT / EACCES 等 error 事件是异步的；若等 start() 返回后再 on("error")，
		// 中间窗口可能 0 listener，EventEmitter 会把 error 升级成未捕获异常，
		// 在部分 macOS arm 环境上表现为“一点启动 Agent 就闪退”。
		this.attachPiProcessLifecycle(id, process, {
			projectPath: project.path,
			// 捕获 runtime 引用而非仅 tab：进程退出可能在 agents.delete 之后触发
			// （stop/restart 先删 map 再 stop 进程），此时仍需通过闭包读取 runtime 上的
			// userInitiatedStop/compacting/autoRestartAttempted 等 flag 决定退出分支。
			onExit: (payload) => this.handleCreateProcessExit(id, runtime, payload),
		});

		let client: Awaited<ReturnType<PiProcess["start"]>>;
		try {
			client = await process.start(input.sessionPath, trustOverride, input.noSession);
		} catch (error) {
			// start() 同步失败（非法 cwd、spawn 抛错等）也要落到会话错误卡，而不是 IPC 裸抛。
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Agent pi process start threw", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
				diagnostics: process.getDiagnostics(),
				// 注意：局部变量 process 是 PiProcess，宿主平台要用 globalThis.process
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			this.addMessage(runtime, "error", this.buildStartupFailureMessage(rawMessage, process.getDiagnostics()));
			this.emitState();
			return tab;
		}
		const t3 = Date.now();
		const diag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process spawned", {
			agentId: id,
			prepareMs: t1 - t0,
			trustMs: t2 - t1,
			spawnCallMs: t3 - t2,
			command: diag?.command,
			args: diag?.args?.join(' '),
			cwd: diag?.cwd,
			platform: globalThis.process.platform,
			arch: globalThis.process.arch,
		});

		// 启动后先获取状态，get_messages 必须等状态就绪后再发送。
		// 添加自动重试机制补偿 pi 初始化期间的瞬时延迟（如系统负载高、会话语料加载慢、
		// 反病毒扫描），避免一次超时就永久标记为启动失败——用户反馈重启即可恢复说明进程本身正常。
		void this.appLogger?.info("agent", "Agent get_state request start", { agentId: id });
		// 单次 get_state 超时接用户配置的 rpcTimeout（默认 600s），下限 45s：
		// WSL/代理/慢机器上 omp 首次响应可能远超默认值，用户调大超时时启动路径必须同步生效
		// （否则诊断卡"调大 RPC 超时"的指引对启动无效）；进程退出会立刻 reject pending
		// （PiProcess exit → rpc.close），不会白等整个窗口。配合重试覆盖 omp 初始化期间的瞬时延迟。
		const GET_STATE_TIMEOUT_MS = Math.max(45_000, this.settingsStore.get().rpcTimeout);
		const GET_STATE_RETRIES = 2;
		const GET_STATE_RETRY_DELAY_MS = 2_000;
		void this.appLogger?.info("agent", "Agent get_state retry config", {
			agentId: id,
			timeoutMs: GET_STATE_TIMEOUT_MS,
			maxRetries: GET_STATE_RETRIES,
		});
		/**
		 * 带退避重试的 get_state：如果第一次超时但进程仍在运行，等待退避后重试，
		 * 最多尝试 (1 + GET_STATE_RETRIES) 次。进程退出时立即停止重试，避免等待僵尸进程。
		 */
		const statePromise = (async (): Promise<RpcResponse> => {
			for (let attempt = 0; attempt <= GET_STATE_RETRIES; attempt++) {
				try {
					return await client.request({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
				} catch (err) {
					const isRunning = process.isRunning();
					void this.appLogger?.warn("agent", `Agent get_state attempt ${attempt + 1}/${GET_STATE_RETRIES + 1} failed`, {
						agentId: id,
						attempt: attempt + 1,
						totalAttempts: GET_STATE_RETRIES + 1,
						error: err instanceof Error ? err.message : String(err),
						processRunning: isRunning,
					});
					// 进程已退出 → 不再重试；重试耗尽 → 上报最终错误
					if (!isRunning || attempt >= GET_STATE_RETRIES) throw err;
					// 进程仍在运行：退避等待后重试（间隔递增：2s, 4s）
					await new Promise(resolve => setTimeout(resolve, GET_STATE_RETRY_DELAY_MS * (attempt + 1)));
				}
			}
			throw new Error("Unreachable: get_state retry loop exhausted");
		})();
		const historyLoadDecision = this.getHistoryAutoLoadDecision(input.sessionPath);

		try {
			void this.appLogger?.info("agent", "Agent get_state request completed", { agentId: id });
			const state = await statePromise;
			const t4 = Date.now();
			void this.appLogger?.info("agent", "Agent get_state completed", {
				agentId: id,
				stateMs: t4 - t3,
				totalSinceCreateMs: t4 - t0,
			});
			const data = state.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			tab.sessionId = data?.sessionId;
			tab.sessionPath = data?.sessionFile ?? input.sessionPath;
			tab.title =
				input.title ||
				data?.sessionName ||
				(input.sessionPath
					? `${project.name} 历史会话`
					: `${project.name} agent`);
			tab.status = "idle";
			// 若因桌面兼容性自动跳过了 codeisland 等扩展，给用户一条系统说明，避免「扩展在却不生效」困惑。
			const blockedOnStart = process.getDiagnostics()?.blockedExtensions;
			if (blockedOnStart && blockedOnStart.length > 0) {
				this.addMessage(
					runtime,
					"system",
					`已临时停用与 OmpDeck 不兼容的扩展：${blockedOnStart.join(", ")}（仅桌面 RPC 会话期间；其它扩展与 npm 包装扩展不受影响，Agent 结束后会自动恢复，CLI 仍可正常使用）。`,
				);
				void this.appLogger?.info("agent", "Desktop-blocked extensions skipped", {
					agentId: id,
					blocked: blockedOnStart,
				});
			}
			// 大历史会话的 get_messages 可能需要十几秒；Agent 可用只依赖 get_state，
			// 因此历史消息后台加载，避免 40MB+ 会话把“打开 Agent”阻塞到十几秒。
			// 同时插入一条临时系统消息，给用户明确的加载反馈，避免空白页面看起来像冻结。
			// preserveMessagesAfter 保护加载期间用户新发的消息/流式回复，防止历史结果回写时覆盖当前会话。
			// 状态就绪后发送 get_messages，确保 pi 进程已完全加载会话文件，避免竞态。
			const messagesPromise = historyLoadDecision.shouldLoad
				? client.request({ type: "get_messages" }, this.settingsStore.get().rpcTimeout)
				: undefined;
			const preserveMessagesAfter = Date.now();
			if (messagesPromise) {
				// 加载占位：get_messages 可能耗时十几秒，期间给用户明确的加载反馈，
				// 避免聊天区空白看起来像卡死。加载成功后的全量基线会整体替换掉占位
				// （mergeHistoryWithPreservedMessages 显式剔除 historyLoading 消息）；
				// 加载失败时下方 catch 会把占位转成错误提示。
				this.addMessage(runtime, "system", "正在加载历史会话…", { historyLoading: true });
				void this.loadMessages(id, true, messagesPromise, { preserveMessagesAfter })
					.catch(() =>
						new Promise<void>((resolve) => setTimeout(resolve, 800))
							.then(() => this.loadMessages(id, true, undefined, { preserveMessagesAfter })),
					)
					.then(() => {
						void this.appLogger?.info("agent", "Agent history loaded in background", {
							agentId: id,
							totalMs: Date.now() - preserveMessagesAfter,
						});
					})
					.catch((error) => {
						const rt = this.agents.get(id);
						const list = rt?.messages ?? [];
						const loadingMessage = list.find((message) => message.meta?.historyLoading === true);
						if (loadingMessage) {
							loadingMessage.role = "error";
							loadingMessage.text = "历史会话加载失败，可继续使用当前 Agent 或重新打开会话重试。";
							loadingMessage.meta = { historyLoading: "failed" };
							loadingMessage.timestamp = Date.now();
							if (rt) {
								this.markMessageDirty(rt, loadingMessage);
								this.scheduleMessageEmit(rt, true);
							}
						}
						void this.appLogger?.warn("agent", "Agent history background load failed", {
							agentId: id,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			} else if (input.sessionPath) {
				// 文件直读同样可能较慢（大文件），与 RPC 分支一致插入加载占位。
				this.addMessage(runtime, "system", "正在加载历史会话…", { historyLoading: true });
				void this.loadMessages(
					id,
					true,
					this.sessionJsonl.readRecentMessages(
						input.sessionPath,
						AgentManager.MAX_HISTORY_LOAD_TURNS,
					),
					{ preserveMessagesAfter },
				)
					.then(() => {
						void this.appLogger?.info("agent", "Agent recent history loaded from file", {
							agentId: id,
							sessionPath: input.sessionPath,
							sizeBytes: historyLoadDecision.sizeBytes,
							totalMs: Date.now() - preserveMessagesAfter,
						});
					})
					.catch((error) => {
						const rt = this.agents.get(id);
						const list = rt?.messages ?? [];
						const loadingMessage = list.find((message) => message.meta?.historyLoading === true);
						if (loadingMessage) {
							loadingMessage.role = "error";
							loadingMessage.text = "历史会话加载失败，可继续使用当前 Agent 或重新打开会话重试。";
							loadingMessage.meta = { historyLoading: "failed" };
							loadingMessage.timestamp = Date.now();
							if (rt) {
								this.markMessageDirty(rt, loadingMessage);
								this.scheduleMessageEmit(rt, true);
							}
						}
						void this.appLogger?.warn("agent", "Agent recent history file load failed", {
							agentId: id,
							sessionPath: input.sessionPath,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}
			void this.appLogger?.info("agent", "Agent create completed", {
				agentId: id,
				totalMs: Date.now() - t0,
				historyLoading: "background",
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Agent create failed", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
				diagnostics: process.getDiagnostics(),
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			this.addMessage(runtime, "error", this.buildStartupFailureMessage(rawMessage, process.getDiagnostics()));
		}

		this.emitState();
		return tab;
	}

	async rename(agentId: string, name: string) {
		const runtime = this.requireRuntime(agentId);
		const trimmed = name.replace(/\s+/g, " ").trim();
		if (!trimmed) throw new Error("Agent name cannot be empty");

		// 会话名属于 pi 原生 session 元数据；通过 RPC 修改，避免 desktop 手写 JSONL 后与 pi 格式演进脱节。
		const response = await runtime.process.client.request(
			{ type: "set_session_name", name: trimmed },
			20_000,
		);
		if (!response.success) {
			throw new Error(response.error ?? "Failed to rename session");
		}

		runtime.tab.title = trimmed;
		const state = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => ({ data: undefined }));
		const data = state.data as
			| { sessionId?: string; sessionFile?: string; sessionName?: string }
			| undefined;
		runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
		runtime.tab.sessionPath = data?.sessionFile ?? runtime.tab.sessionPath;
		runtime.tab.title = data?.sessionName || runtime.tab.title;
		this.emitState();
		return runtime.tab;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		const trimmed = input.message.trim();
		const hasImages = input.images && input.images.length > 0;
		let agentMessage = input.agentMessage?.trim() || trimmed || "Describe this image.";
		// 允许只有图片没有文字的情况发送
		if (!trimmed && !hasImages) {
			return { accepted: false, error: "消息不能为空" };
		}

		// 解析 !/!! 前缀：与 pi 终端行为一致
		// !command  → 执行命令并将输出发送给 LLM（excludeFromContext: false）
		// !!command → 执行命令但不将输出发送给 LLM（excludeFromContext: true）
		const isBashExcluded = trimmed.startsWith("!!");
		const isBashNormal = !isBashExcluded && trimmed.startsWith("!");

		if (isBashExcluded || isBashNormal) {
			const command = isBashExcluded
				? trimmed.slice(2).trim()
				: trimmed.slice(1).trim();
			if (command) {
				return this.executeBashCommand(input.agentId, command, isBashExcluded);
			}
		}

		// 判断 agent 是否已在忙碌中；运行中继续发送时必须带 streamingBehavior，
		// 否则 pi RPC 会拒绝请求。该值也用于给用户消息打上投递语义标记。
		const alreadyBusy = runtime.tab.status === "running";
		const statusBeforePrompt = runtime.tab.status;
		const promptDeliveryBehavior = input.streamingBehavior ?? (alreadyBusy ? "steer" : undefined);

		// 视觉桥：启用时把图片转成文本描述注入 agentMessage（内部指令，不进 UI 气泡）。
		// 图片仍作为 images 传给 RPC——模型支持视觉时不受影响，描述只是补充上下文；
		// 单张转换失败不阻断发送（appLogger 留痕），避免视觉桥故障卡住用户消息。
		const visionBridgeConfig = this.settingsStore.get().visionBridge;
		if (hasImages && isVisionBridgeReady(visionBridgeConfig)) {
			const descriptions = await Promise.all(
				input.images!.map((image) => describeImage(visionBridgeConfig, image)),
			);
			const okTexts = descriptions
				.filter((d): d is { ok: true; text: string } => d.ok)
				.map((d) => d.text);
			const failed = descriptions.filter((d): d is { ok: false; error: string } => !d.ok);
			if (failed.length > 0) {
				void this.appLogger?.warn("vision", "Vision bridge failed for some images", {
					agentId: input.agentId,
					failed: failed.map((f) => f.error),
				});
			}
			if (okTexts.length > 0) {
				const bridgeNote = okTexts
					.map((text, i) => `[图片 ${i + 1} 描述]\n${text}`)
					.join("\n\n");
				agentMessage = `${agentMessage}\n\n${bridgeNote}`;
			}
		}

		// 在设置状态为 running 之前检查进程是否还活着，避免进程崩溃后状态不一致
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			this.addMessage(runtime, "error", errorMessage);
			this.emitState();
			return { accepted: false, error: errorMessage };
		}

		runtime.tab.status = "running";
		this.emitState();

		// 乐观更新：在等待 RPC 返回前先把用户消息写入会话，让用户立即看到自己的消息。
		// 只展示用户原文；agentMessage 里的宿主指令不进 UI 气泡。
		// 如果后续 RPC 失败，再追加错误消息；用户消息本身仍保留在聊天中（用户确已发送）。
		this.addMessage(
			runtime,
			"user",
			trimmed || "[图片]",
			promptDeliveryBehavior ? { streamingBehavior: promptDeliveryBehavior } : undefined,
			input.images,
		);

		// streamingBehavior 只在 agent 忙碌时需要；UI 可以显式传 steer/followUp 以复用 pi 队列语义。
		// 当前端排队 flush 连续发送多条消息时，第一条会触发 agent_start 使 agent 变忙碌，
		// 后续消息必须带 streamingBehavior 否则 pi 直接返回 error。这里自动兜底。
		// images 用于传递粘贴/拖拽的图片，pi 会将 base64 图片直接传给支持视觉的模型。
		try {
			const promptIsExtensionCommand = await this.promptMatchesRegisteredExtensionCommand(runtime, agentMessage);
			const requestPayload: Record<string, unknown> = {
				type: "prompt",
				message: agentMessage,
				...(input.description ? { description: input.description } : {}),
				...(hasImages ? { images: input.images } : {}),
			};
			// 如果 agent 已经忙碌且调用方没指定 streamingBehavior，默认用 steer；
			// 与上方用户消息 meta 保持同一个计算结果，避免 UI 标记和实际 RPC 语义不一致。
			if (promptDeliveryBehavior) {
				requestPayload.streamingBehavior = promptDeliveryBehavior;
			}
			// 使用用户配置的 RPC 超时时间，因为用户提示词可能触发长时间运行的命令或复杂操作
			const response = await runtime.process.client.request(
				requestPayload,
				this.settingsStore.get().rpcTimeout,
			);
			if (!response.success) {
				// pi RPC 会把不支持图片、忙碌队列参数缺失等前置错误作为 success:false 返回；
				// 必须显式显示出来，否则 UI 会停在"已发送但无响应"的状态。
				const errorMessage = response.error ?? "图片消息发送失败";
				runtime.tab.status = statusBeforePrompt === "running" ? "running" : "idle";
				this.addMessage(runtime, "error", errorMessage);
				this.emitState();
				return { accepted: false, error: errorMessage };
			}

			if (promptIsExtensionCommand) {
				// 机制：Pi 扩展命令可在 prompt 阶段直接执行并返回，不进入 agent run。
				// 证据：@earendil-works/pi-coding-agent/dist/core/agent-session.js 中 AgentSession.prompt()
				//      先调用 _tryExecuteExtensionCommand()；命中后 return，不再调用 _runAgentPrompt()。
				// 推导：不能等 agent_end；只有 Pi get_state 明确报告无剩余工作时才恢复 idle。
				this.scheduleIdleCheckAfterExtensionCommand(input.agentId);
			}
			return { accepted: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// prompt RPC 调用前已通过同步 write() 写入 pi stdin；此处所有异常都只说明
			// preflight 响应未到达，无法证明 pi 没有接收。返回 unknown，renderer 会永久禁用
			// 该快照的重试/编辑/取消，防止用户把同一条消息提交两次。
			runtime.tab.status = statusBeforePrompt === "running" ? "running" : "error";
			this.addMessage(
				runtime,
				"error",
				`消息接收结果未知（${errorMessage}）。请先检查当前会话，避免重复发送；必要时重启 Agent。`,
			);
			this.emitState();
			return { accepted: false, error: errorMessage, delivery: "unknown" };
		}
	}

	/**
	 * 执行 bash 命令并通过 tool 消息展示输出，行为与 pi 终端的 !/!! 前缀一致。
	 * excludeFromContext 控制输出是否作为上下文发送给 LLM。
	 */
	private async executeBashCommand(
		agentId: string,
		command: string,
		excludeFromContext: boolean,
	): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(agentId);
		const statusBeforeCommand = runtime.tab.status;
		
		// 检查进程是否还活着
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			this.addMessage(runtime, "error", errorMessage);
			this.emitState();
			return { accepted: false, error: errorMessage };
		}

		runtime.tab.status = "running";
		this.emitState();

		try {
			const response = await runtime.process.client.request(
				{
					type: "bash",
					command,
					excludeFromContext,
				},
				60_000,
			);

			if (!response.success) {
				const errorMessage = response.error ?? "命令执行失败";
				this.addMessage(runtime, "error", `命令执行失败：${errorMessage}`);
				return { accepted: false, error: errorMessage };
			}

			this.addMessage(
				runtime,
				"user",
				`${excludeFromContext ? "!!" : "!"}${command}`,
			);
			const data = response.data as
				| {
						output?: string;
						exitCode?: number;
						cancelled?: boolean;
						truncated?: boolean;
				  }
				| undefined;

			const output = data?.output ?? "";
			const exitCode = data?.exitCode ?? 0;
			const cancelled = data?.cancelled ?? false;

			if (cancelled) {
			this.addMessage(runtime, "system", "命令已取消");
		} else {
			// 以 tool 消息展示命令输出，与 pi 终端的 bash 结果展示保持一致
			const toolMessage = formatBashToolMessage({
				command,
				output,
				exitCode,
				excludeFromContext,
			});
			this.addMessage(runtime, "tool", toolMessage.text, toolMessage.meta);
			// omp 的 RPC bash 不把输出写入会话上下文（实测 get_messages 为空，且 handler 忽略 excludeFromContext）。
			// 旧 pi 依赖 excludeFromContext 字段由 pi 写上下文；omp 下需宿主把 ! 命令的输出显式发回，
			// 否则「!命令 → 执行并将输出发送给 LLM」的语义丢失。!!（excludeFromContext）保持只展示。
			if (!excludeFromContext && output) {
				void runtime.process.client
					.request(
						{
							type: "prompt",
							message: `Command: ${command}\nOutput:\n${output}`,
						},
						this.settingsStore.get().rpcTimeout,
					)
					.catch((error) => {
						void this.appLogger?.error("agent", "Failed to send bash output to LLM", {
							agentId,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}
		}
		return { accepted: true };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// bash 请求也在计时前写入 stdin；异常只能判定响应未知。对于可能有副作用的命令，
		// 把它标成可重试失败会比保守阻止重试更危险。
		runtime.tab.status = statusBeforeCommand === "running" ? "running" : "error";
		this.addMessage(
			runtime,
			"error",
			`命令接收结果未知（${errorMessage}）。请先检查命令输出或工作区状态，避免重复执行。`,
		);
		return { accepted: false, error: errorMessage, delivery: "unknown" };
	} finally {
			if (runtime.tab.status !== "error") {
				runtime.tab.status = statusBeforeCommand === "running" ? "running" : "idle";
			}
			this.emitState();
		}
	}

	async abort(agentId: string) {
		const runtime = this.requireRuntime(agentId);

		// pi 在等待 extension_ui_response 时（如 ask_question），不发 abort 也能处理，
		// 但必须解除 pending 请求的阻塞，否则 pi 不会继续读取 stdin 中的后续命令。
		// 发 cancelled: true 会导致 pi 返回 undefined，ask_question 工具默认选第一个；
		// 改发 value: null（不带 cancelled 标记），select parser 返回 null，
		// 工具 result 的 answer = null，answered 为 false → 卡片显示"已取消"。
		const pending = runtime.pendingUIRequests;
		if (pending.size > 0) {
			runtime.abortedDuringAsk = true;
			for (const [requestId] of pending) {
				runtime.process.client.sendRaw({
					type: "extension_ui_response",
					id: requestId,
					value: null,
				});
			}
		}

		// 标记最近中止的 agent，用于抑制 auto-retry/compaction 把状态重新标为 running。
		// 必须在发送 abort RPC 之前加入集合，避免事件处理函数在 RPC 发出后、
		// handlePiEvent 返回前收到管道中的旧事件并重建 assistant 消息。
		runtime.recentlyAborted = true;
		// 封印当前 stream generation：比 recentlyAborted 更硬，不依赖 activeAssistantMessageIds 例外条件，
		// 残留 thinking/text/tool 事件在 abort settled 前一律丢弃。
		this.sealAgentStream(runtime);
		this.scheduleAbortSettledFallback(runtime);

		runtime.process.client
			.request({ type: "abort" }, 10_000)
			.catch(() => {
				// abort 超时或失败不影响前端状态切换
			});

		// 立即清理 pending UI 记录并移除 ask_question 卡片，不等待 abort 返回
		if (pending.size > 0) {
			const messages = runtime.messages;
			for (const [requestId] of pending) {
				const idx = messages.findIndex(
					(msg) =>
						msg.role === "system" &&
						msg.meta?.type === "askQuestion" &&
						(msg.meta as Record<string, unknown>).uiRequest &&
						((msg.meta as Record<string, unknown>).uiRequest as Record<string, unknown>).requestId === requestId,
				);
				if (idx !== -1) {
					messages.splice(idx, 1);
					this.markMessagesDirty(runtime, idx);
				}
			}
			pending.clear();
		}
		// abort 时必须清除所有流式状态，防止后续 pi 的延迟事件（text_delta、thinking_delta、tool_execution_* 等）
		// 修改上次会话的旧消息，导致新会话消息混入被中止的旧输出。
		runtime.activeAssistantMessageId = undefined;
		runtime.streamingThinking = "";
		runtime.thinkingStartedAt = undefined;
		runtime.thinkingEndedAt = undefined;
		runtime.toolMessageIds.clear();
		runtime.activeToolCalls.clear();
		runtime.toolExecuting = null;
		// 取消节流中的 thinking/message 推送，避免 abort 后还有 pending flush 把旧内容刷回 UI。
		this.thinkingEmitter.cancel(agentId);
		this.emitThinking(agentId, "");
		this.cancelMessageEmit(runtime);

		runtime.tab.status = "idle";
		// 停止反馈改 toast，不再写入会话时间线：
		// 1) 系统状态卡片太抢眼；2) 插在 assistant 中间会打断 agent-run 分组，放大“消息串台”体感。
		this.emit(ipcChannels.agentsNotice, {
			agentId,
			message: "已请求停止当前响应",
			i18nKey: "app.abortRequested",
			kind: "info",
			duration: 2500,
		});
		this.emitState();
	}

	/**
	 * 手动触发上下文压缩。pi 会将历史消息摘要化以释放 context 空间，
	 * 适用于长时间对话后 context 占比过高、但不想丢失关键信息的场景。
	 *
	 * 注意：pi 在压缩完成后可能会自动重启进程（尤其早期版本），此时 RPC 请求会因
	 * "pi exited" 错误而失败。本方法检测到进程退出后会自动重连同一会话并加载消息，
	 * 因此调用方不应把 RPC 失败等同于压缩失败。
	 */
	async compact(agentId: string, prompt?: string) {
		const runtime = this.requireRuntime(agentId);
		// pi RPC 字段是 customInstructions（不是 prompt）；传错字段会被静默忽略，
		// `/compact 自定义说明` 看起来像“命令无效/没按要求压缩”。
		const customInstructions = prompt?.trim() || undefined;
		const startTime = Date.now();

		void this.appLogger?.info("agent", "Compact requested", {
			agentId,
			customInstructions,
			hasSessionPath: !!runtime.tab.sessionPath,
		});

		// 标记压缩中：exit 处理器据此区分压缩重启与异常崩溃；
		// 同时参与 isCompacting，避免 UI 在 RPC 往返期间误判为空闲。
		runtime.compacting = true;
		runtime.rpcCompacting = true;
		if (runtime.tab.status !== "error" && runtime.tab.status !== "closed") {
			runtime.tab.status = "running";
			this.emitState();
			void this.emitRuntimeState(agentId);
		}

		try {
			const response = await runtime.process.client.request(
				customInstructions
					? { type: "compact", customInstructions }
					: { type: "compact" },
				// 大会话摘要可能远超 30s 默认超时；与 summarization + retry 对齐放宽。
				180_000,
			);
			void this.appLogger?.info("agent", "Compact RPC response received", {
				agentId,
				elapsedMs: Date.now() - startTime,
				rpcSuccess: response.success,
				rpcError: response.error,
			});

			// 手动 compact 不会再发 agent_settled；若 RPC 失败却仍把 status 留在 running，
			// 侧栏/输入区会永久卡在 busy。失败必须明确抛出并在 finally 里收口状态。
			if (!response.success) {
				throw new Error(response.error || "Compaction failed");
			}

			// 压缩成功且进程未退出：重载消息，展示压缩边界卡片。
			await this.loadMessages(agentId).catch(() => undefined);
			void this.appLogger?.info("agent", "Compact completed successfully", {
				agentId,
				totalElapsedMs: Date.now() - startTime,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const processAlive = runtime.process.isRunning();
			void this.appLogger?.error("agent", "Compact failed", {
				agentId,
				elapsedMs: Date.now() - startTime,
				error: errorMsg,
				processAlive,
				hasSessionPath: !!runtime.tab.sessionPath,
			});

			// 如果进程在压缩期间退出（部分 pi 版本压缩后会重启），
			// RPC 会因连接断开失败，但压缩可能已写入 session。尝试重连同一会话。
			if (!processAlive && runtime.tab.sessionPath) {
				void this.appLogger?.info("agent", "Compact: process exited, reattaching", {
					agentId,
				});
				await this.reattachProcess(agentId, runtime.tab.sessionPath);
				await this.loadMessages(agentId).catch(() => undefined);
				this.addMessage(runtime, "system", "会话压缩完成");
				void this.appLogger?.info("agent", "Compact: reattach succeeded", {
					agentId,
					totalElapsedMs: Date.now() - startTime,
				});
			} else {
				// 会话过小 / Already compacted / 鉴权失败等：把可读错误抛给渲染进程 toast。
				throw error;
			}
		} finally {
			// 手动 compact 路径没有可靠的 agent_settled；无论成败都必须收口 compacting 标记，
			// 并把非 error/closed 会话恢复 idle，否则 UI 会“压缩完了还停着/一直转圈”。
			this.finishManualCompaction(agentId);
		}

		return this.getRuntimeState(agentId);
	}

	/**
	 * 手动压缩收口：清 compacting 集合，并在安全时把 tab 置 idle。
	 * compact_start 会把 status 设为 running，但手动 compact 结束后通常没有 agent_settled。
	 */
	private finishManualCompaction(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		runtime.compacting = false;
		runtime.rpcCompacting = false;
		if (
			runtime.tab.status !== "error" &&
			runtime.tab.status !== "closed" &&
			runtime.tab.status !== "starting"
		) {
			runtime.tab.status = "idle";
		}
		this.emitState();
		void this.emitRuntimeState(agentId);
	}

	/**
	 * 进程退出后重新附加到同一会话：创建新的 PiProcess 并替换旧的进程引用。
	 * 在压缩导致 pi 进程自动重启后调用，保持同一 agentId 可继续对话。
	 *
	 * 与 create() 中创建过程的区别：不重新分配 agentId、不解绑项目，
	 * 只替换底层的 pi 进程和 RPC 客户端，保留所有消息和 tab 状态。
	 */
	private async reattachProcess(agentId: string, sessionPath: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error("Agent not found: " + agentId);

		const project = this.getProject(runtime.tab.projectId);
		if (!project) throw new Error("Project not found");

		void this.appLogger?.info("agent", "Reattaching process", {
			agentId,
			sessionPath,
		});

		const process = new PiProcess(project.path, this.settingsStore.get(), undefined, {
			agentHomeDir: this.wslEnvironment?.windowsHome,
		});
		// 与 createUnlocked 一致：先挂生命周期监听，再 start，避免 error 事件无 listener。
		this.attachPiProcessLifecycle(agentId, process, {
			projectPath: project.path,
			onExit: (payload) => this.handleReattachProcessExit(agentId, runtime, payload),
		});
		const client = await process.start(sessionPath);
		const restartDiag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process restarted", {
			agentId,
			command: restartDiag?.command,
			args: restartDiag?.args?.join(' '),
			cwd: restartDiag?.cwd,
		});

		// 替换旧进程引用（但不修改 agents map 中的 key）
		runtime.process = process;

		try {
			const stateResponse = await client.request({ type: "get_state" }, this.settingsStore.get().rpcTimeout);
			const data = stateResponse.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
			runtime.tab.sessionPath = data?.sessionFile ?? sessionPath;
			runtime.tab.title = data?.sessionName ?? runtime.tab.title;
			runtime.tab.status = "idle";
			// 进程退出型压缩可能来不及发 compaction_end；重连成功即表示 Pi 已可继续接收消息。
			runtime.rpcCompacting = false;

			// 重连成功后清除自动重连标记，允许下一次再触发
			runtime.autoRestartAttempted = false;

			// 如果有旧的 pending abort 标记，清理掉
			runtime.abortedDuringAsk = false;

			await this.loadMessages(agentId).catch(() => undefined);

			void this.appLogger?.info("agent", "Process reattached successfully", {
				agentId,
			});
		} catch (error) {
			void this.appLogger?.error("agent", "Process reattach failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		const [stateResponse, statsResponse] = await Promise.all([
			runtime.process.client
				.request({ type: "get_state" })
				.catch(() => ({ data: undefined })),
			runtime.process.client
				.request({ type: "get_session_stats" })
				.catch(() => ({ data: undefined })),
		]);
		const state = stateResponse.data as any;
		const stats = statsResponse.data as any;
		// omp 的 get_state.model 是对象（{id,name,provider,...}），旧 pi 可能是字符串模型名。
		// 字符串时包成对象，下游 model?.name / model?.id 统一读取。
		const model =
			typeof state?.model === "string"
				? { name: state.model }
				: state?.model;
		const contextUsage = stats?.contextUsage ?? stats?.context_usage;
		const tokens = stats?.tokens;
		const inputTokens = this.pickNumber(
			tokens?.input,
			tokens?.inputTokens,
			tokens?.prompt,
			tokens?.promptTokens,
			stats?.inputTokens,
			stats?.usage?.input,
		);
		const outputTokens = this.pickNumber(
			tokens?.output,
			tokens?.outputTokens,
			tokens?.completion,
			tokens?.completionTokens,
			stats?.outputTokens,
			stats?.usage?.output,
		);
		const cacheRead = this.pickNumber(
			tokens?.cacheRead,
			tokens?.cache?.read,
			stats?.cacheRead,
			stats?.usage?.cacheRead,
		);
		const cacheWrite = this.pickNumber(
			tokens?.cacheWrite,
			tokens?.cache?.write,
			stats?.cacheWrite,
			stats?.usage?.cacheWrite,
		);
		const directCacheHitPercent = this.pickNumber(
			tokens?.cacheHitPercent,
			tokens?.cacheHitRate != null ? tokens.cacheHitRate * 100 : undefined,
			stats?.cacheHitPercent,
			stats?.cacheHitRate != null ? stats.cacheHitRate * 100 : undefined,
		);
	/**
	 * 使用最新一条 assistant 消息的缓存命中率，与 pi CLI footer 保持一致。
	 * pi 的 get_session_stats RPC 不直接返回 cacheHitPercent，需读取 session 文件。
	 */
		const computedCacheHitPercent = runtime.tab.sessionPath
				? await this.sessionJsonl.getLatestCacheMessageHitRate(runtime.tab.sessionPath)
				: undefined;
		const cacheHitPercent = this.clampPercent(
			directCacheHitPercent ?? computedCacheHitPercent,
		);
		return {
			modelName: model?.name ?? model?.id,
			provider: model?.provider,
			modelId: model?.id,
			thinkingLevel: state?.thinkingLevel ?? state?.thinking_level,
			// omp 的 get_state 布尔字段可能是字符串（"true"/"false"），truthy 判定会
			// 把 "false" 当成真值，导致响应完成后 isStreaming/isCompacting 永远为真、
			// 空闲检查无法通过、左下角三点指示器卡住。这里严格归一化为布尔。
			isStreaming: state?.isStreaming === true,
			isCompacting:
				state?.isCompacting === true ||
				runtime.rpcCompacting ||
				runtime.compacting,
			/** 工具执行状态从本地追踪，无需 Pi 进程查询 */
			isExecutingTool: !!runtime.toolExecuting,
			executingToolName: runtime.toolExecuting ?? undefined,
			toolStateSequence: runtime.toolStateSequence,
			contextTokens: contextUsage?.tokens,
			contextWindow: contextUsage?.contextWindow ?? model?.contextWindow,
			contextPercent: contextUsage?.percent,
			inputTokens,
			outputTokens,
			cacheRead,
			cacheWrite,
			cacheTotal:
				cacheRead != null || cacheWrite != null
					? (cacheRead ?? 0) + (cacheWrite ?? 0)
					: undefined,
			cacheHitPercent,
			cost: stats?.cost,
		};
	}

	private applyActiveToolCallState(runtime: AgentRuntime, state: ActiveToolCallState) {
		if (state.calls.size > 0) {
			runtime.activeToolCalls = state.calls;
			runtime.toolExecuting = state.executingToolName ?? "tool";
			this.emitToolRuntimeTransition(
				runtime,
				true,
				state.executingToolName ?? "tool",
			);
			return;
		}
		runtime.activeToolCalls.clear();
		runtime.toolExecuting = null;
		this.emitToolRuntimeTransition(runtime, false);
	}

	private emitToolRuntimeTransition(
		runtime: AgentRuntime,
		isExecutingTool: boolean,
		executingToolName?: string,
	) {
		runtime.toolStateSequence += 1;
		// 工具边沿直接从原始 pi 事件发出，不等待 get_state/get_session_stats。
		// 这样即使工具极快完成或完整状态请求乱序，renderer 仍能稳定看到 true → false。
		this.emit(ipcChannels.agentsRuntimeState, {
			agentId: runtime.tab.id,
			state: {
				isExecutingTool,
				executingToolName,
				toolStateSequence: runtime.toolStateSequence,
			},
		});
	}

	private async emitRuntimeState(agentId: string) {
		// 最小间隔节流：工具密集循环中每个事件都触发 getRuntimeState（get_state +
		// get_session_stats 两次 RPC + 缓存命中率读取），间隔 <150ms 的请求延后到
		// 间隔满时以最新状态补发一次（latest-wins，与 in-flight 合并互补）。
		const now = Date.now();
		const lastEmit = this.runtimeStateLastEmitAt.get(agentId);
		if (lastEmit !== undefined && now - lastEmit < AgentManager.RUNTIME_STATE_MIN_INTERVAL_MS) {
			if (!this.runtimeStateThrottleTimers.has(agentId)) {
				const delay = AgentManager.RUNTIME_STATE_MIN_INTERVAL_MS - (now - lastEmit);
				const timer = setTimeout(() => {
					this.runtimeStateThrottleTimers.delete(agentId);
					void this.emitRuntimeState(agentId);
				}, delay);
				timer.unref?.();
				this.runtimeStateThrottleTimers.set(agentId, timer);
			}
			return;
		}
		// 在途合并：请求进行中再来新请求只标记 pending，完成后再补发一次最新状态。
		// 工具边沿（tool_execution_start/end）已由 emitToolRuntimeTransition 同步推送，
		// 完整状态的中间版本晚到/合并都不会丢失工具真值（toolStateSequence 兜底）。
		if (this.runtimeStateInFlight.has(agentId)) {
			this.runtimeStatePending.add(agentId);
			return;
		}
		this.runtimeStateInFlight.add(agentId);
		this.runtimeStateLastEmitAt.set(agentId, Date.now());
		// 调用发起时分配单调序号：慢 RPC（长任务后 omp 繁忙）可能晚于更新的快照
		// 到达渲染层，渲染层按序号丢弃旧快照，避免旧 isStreaming:true 覆盖已 idle 状态。
		const runtime0 = this.agents.get(agentId);
		const seq = runtime0 ? runtime0.runtimeStateSeq + 1 : 1;
		if (runtime0) runtime0.runtimeStateSeq = seq;
		try {
			const state = await this.getRuntimeState(agentId);
			const runtime = this.agents.get(agentId);
			// getRuntimeState 包含异步 RPC；若期间 agent 已被删除，或发生新工具事件，
			// 工具字段保留调用完成时的最新本地真值和序号。
			if (!runtime) return;
			state.runtimeStateSeq = seq;
			state.isExecutingTool = !!runtime.toolExecuting;
			state.executingToolName = runtime.toolExecuting ?? undefined;
			state.toolStateSequence = runtime.toolStateSequence;
			this.emit(ipcChannels.agentsRuntimeState, { agentId, state });
			// 语义事件：完整运行态就绪后同步发给语义订阅者（与 IPC 推送同一份 state，
			// 含调用完成时写入的 runtimeStateSeq/toolStateSequence 等真值字段）。
			this.notifyEventListeners({ type: "runtimeStateChanged", agentId, state });
		} catch {
			// 运行态刷新失败不影响主流程；下一次轮询或事件会继续同步。
		} finally {
			this.runtimeStateInFlight.delete(agentId);
			// 期间又有新请求：以最新状态补发一次（最多一轮，不再递归叠加）
			if (this.runtimeStatePending.delete(agentId)) {
				void this.emitRuntimeState(agentId);
			}
		}
	}

	private pickNumber(...values: unknown[]) {
		for (const value of values) {
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (typeof value === "string" && value.trim()) {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
		return undefined;
	}

	private clampPercent(value: number | undefined) {
		if (value == null || !Number.isFinite(value)) return undefined;
		return Math.max(0, Math.min(100, value));
	}

	async cycleModel(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request({ type: "cycle_model" }, 60_000);
		return this.getRuntimeState(agentId);
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "get_available_models" },
			60_000,
		);
		const models = ((response.data as any)?.models ?? []) as AvailableModel[];
		// pi 会把有 Key（含环境变量）的供应商内置目录也返回，这里只保留 models.json 显式配置的模型
		return this.configManager.filterConfiguredModels(models);
	}

	async setModel(agentId: string, provider: string, modelId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request(
			{ type: "set_model", provider, modelId },
			60_000,
		);
		return this.getRuntimeState(agentId);
	}

	/**
	 * 刷新模型配置：让运行中的 agent 重新加载 models.json，无需完全重启。
	 *
	 * 当前仅支持轻量级 reload_config RPC（策略 1）。
	 * 策略 2（进程重启）已注释，等待 pi 官方支持 reload_config RPC 后再考虑：
	 *   - 运行中的 Agent 重启进程会打断正在进行的对话/工具执行
	 *   - 进程重启涉及 exit 事件竞态、模型恢复等复杂边界条件
	 *
	 * RPC 提案：https://github.com/earendil-works/pi/issues/6890
	 * pi 合并 reload_config 后，本方法将自动生效，无需任何修改。
	 */
	async refreshModels(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		const startTime = Date.now();

		void this.appLogger?.info("agent", "Model refresh requested", { agentId });

		// 策略 1：尝试 reload_config RPC（轻量级，无需重启进程）
		// 该命令在 pi model-runtime 中已实现为 reloadConfig()，会重新读取 models.json
		// 并重建所有 provider。当前 pi 0.80.10 的 RPC 协议尚未暴露此命令，
		// 待 pi 合并 https://github.com/earendil-works/pi/issues/6890 后自动生效。
		try {
			const response = await runtime.process.client.request(
				{ type: "reload_config" },
				8_000,
			);
			if (response.success) {
				await this.loadMessages(agentId).catch(() => undefined);
				void this.appLogger?.info("agent", "Model refresh succeeded via reload_config RPC", {
					agentId,
					elapsedMs: Date.now() - startTime,
				});
				this.emitState();
				return this.getRuntimeState(agentId);
			}
		} catch {
			// reload_config 尚不支持，当前 pi 版本无轻量级刷新路径
		}

		// 策略 2（已注释）：进程重启方案。
		// 原因：运行中重启会打断用户对话、工具执行，且涉及 exit 事件竞态。
		// 等 pi 官方支持 reload_config RPC 后，策略 1 自动生效，无需回退到策略 2。
		//
		// const sessionPath = runtime.tab.sessionPath;
		// if (!sessionPath) {
		// 	throw new Error("Cannot refresh models: agent has no session path");
		// }
		// this.modelRefreshing = true;
	// try {
	// 	const previousState = await this.getRuntimeState(agentId).catch(() => null);
	// 	runtime.process.stop();
	// 	await new Promise<void>((resolve) => setTimeout(resolve, 600));
	// 	await this.reattachProcess(agentId, sessionPath);
	// 	if (previousState?.provider && previousState?.modelId) {
	// 		try { await this.setModel(agentId, previousState.provider, previousState.modelId); } catch {}
	// 	}
	// 	runtime.tab.status = "idle";
	// 	await this.loadMessages(agentId).catch(() => undefined);
	// } finally {
	// 	runtime.modelRefreshing = false;
	// }

		void this.appLogger?.info("agent", "Model refresh: reload_config not supported by current pi version, skipping", {
			agentId,
			elapsedMs: Date.now() - startTime,
		});
		this.emitState();
		return this.getRuntimeState(agentId);
	}

	async cycleThinking(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request(
			{ type: "cycle_thinking_level" },
			60_000,
		);
		return this.getRuntimeState(agentId);
	}

	async setThinking(agentId: string, level: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request(
			{ type: "set_thinking_level", level },
			60_000,
		);
		return this.getRuntimeState(agentId);
	}

	/**
	 * 使用 pi �� switch_session RPC ���ص�ǰ�Ự���������½��̡�
	 * ���̣��༭ JSONL → �ĵ�һ�� JSON ������ _reloadMarker �ֶ� → switch_session
	 * → pi ���ֵ�һ�����ݱ仯→������Ч→���¶�ȡ → �Ƴ� _reloadMarker �ֶΡ�
	 *
	 * ��ȣ��ɷ������б�ǩ�У����� _reloadMarker ��Ϊ�ֶ�д���һ�е� JSON �У�
	 * ���ı��ļ��нṹ������ marker δ��������ļ���Ȼ�ǺϷỰ���ɱ� pi ������
	 */
	private async reloadSession(agentId: string) {
		const startTime = Date.now();
		const runtime = this.requireRuntime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session path not available for reload");
		const sessionHostPath = this.toSessionHostPath(sessionPath);
		const sessionProtocolPath = this.toSessionProtocolPath(sessionPath);

		const markerId = randomUUID();

		try {
			const raw = await readFile(sessionHostPath, "utf8");
			const lines = raw.split(/\r?\n/);
			if (lines.length === 0 || !lines[0].trim()) {
				throw new Error("Session file is empty");
			}
			// �ĵ�һ�� JSON ���󣬼��� _reloadMarker �ֶΣ����� pi ���·������Ļ��档
			// ֻ�ĵ�һ�е����ݣ����ı��нṹ��ʹ marker ���������ļ���Ȼ�ǺϷỰ��
			const firstLine = JSON.parse(lines[0]) as Record<string, unknown>;
			delete firstLine._reloadMarker; // 先清除旧的，确保值不同
			firstLine._reloadMarker = markerId;
			lines[0] = JSON.stringify(firstLine);
			await writeFile(sessionHostPath, lines.join("\n"), "utf8");

			void this.appLogger?.info("agent", "Session reload: switch_session start", {
				agentId,
				markerId,
				elapsedMs: Date.now() - startTime,
			});

			const response = await runtime.process.client.request({
				type: "switch_session",
				sessionPath: sessionProtocolPath,
			}, 30_000);

			void this.appLogger?.info("agent", "Session reload: switch_session done", {
				agentId,
				markerId,
				success: response.success,
				elapsedMs: Date.now() - startTime,
			});

			// �ָ���һ�У��Ƴ� _reloadMarker �ֶΣ������ļ���ԭʼ״̬
			try {
				const afterRaw = await readFile(sessionHostPath, "utf8");
				const afterLines = afterRaw.split(/\r?\n/);
				if (afterLines.length > 0 && afterLines[0].includes("_reloadMarker")) {
					const restored = JSON.parse(afterLines[0]) as Record<string, unknown>;
					delete restored._reloadMarker;
					afterLines[0] = JSON.stringify(restored);
					await writeFile(sessionHostPath, afterLines.join("\n"), "utf8");
				}
			} catch {
				// _reloadMarker �ֶ����� residue ���ᵼ�� pi ���Է�����������Ӱ���Ựʹ��
			}

			if (!response.success) {
				void this.appLogger?.error("agent", "Session reload: switch_session failed", {
					agentId,
					error: response.error,
					elapsedMs: Date.now() - startTime,
				});
				throw new Error(response.error ?? "switch_session failed");
			}

			await this.loadMessages(agentId);
		} catch (error) {
			void this.appLogger?.error("agent", "Session reload failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
				elapsedMs: Date.now() - startTime,
			});
			throw error;
		}
	}

	/**
	 * 检查 Agent 是否处于可编辑/可删除的安全状态。
	 * 要求：isStreaming === false && isCompacting !== true && tab.status !== "running"
	 * 编辑/删除操作依赖 pi RPC 的 switch_session，在 busy 状态下行为不确定。
	 */
	private async ensureAgentIdle(agentId: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		if (runtime.tab.status === "running") {
			// 先查一次 runtime state 确认 stream 状态
			try {
				const state = await this.getRuntimeState(agentId);
				if (state.isStreaming || state.isCompacting) {
					throw new Error("BUSY_STREAMING: Agent is streaming, please wait");
				}
				// isExecutingTool 时也视为 busy
				if (state.isExecutingTool) {
					throw new Error("BUSY_TOOL: Agent is executing a tool, please wait");
				}
			} catch (error) {
				// 如果 getRuntimeState 本身失败，但 tab.status 为 running，仍然拒绝
				if (error instanceof Error && error.message.startsWith("BUSY_")) {
					throw error;
				}
				throw new Error("BUSY_GENERIC: Agent is currently busy, please try again later");
			}
		}
	}

	/**
	 * 会话文件写入互斥锁：确保同一 agent 的 readFile→modify→writeFile 原子化。
	 * 防止并发编辑/删除操作同时读取 JSONL 后互相覆盖。
	 * 前一个操作完成（无论成功或失败）后，下一个操作才会开始。
	 */
	private async withSessionLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
		const runtime = this.requireRuntime(agentId);
		const prev = runtime.sessionLock ?? Promise.resolve();
		const next = prev.then(() => fn(), () => fn());
		// 链式尾部 catch 防止单个操作的失败阻断后续队列
		runtime.sessionLock = next.then(() => {}, () => {});
		return await next;
	}

	/**
	 * 编辑消息：修改 JSONL 中的 text 后通过 switch_session 重载，不重启进程。
	 * 前端需在 agent idle 时调用。
	 *
	 * 文件读改写、备份、按 entryId 定位均已委托给 SessionJsonl：
	 *   - sessionJsonl.modifyLines 负责 read→mutate→backup→write 原子封装；
	 *   - sessionJsonl.locateEntry 负责在 lines 中按 entryId/msg.id/文本三段式定位；
	 *   - sessionJsonl.restoreFromBackup 负责 reload 失败时回滚 JSONL。
	 * 本方法只保留 agent 状态相关的编排：空闲检查、锁、reload、内存消息回滚。
	 *
	 * messages/msg 查找放在 modifyLines 的 mutator 内部，以保持原顺序：
	 * 先读文件（空文件校验）再查内存消息，避免双失败时错误信息发生变化。
	 */
	async editMessage(agentId: string, messageId: string, newText: string) {
		const startTime = Date.now();
		void this.appLogger?.info("agent", "Edit message requested", { agentId, messageId });

		await this.withSessionLock(agentId, async () => {
			// 1. 检查 Agent 空闲状态
			await this.ensureAgentIdle(agentId);

			const runtime = this.requireRuntime(agentId);
			const sessionPath = runtime.tab.sessionPath;
			if (!sessionPath) throw new Error("Session not persisted");

			await this.sessionJsonl.modifyLines(sessionPath, (lines) => {
				const messages = runtime.messages;
				const msg = messages.find((m) => m.id === messageId);
				if (!msg) throw new Error("Message not found");

				// 2. 定位 JSONL 行（优先 entryId，回退 msg.id 提取 / 角色+文本匹配）
				const { lineIndex, entry } = this.sessionJsonl.locateEntry(lines, messages, msg);
				const role = (entry as any)?.message?.role;

				if (role !== "user" && role !== "assistant") {
					throw new Error("Only user and assistant messages can be edited");
				}

				// 3. 修改 text（modifyLines 会在 mutator 成功后自动 backup + 写回）
				const wrapped = entry as { message?: Record<string, any> };
				const content = wrapped.message!.content;
				if (Array.isArray(content)) {
					const textBlock = content.find((c: any) => c.type === "text");
					if (textBlock) {
						textBlock.text = newText;
					} else {
						content.push({ type: "text", text: newText });
					}
				} else {
					wrapped.message!.content = [{ type: "text", text: newText }];
				}
				lines[lineIndex] = JSON.stringify(entry);
			});

			// 4. 使用 _reloadMarker 重载 pi 会话
			// 注意：不再手动更新桌面端内存——reloadSession 内部调用 loadMessages
			// 会从 pi 拉取最新消息列表，保持桌面端与 pi 状态一致。
			try {
				await this.reloadSession(agentId);
			} catch (error) {
				// reload 失败时从备份恢复 JSONL
				const errMsg = error instanceof Error ? error.message : String(error);
				void this.appLogger?.error("agent", "Edit message: reload failed, restoring backup", {
					agentId,
					messageId,
					error: errMsg,
					elapsedMs: Date.now() - startTime,
				});
				try {
					const restored = await this.sessionJsonl.restoreFromBackup(sessionPath);
					if (restored) {
						await this.loadMessages(agentId).catch(() => {});
					}
				} catch (restoreError) {
					void this.appLogger?.error("agent", "Edit message: failed to restore backup", {
						agentId,
						error: restoreError instanceof Error ? restoreError.message : String(restoreError),
					});
				}
				throw error;
			}
		});

		void this.appLogger?.info("agent", "Edit message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	/**
	 * 删除消息：在 JSONL 中用 deleted 标记替换对应行后通过 switch_session 重载。
	 *
	 * 相比旧版本（置空行导致 JSONL 行数偏移），本方案：
	 * - 用 {"type":"deleted","originalEntryId":"...","ts":...} 替换原行
	 * - 同时将删掉 entry 的子 entry 的 parentId 重定向到被删 entry 的父节点（re-parenting），
	 *   确保 pi 重载 session tree 时不会因 dangling parentId 丢弃整个子分支
	 * - 保留行号稳定，不破坏行数对齐
	 * - entryId 精确定位不受之前删除操作影响
	 *
	 * 文件读改写/备份/定位/回滚同 editMessage，委托给 SessionJsonl。
	 */
	async deleteMessage(agentId: string, messageId: string) {
		const startTime = Date.now();
		void this.appLogger?.info("agent", "Delete message requested", { agentId, messageId });

		await this.withSessionLock(agentId, async () => {
			// 1. 检查 Agent 空闲状态
			await this.ensureAgentIdle(agentId);

			const runtime = this.requireRuntime(agentId);
			const sessionPath = runtime.tab.sessionPath;
			if (!sessionPath) throw new Error("Session not persisted");

			await this.sessionJsonl.modifyLines(sessionPath, (lines) => {
				const messages = runtime.messages;
				const msg = messages.find((m) => m.id === messageId);
				if (!msg) throw new Error("Message not found");

				// 2. 定位 JSONL 行（优先 entryId）
				const { lineIndex, entry } = this.sessionJsonl.locateEntry(lines, messages, msg);
				const deletedEntryId = (entry as any)?.id;
				const deletedParentId = (entry as any)?.parentId;
				const foundRole = (entry as any)?.message?.role;
				console.log(`[deleteMessage] lineIndex=${lineIndex}, entryId=${deletedEntryId?.slice(0, 12) ?? "(none)"}, parentId=${deletedParentId?.slice(0, 12) ?? "(null)"}, entryRole=${foundRole ?? "(none)"}`);

				// 3. Re-parenting：将删掉 entry 的所有直接子节点的 parentId 指向被删 entry 的父节点。
				// 这样 pi 在 switch_session 重载 session tree 时，子节点不会因为
				// 父节点消失而变成 dangling orphan，避免 pi 丢弃整个子分支（“删一条丢多条”）。
				if (deletedEntryId && deletedParentId !== undefined) {
					for (let i = 0; i < lines.length; i++) {
						if (i === lineIndex) continue;
						const childLine = lines[i].trim();
						if (!childLine) continue;
						try {
							const child = JSON.parse(childLine);
							if (child.parentId === deletedEntryId) {
								child.parentId = deletedParentId;
								lines[i] = JSON.stringify(child);
							}
						} catch { /* 跳过无法解析的行 */ }
					}
				}

				// 4. 用 deleted 标记替换原行（不保留 id 字段，
				// 避免 pi 的 get_entries 返回已删 entry 导致 activeEntryIds 与 messages 不匹配）
				lines[lineIndex] = JSON.stringify({
					type: "deleted",
					originalEntryId: deletedEntryId ?? `unknown-${messageId}`,
					ts: Date.now(),
				});
			});

			// 5. 使用 _reloadMarker 重载 pi 会话
			// 不再手动更新 desktop 内存——reloadSession 内部调用 loadMessages
			// 从 pi 拉取最新消息列表
			try {
				await this.reloadSession(agentId);
			} catch (error) {
				// reload 失败时从备份恢复 JSONL
				const errMsg = error instanceof Error ? error.message : String(error);
				void this.appLogger?.error("agent", "Delete message: reload failed, restoring backup", {
					agentId,
					messageId,
					error: errMsg,
					elapsedMs: Date.now() - startTime,
				});
				try {
					const restored = await this.sessionJsonl.restoreFromBackup(sessionPath);
					if (restored) {
						await this.loadMessages(agentId).catch(() => {});
					}
				} catch (restoreError) {
					void this.appLogger?.error("agent", "Delete message: failed to restore backup", {
						agentId,
						error: restoreError instanceof Error ? restoreError.message : String(restoreError),
					});
				}
				throw error;
			}
		});

		void this.appLogger?.info("agent", "Delete message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	/**
	 * 按需读取消息完整文本（工具结果截断后的「查看完整输出」）。
	 * 优先运行时内存缓存（toolFullTextByMessageId，仅截断下发的完整文本），
	 * 回退按 entryId 在会话文件里定位读取；找不到或读取失败抛错，由 IPC 层转结构化错误。
	 */
	async readMessageFullText(
		agentId: string,
		messageId: string,
		entryId?: string,
	): Promise<{ text: string }> {
		const cached = this.toolFullTextByMessageId.get(messageId);
		if (cached !== undefined) return { text: cached };
		const runtime = this.agents.get(agentId);
		const sessionPath = runtime?.tab.sessionPath;
		if (sessionPath && entryId) {
			const text = await this.sessionJsonl.readEntryTextById(sessionPath, entryId);
			if (text !== null) return { text };
		}
		throw new Error("Message full text unavailable");
	}

	/**
	 * 同文件重发：截断该用户消息及其所有后代（assistant/tool 等），再返回可重新 prompt 的原文。
	 * 不调用 fork，因此不会生成新的会话文件。
	 *
	 * 文件读改写/备份/定位/回滚委托给 SessionJsonl；本方法保留重发独有的硬护栏：
	 * 只允许截断「文件中最后一条 user」，避免误删更早历史。
	 */
	async prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }> {
		const startTime = Date.now();
		void this.appLogger?.info("agent", "Prepare resend requested", { agentId, messageId });

		return await this.withSessionLock(agentId, async () => {
			await this.ensureAgentIdle(agentId);

			const runtime = this.requireRuntime(agentId);
			const sessionPath = runtime.tab.sessionPath;
			if (!sessionPath) throw new Error("Session not persisted");

			const messages = runtime.messages;
			const msg = messages.find((m) => m.id === messageId);
			if (!msg) throw new Error("Message not found");
			if (msg.role !== "user") throw new Error("Only user messages can be resent");

			// modifyLines 返回 mutator 的返回值（截断条数），用于完成日志。
			const removed = await this.sessionJsonl.modifyLines<number>(sessionPath, (lines) => {
				let lineIndex = -1;
				let entry: Record<string, any>;
				try {
					const located = this.sessionJsonl.locateEntry(lines, messages, msg);
					lineIndex = located.lineIndex;
					entry = located.entry;
					// entryId 错位时可能定位到 assistant 或更早的 user；
					// 校验失败则回退到「最后一条同文案 user」，禁止带着错误根继续截断。
					assertResendRootEntry(entry, msg.text, (content) => extractMessageText(content));
				} catch (locateError) {
					const fallback = findLastUserMessageLine(lines, msg.text, (content) =>
						extractMessageText(content),
					);
					if (!fallback) throw locateError;
					void this.appLogger?.warn("agent", "Prepare resend: entry locate mismatch, using last text match", {
						agentId,
						messageId,
						error: locateError instanceof Error ? locateError.message : String(locateError),
					});
					lineIndex = fallback.lineIndex;
					entry = fallback.entry;
					assertResendRootEntry(entry, msg.text, (content) => extractMessageText(content));
				}

				// 兜底验证：确保定位到的 entry 是文件中最后一条同文本 user 消息。
				// entryId 错位时（如 get_entries 与 get_messages 排列不一致）可能匹配到
				// 更早的重复文案，误删不该删的历史内容。
				// 纯文本消息用 findLastUserMessageLine 做二次校验；图片消息（text="[图片]"）不走此路径。
				if (msg.text !== "[图片]") {
					const lastMatch = findLastUserMessageLine(lines, msg.text, (content) =>
						extractMessageText(content),
					);
					if (lastMatch && lastMatch.lineIndex !== lineIndex) {
						void this.appLogger?.warn("agent", "Prepare resend: entryId points to non-last duplicate, correcting", {
							agentId,
							messageId,
							originalLine: lineIndex,
							correctedLine: lastMatch.lineIndex,
							originalEntryId: (entry as any)?.id?.slice(0, 12),
							correctedEntryId: (lastMatch.entry as any)?.id?.slice(0, 12),
						});
						lineIndex = lastMatch.lineIndex;
						entry = lastMatch.entry;
						assertResendRootEntry(entry, msg.text, (content) => extractMessageText(content));
					}
				}

				const rootEntryId = typeof (entry as any)?.id === "string" ? String((entry as any).id) : undefined;
				if (!rootEntryId) throw new Error("User message entryId missing");

				// 硬护栏：重发只允许截断「文件中最后一条 user」。
				// 若定位到更早的 user，descendant 截断会把其后整段历史一起删掉——这正是
				// 「点重发把之前消息全没了」的根因；宁可失败也不误删。
				const lastUserInFile = findLastUserMessageLine(
					lines,
					// 用自身文本做定位；若重复文案，findLast 已取最后一次。
					// 下面再扫一遍确认 root 确实是全局最后一条 user（不限文本）。
					msg.text,
					(content) => extractMessageText(content),
				);
				let lastUserLineIndex = lastUserInFile?.lineIndex ?? -1;
				let lastUserEntryId =
					typeof lastUserInFile?.entry?.id === "string"
						? String(lastUserInFile.entry.id)
						: undefined;
				// 不依赖文案：扫描文件中最后一条 role=user，防止「最后一条 user 文本不同」时误判。
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i]?.trim();
					if (!line) continue;
					try {
						const parsed = JSON.parse(line) as {
							id?: string;
							type?: string;
							message?: { role?: string };
						};
						if (parsed.type === "deleted") continue;
						if (parsed.message?.role === "user" && typeof parsed.id === "string") {
							lastUserLineIndex = i;
							lastUserEntryId = parsed.id;
						}
					} catch {
						/* 跳过 */
					}
				}
				if (
					lastUserEntryId &&
					(lastUserEntryId !== rootEntryId || lastUserLineIndex !== lineIndex)
				) {
					void this.appLogger?.error("agent", "Prepare resend blocked: root is not last user", {
						agentId,
						messageId,
						rootEntryId: rootEntryId.slice(0, 12),
						lastUserEntryId: lastUserEntryId.slice(0, 12),
						rootLine: lineIndex,
						lastUserLine: lastUserLineIndex,
					});
					throw new Error(
						"Resend root is not the last user message; refusing to truncate earlier history",
					);
				}

				// 只 tombstone「该 user + 其后代」；root 之前的历史一律保留。
				// 不用 re-parent：重发语义是丢掉本轮失败回复再重跑，而不是把失败分支挂回父节点。
				const removeIds = collectDescendantEntryIds(lines, rootEntryId);

				let removed = 0;
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i]?.trim();
					if (!line) continue;
					try {
						const parsed = JSON.parse(line) as { id?: string; type?: string };
						if (!parsed?.id || parsed.type === "deleted") continue;
						if (!removeIds.has(parsed.id)) continue;
						lines[i] = JSON.stringify({
							type: "deleted",
							originalEntryId: parsed.id,
							ts: Date.now(),
							reason: "resend-truncate",
						});
						removed += 1;
					} catch {
						/* 跳过无法解析的行 */
					}
				}

				// 兜底：定位行本身若因 id 异常未进集合，至少 tombstone 该行。
				if (lineIndex >= 0 && lineIndex < lines.length) {
					const current = lines[lineIndex]?.trim();
					if (current && !current.includes('"type":"deleted"')) {
						lines[lineIndex] = JSON.stringify({
							type: "deleted",
							originalEntryId: rootEntryId,
							ts: Date.now(),
							reason: "resend-truncate",
						});
						removed += 1;
					}
				}
				return removed;
			});

			try {
				await this.reloadSession(agentId);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				void this.appLogger?.error("agent", "Prepare resend: reload failed, restoring backup", {
					agentId,
					messageId,
					error: errMsg,
					elapsedMs: Date.now() - startTime,
				});
				try {
					const restored = await this.sessionJsonl.restoreFromBackup(sessionPath);
					if (restored) {
						await this.loadMessages(agentId).catch(() => {});
					}
				} catch (restoreError) {
					void this.appLogger?.error("agent", "Prepare resend: failed to restore backup", {
						agentId,
						error: restoreError instanceof Error ? restoreError.message : String(restoreError),
					});
				}
				throw error;
			}

			void this.appLogger?.info("agent", "Prepare resend completed", {
				agentId,
				messageId,
				removed,
				elapsedMs: Date.now() - startTime,
			});

			return {
				text: msg.text,
				...(msg.images?.length ? { images: msg.images } : {}),
			};
		});
	}

	/**
	 * 轻量重载：使用 switch_session RPC 重载会话上下文，无需重启进程。
	 * 编辑/删除消息后自动调用；IPC channels:agents:reload 也走此路径。
	 */
	async reload(agentId: string) {
		await this.reloadSession(agentId);
	}

	/**
	 * 重启 agent 进程：停止当前 pi RPC 子进程，用同一个 session 重新启动。
	 * 适用场景：修改了 provider 配置、切换了 API key、更新了 pi 版本后，
	 * /reload 只重载 extension，不会重新读取配置文件，restart 才能生效。
	 */
	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.requireRuntime(agentId);
		const { projectId, title } = runtime.tab;

		// 优先从 pi 获取最新 sessionFile，兜底用 tab 上缓存的值；
		// 避免首次创建时未指定 session 路径、restart 后丢失历史的情况。
		let sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) {
			try {
				const state = await runtime.process.client.request({
					type: "get_state",
				});
				sessionPath =
					(state.data as { sessionFile?: string } | undefined)?.sessionFile ??
					undefined;
			} catch {
				// 获取失败时继续用 undefined，create 会启动新 session
			}
		}

		// 停止旧进程并清理状态
		runtime.process.stop();
		this.agents.delete(agentId);
		this.lastEmittedTabStatus.delete(agentId);
		this.clearStreamGate(runtime);
		this.emitState();

		// 用相同的 session 重新创建 agent，新进程会重新加载所有配置
		return this.create({ projectId, sessionPath, title });
	}

	async exportHtml(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "export_html" },
			120_000,
		);
		return response.data;
	}

	/**
	 * 对未打开的历史会话执行官方 RPC 导出。
	 * 使用临时 pi 进程可以复用官方 export_html 样式，同时不切换当前桌面 Agent。
	 */
	async exportSessionHtml(projectId: string, sessionPath: string) {
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request(
				{ type: "export_html" },
				120_000,
			);
			return response.data;
		});
	}

	/**
	 * 对未打开的历史会话执行官方 clone。
	 * clone 会复制 active branch 到新 session；随后读取 get_state 拿到新 sessionFile 供历史列表刷新。
	 */
	async cloneSessionFile(projectId: string, sessionPath: string) {
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request({ type: "clone" }, 120_000);
			const state = await process.client.request({ type: "get_state" }, this.settingsStore.get().rpcTimeout);
			return {
				...((response.data as object | undefined) ?? {}),
				sessionPath: (state.data as { sessionFile?: string } | undefined)?.sessionFile,
			};
		});
	}

	private async withTemporarySession<T>(
		projectId: string,
		sessionPath: string,
		run: (process: PiProcess) => Promise<T>,
	): Promise<T> {
		const project = this.getProject(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const process = new PiProcess(project.path, this.settingsStore.get(), undefined, {
			agentHomeDir: this.wslEnvironment?.windowsHome,
		});
		// 临时会话同样可能触发 spawn error；先挂 sink 再 start，避免未捕获 error 拖垮主进程。
		process.on("error", (error) => {
			void this.appLogger?.error("agent", "Temporary session pi process error", {
				projectId,
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		await process.start(sessionPath);
		try {
			return await run(process);
		} finally {
			process.stop();
		}
	}

	async getForkMessages(agentId: string): Promise<ForkMessage[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_fork_messages",
		});
		return (
			(response.data as { messages?: ForkMessage[] } | undefined)?.messages ?? []
		);
	}

	async forkSession(agentId: string, entryId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "fork", entryId },
			120_000,
		);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	async cloneSession(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({ type: "clone" }, 120_000);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	async switchSession(agentId: string, sessionPath: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "switch_session", sessionPath: this.toSessionProtocolPath(sessionPath) },
			120_000,
		);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	private async refreshRuntimeAfterSessionReplacement(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const stateResponse = await runtime.process.client
			.request({ type: "get_state" }, this.settingsStore.get().rpcTimeout)
			.catch(() => ({ data: undefined }));
		const state = stateResponse.data as { sessionFile?: string; sessionName?: string } | undefined;
		if (state?.sessionFile) runtime.tab.sessionPath = state.sessionFile;
		if (state?.sessionName) runtime.tab.title = state.sessionName;
		await this.loadMessages(agentId).catch(() => undefined);
		this.emitState();
	}

	async getCommands(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_commands",
		});
		return (
			(response.data as { commands?: unknown[] } | undefined)?.commands ?? []
		);
	}

	private async promptMatchesRegisteredExtensionCommand(runtime: AgentRuntime, message: string): Promise<boolean> {
		const trimmed = message.trim();
		if (!trimmed.startsWith("/")) return false;

		const commandName = trimmed.slice(1).split(/\s+/, 1)[0];
		if (!commandName) return false;

		const response = await runtime.process.client
			.request({ type: "get_commands" }, 10_000)
			.catch(() => undefined);
		const commands = (response?.data as { commands?: unknown[] } | undefined)?.commands ?? [];
		return commands.some((command) => {
			if (!command || typeof command !== "object") return false;
			const typed = command as { name?: unknown; source?: unknown };
			return typed.name === commandName && typed.source === "extension";
		});
	}

	/** 设置某 agent 的 RPC 日志记录开关 */
	setRpcLogging(agentId: string, enabled: boolean) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		runtime.rpcLogging = enabled;
	}

	/** 查询某 agent 是否开启了 RPC 日志记录 */
	isRpcLogging(agentId: string): boolean {
		return this.agents.get(agentId)?.rpcLogging ?? false;
	}

	async stop(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		// 标记用户主动停止，退出处理器将跳过自动重连
		runtime.userInitiatedStop = true;
		const process = runtime.process;
		this.agents.delete(agentId);
		this.lastEmittedTabStatus.delete(agentId);
		this.clearStreamGate(runtime);
		process.stop();
		this.emitState();
	}

	/** 注册本地事件监听器（供 FeishuBridge 等主进程内部模块使用） */
	addLocalEventListener(listener: (agentId: string, event: unknown) => void): () => void {
		this.localEventListeners.add(listener);
		return () => { this.localEventListeners.delete(listener); };
	}

	/** 注册状态变更监听器（供 PetStateBridge 等主进程内部模块使用）；每次 emitState 后同步回调最新 AgentTab[] */
	addStateListener(listener: (tabs: AgentTab[]) => void): () => void {
		this.stateListeners.add(listener);
		return () => { this.stateListeners.delete(listener); };
	}

	/**
	 * 注册语义事件监听器（AFK 编排器/后续 renderer 语义订阅用）。
	 * 提供的是增量语义事件而非整表快照；事件在汇聚点同步回调。
	 * 返回的退订函数可安全重复调用。
	 */
	onAgentEvent(listener: AgentManagerEventListener): () => void {
		this.eventListeners.add(listener);
		return () => { this.eventListeners.delete(listener); };
	}

	private notifyStateListeners(tabs: AgentTab[]) {
		for (const listener of this.stateListeners) {
			try { listener(tabs); } catch {}
		}
	}

	private notifyEventListeners(event: AgentManagerEvent) {
		for (const listener of this.eventListeners) {
			try { listener(event); } catch {}
		}
	}

	stopAll() {
		// 应用退出时统一清理所有 pi 子进程，避免后台 agent 残留占用模型或文件句柄。
		for (const runtime of this.agents.values()) {
			runtime.userInitiatedStop = true;
			runtime.process.stop();
		}
		this.agents.clear();
		this.lastEmittedTabStatus.clear();
		this.emitState();
	}

	/**
	 * 统一挂接 PiProcess 生命周期监听。
	 * 必须在 start() 之前调用，避免 spawn error 在无 listener 窗口升级成未捕获异常。
	 */
	private attachPiProcessLifecycle(
		agentId: string,
		piProcess: PiProcess,
		options: {
			projectPath?: string;
			onExit: (payload: { code: number | null; signal: string | null }) => void;
		},
	) {
		piProcess.on("event", (event) => {
			try {
				this.handlePiEvent(agentId, event);
			} catch (error) {
				// 单条 pi 事件处理失败不能拖垮主进程；记录后继续接收后续事件。
				void this.appLogger?.error("agent", "handlePiEvent failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					eventType:
						event && typeof event === "object"
							? String((event as { type?: unknown }).type ?? "unknown")
							: typeof event,
				});
			}
		});
		piProcess.on("stderr", (text) =>
			this.emit(ipcChannels.agentsLog, { agentId, text }),
		);
		piProcess.on("protocol-error", (line) => {
			this.emit(ipcChannels.agentsLog, {
				agentId,
				text: `Protocol error: ${line}`,
			});
			void this.appLogger?.error(
				"agent",
				`Protocol error: ${(line as string)?.slice(0, 200)}`,
				{
					agentId,
					project: options.projectPath,
				},
			);
		});
		piProcess.on("rpc-log", (entry: { direction: string; data: unknown }) => {
			// 渲染层的实时 RPC 控制台与文件日志共用同一个 per-agent 开关
			//（renderer 的 onRpcLog 处理器在开关关闭时直接丢弃，见 App.tsx）。
			// 开关关闭时主进程不再构造 logEntry 也不发 IPC：每条进出 RPC 消息
			// 都省去 randomUUID + 对象构造 + 结构化克隆序列化（流式期每 token 一次）。
			const rt = this.agents.get(agentId);
			if (!rt?.rpcLogging) return;
			try {
				const data = entry.data as Record<string, any>;
				let summary: string;
				if (entry.direction === "send") {
					const type = data.type ?? "?";
					if (type === "prompt")
						summary = `→ prompt: ${(data.message ?? "").slice(0, 60)}`;
					else if (type === "set_model")
						summary = `→ set_model: ${data.provider}/${data.modelId}`;
					else if (type === "set_thinking_level")
						summary = `→ set_thinking: ${data.level}`;
					else if (type === "bash")
						summary = `→ bash: ${(data.command ?? "").slice(0, 60)}`;
					else summary = `→ ${type}`;
				} else {
					const type = data.type ?? "?";
					if (type === "response")
						summary = `← ${data.command ?? "?"} ${data.success ? "✓" : "✗"}${data.error ? ` ${data.error}` : ""}`;
					else if (type === "message_update") {
						const evt = data.assistantMessageEvent?.type ?? "?";
						summary = `← message_update.${evt}`;
					} else summary = `← ${type}`;
				}
				const logEntry = {
					id: randomUUID(),
					agentId,
					direction: entry.direction,
					summary,
					data,
					time: Date.now(),
				};
				this.emit(ipcChannels.agentsRpcLog, logEntry);
				this.rpcLogger?.push(logEntry);
			} catch (error) {
				void this.appLogger?.warn("agent", "rpc-log handler failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		piProcess.on("exit", (payload: { code: number | null; signal: string | null }) => {
			try {
				void this.appLogger?.info("agent", "Pi process exit", {
					agentId,
					code: payload.code,
					signal: payload.signal,
					diagnostics: piProcess.getDiagnostics(),
				});
				options.onExit(payload);
			} catch (error) {
				void this.appLogger?.error("agent", "Pi process exit handler failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		piProcess.on("error", (error: Error) => {
			const runtime = this.agents.get(agentId);
			if (runtime) runtime.tab.status = "error";
			const message = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Pi process error", {
				agentId,
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
				diagnostics: piProcess.getDiagnostics(),
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			if (runtime) {
				this.addMessage(
					runtime,
					"error",
					this.buildStartupFailureMessage(message, piProcess.getDiagnostics()),
				);
			}
			this.emitState();
		});
	}

	/** createUnlocked 路径的进程 exit：支持压缩后自动重连，其余标 closed。 */
	private handleCreateProcessExit(
		agentId: string,
		runtime: AgentRuntime,
		payload: { code: number | null; signal: string | null },
	) {
		const tab = runtime.tab;
		if (runtime.modelRefreshing) return;
		if (runtime.userInitiatedStop) {
			runtime.userInitiatedStop = false;
			tab.status = "closed";
			this.emitState();
			return;
		}
		if (runtime.compacting) {
			tab.status = "closed";
			this.emitState();
			return;
		}
		if (!runtime.autoRestartAttempted && tab.sessionPath && payload.code === 0) {
			runtime.autoRestartAttempted = true;
			tab.status = "starting";
			this.emitState();
			this.reattachProcess(agentId, tab.sessionPath)
				.then(() => {
					tab.status = "idle";
					this.addMessage(runtime, "system", "会话压缩完成，Agent 已自动重连");
					this.emitState();
				})
				.catch((error) => {
					tab.status = "closed";
					void this.appLogger?.error("agent", "Auto reattach after clean exit failed", {
						agentId,
						error: error instanceof Error ? error.message : String(error),
					});
					this.addMessage(runtime, "error", "Agent 进程意外退出，自动重连失败");
					this.emitState();
				});
			return;
		}
		tab.status = "closed";
		// 非 0 退出且还没写过错误卡时，补一条可排查信息（避免用户只看到 closed）。
		if (payload.code !== 0 && payload.code !== null) {
			const diag = runtime.process.getDiagnostics();
			this.addMessage(
				runtime,
				"error",
				this.buildStartupFailureMessage(
					`omp 进程退出 code=${payload.code}${payload.signal ? ` signal=${payload.signal}` : ""}`,
					diag,
				),
			);
		}
		this.emitState();
	}

	/** reattach 路径的进程 exit：同样做单次自动重连保护。 */
	private handleReattachProcessExit(
		agentId: string,
		runtime: AgentRuntime,
		payload: { code: number | null; signal: string | null },
	) {
		if (runtime.modelRefreshing) return;
		if (runtime.userInitiatedStop) {
			runtime.userInitiatedStop = false;
			runtime.tab.status = "closed";
			this.emitState();
			return;
		}
		if (!runtime.autoRestartAttempted && runtime.tab.sessionPath && payload.code === 0) {
			runtime.autoRestartAttempted = true;
			runtime.tab.status = "starting";
			this.emitState();
			this.reattachProcess(agentId, runtime.tab.sessionPath)
				.then(() => {
					runtime.tab.status = "idle";
					this.addMessage(runtime, "system", "会话压缩完成，Agent 已自动重连");
					this.emitState();
				})
				.catch((error) => {
					runtime.tab.status = "closed";
					void this.appLogger?.error("agent", "Reattach auto-restart failed", {
						agentId,
						error: error instanceof Error ? error.message : String(error),
					});
					this.addMessage(runtime, "error", "Agent 进程意外退出，自动重连失败");
					this.emitState();
				});
			return;
		}
		runtime.tab.status = "closed";
		this.emitState();
	}

	/**
	 * 把 pi 启动/退出失败整理成可复制的诊断文案。
	 * 目标：用户不至于只看到闪退或空白，Issue 也能直接贴日志。
	 */
	private buildStartupFailureMessage(
		rawMessage: string,
		diag: ReturnType<PiProcess["getDiagnostics"]>,
	): string {
		if (!diag) {
			return `⚠️ omp RPC 启动失败\n\n${rawMessage}\n\nplatform=${globalThis.process.platform} arch=${globalThis.process.arch}`;
		}
		const lines: string[] = [];
		if (diag.exitCode !== null) {
			lines.push(`退出码: ${diag.exitCode}${diag.exitSignal ? ` (signal: ${diag.exitSignal})` : ""}`);
		}
		const stderrText = diag.stderr.join("").trim();
		if (stderrText) {
			const snippet = stderrText.length > 600 ? "…" + stderrText.slice(-600) : stderrText;
			lines.push(`进程错误输出:\n${snippet}`);
		}
		lines.push(`omp 路径: ${diag.command}`);
		if (diag.customPiPath) lines.push(`自定义路径: ${diag.customPiPath}`);
		lines.push(`工作目录: ${diag.cwd}`);
		lines.push(`版本检测: ${diag.versionCheck ? "✓ 通过" : "✗ 失败"}`);
		lines.push(`运行环境: ${globalThis.process.platform}/${globalThis.process.arch}`);
		if (diag.blockedExtensions && diag.blockedExtensions.length > 0) {
			// 桌面端已自动隔离的扩展（如 codeisland），方便用户对照「为何 RPC 没加载该扩展」。
			lines.push(`已自动隔离扩展: ${diag.blockedExtensions.join(", ")}`);
		}
		lines.push("");
		lines.push("━━━ 排查步骤 ━━━");
		if (!diag.versionCheck) {
			lines.push("1. 在终端执行 omp --version，确认 omp 是否已安装且路径正确");
			lines.push("2. 如未安装，执行 npm install -g @earendil-works/pi-coding-agent");
			lines.push("3. macOS 若从 Dock 启动，可在设置中填写完整 omp 路径（Homebrew 常见 /opt/homebrew/bin/omp）");
		} else if (diag.exitCode !== 0 && diag.exitCode !== null) {
			lines.push("1. 在终端执行 omp --mode rpc 看是否能正常启动");
			lines.push("2. 注意终端中的错误信息（架构不匹配/权限/扩展崩溃都会体现在这里）");
		} else if (!stderrText && diag.exitCode === null) {
			lines.push("1. 桌面端已自动重试 get_state，但 omp 仍未响应。");
			lines.push("2. 在终端执行 omp --mode rpc 看是否能正常启动，注意终端中的错误信息");
		} else {
			lines.push("1. 在终端执行 omp --mode rpc 确认 omp 能否正常启动");
			lines.push("2. 检查设置中的 omp 路径是否正确");
		}
		const startFlags = this.settingsStore.get();
		const noExt = Boolean(startFlags.piRpcNoExtensions);
		const noSkills = Boolean(startFlags.piRpcNoSkills);
		lines.push("");
		lines.push("━━━ 扩展 / 技能排查 ━━━");
		if (noExt || noSkills) {
			lines.push(
				`当前启动已禁用：${[
					noExt ? "扩展 (--no-extensions)" : null,
					noSkills ? "技能 (--no-skills)" : null,
				]
					.filter(Boolean)
					.join("、")}`,
			);
			lines.push("若仍失败，更可能是 omp 本体/路径/会话文件问题，而不是扩展加载。");
		} else {
			lines.push("若怀疑某个扩展或技能导致启动失败：");
			lines.push("1. 打开 设置 → 开发设置");
			lines.push("2. 临时开启「禁用扩展启动」和/或「禁用技能启动」");
			lines.push("3. 保存后重新启动 Agent 验证");
			lines.push("若禁用后能启动，再逐个排查 ~/.omp/agent/extensions 与 skills。");
		}
		lines.push("");
		lines.push("如问题持续，可在 GitHub 提交 Issue 并附上以上信息与应用日志。");
		return `⚠️ omp RPC 启动失败\n\n${rawMessage}\n\n${lines.join("\n")}`;
	}

	private handlePiEvent(agentId: string, event: unknown) {
		// 通知本地监听器（FeishuBridge 等主进程内部订阅）
		for (const listener of this.localEventListeners) {
			try { listener(agentId, event); } catch {}
		}
		// 不向渲染进程广播原始事件：agents:event 通道无任何订阅者（preload 未暴露），
		// 每条 text_delta 都携带全量 partialMessage，跨进程结构化克隆纯属浪费；
		// 渲染层所需信息已由 agents:message / agents:thinking / agents:runtime-state 覆盖。

		if (!event || typeof event !== "object") return;
		const typed = event as Record<string, any>;
		const runtime = this.agents.get(agentId);
		// agent 已被 stop/restart 删除时，除顶部监听器广播外的事件一律忽略：
		// 对一个已不存在的 runtime 改状态只会造成内存泄漏与 UI 串台。
		if (!runtime) return;

		// 扩展/RPC 调用 setSessionName 后 Pi 发 session_info_changed（旧 pi）/ session_info_update（omp）事件；
		// 同步到 tab.title，使侧边栏与手动 rename 路径看到同一标题。
		// 忽略空 name，避免把已有标题抹掉。
		if (typed.type === "session_info_changed" || typed.type === "session_info_update") {
			const name =
				typeof typed.name === "string"
					? typed.name.replace(/\s+/g, " ").trim()
					: "";
			if (name && name !== runtime.tab.title) {
				runtime.tab.title = name;
				this.emitState();
			}
		}

		if (typed.type === "agent_start") {
			// agent_start 表示一轮新的 agent run 开始：
			// 1) 清理 recentlyAborted，允许状态机恢复 running
			// 2) 推进 stream generation，解封流式闸门（唯一合法解封点）
			runtime.recentlyAborted = false;
			this.openAgentStream(runtime);
			if (runtime.settleCheckTimer) {
				clearTimeout(runtime.settleCheckTimer);
				runtime.settleCheckTimer = undefined;
			}
			runtime.tab.status = "running";
			runtime.activeAssistantMessageId = undefined;
			runtime.toolMessageIds.clear();
			runtime.activeToolCalls.clear();
			runtime.toolExecuting = null;
			this.emitState();
			// 一轮新回答开始：立即推送完整运行态，模型信息条及时显示 omp 实际选用的模型
			//（可能因路由/回退与上次不同），而不是等 get_state 轮询或工具边沿。
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "message_start" && typed.message?.role === "assistant") {
			// abort 封印后的残留 assistant 事件应丢弃，防止误重新激活流式状态。
			if (this.isAgentStreamSealed(runtime)) {
				return;
			}
			this.beginAssistantMessage(runtime);
			this.upsertAssistantMessage(runtime, typed.message);
			// 首条 assistant 消息到达时再补发一次运行态：覆盖 agent_start 与 get_state 之间的空窗
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "auto_retry_start") {
			this.upsertRetryStatusMessage(runtime, typed, "running");
			// 用户已主动中止时不重新激活 running 状态，避免 abort 后 auto-retry 事件误覆盖 state
			if (!runtime.recentlyAborted) {
				// pi 在等待指数退避期间可能短暂结束一轮 agent run；桌面端保持 running，
				// 让用户明确知道当前不是最终失败，而是在等待下一次自动重试。
				runtime.tab.status = "running";
				this.emitState();
			}
		}

		if (typed.type === "auto_retry_end") {
			this.upsertRetryStatusMessage(
				runtime,
				typed,
				typed.success ? "success" : "error",
			);
			// 自动重试最终失败：如果用户没有主动中止，则保持 agent 的 error 状态
			// 不被后续 agent_settled 覆盖，确保侧边栏状态显示失败标记。
			if (!typed.success && !runtime.recentlyAborted) {
				runtime.tab.status = "error";
				const reason = typed.finalError ?? typed.errorMessage ?? "API 请求失败";
				this.addMessage(runtime, "error", `请求失败：${String(reason)}`);
				this.emitState();
			}
		}

		// 自动/手动压缩事件（pi 发 compaction_start/end，omp 发 auto_compaction_start/end），
		// 用于记录压缩耗时和结果，便于排查压缩性能问题。
		if (typed.type === "compaction_start" || typed.type === "auto_compaction_start") {
			runtime.rpcCompacting = true;
			// 用户已主动中止或出错时不重新激活 running 状态
			if (!runtime.recentlyAborted && runtime.tab.status !== "error") {
				// 自动压缩在 agent_end 之后触发：Pi 仍在改写上下文，但不会再发 agent_start。
				// 因此桌面端必须主动保持 running，阻止用户误以为空闲并继续发送消息。
				runtime.tab.status = "running";
				this.emitState();
				void this.emitRuntimeState(agentId);
			}
			void this.appLogger?.info("agent", "Compaction started", {
				agentId,
				reason: typed.reason,
			});
		}
		if (typed.type === "compaction_end" || typed.type === "auto_compaction_end") {
			runtime.rpcCompacting = false;
			// compaction 会向 session JSONL 写入新的边界记录；立即重载消息，
			// 避免前端仍展示压缩前分支，下一轮继续对话时看起来像“断在旧会话”。
			void this.loadMessages(agentId).catch(() => undefined);
			// 用户已主动中止或出错时不重新激活 running 状态
			if (!runtime.recentlyAborted && runtime.tab.status !== "error") {
				// compaction_end 之后 Pi 仍可能因 overflow retry 或 queued follow-up 自动继续。
				// omp 没有 agent_settled 事件，压缩完成后再调度一次最终空闲检查（get_state 校验）。
				runtime.tab.status = "running";
			}
			// omp 的压缩完成后不再有 settled 事件：重新调度空闲检查，避免 UI 停在 running
			this.scheduleSettleCheck(runtime, agentId);
			this.emitState();
			void this.emitRuntimeState(agentId);
			void this.appLogger?.info("agent", "Compaction ended", {
				agentId,
				reason: typed.reason,
				result: typed.result ? "success" : "failed",
				aborted: typed.aborted,
				willRetry: typed.willRetry,
				errorMessage: typed.errorMessage,
			});
		}

		if (typed.type === "agent_end") {
			// agent_end 只表示一次底层 run 结束；Pi 之后仍可能执行自动重试、自动压缩，
			// 或压缩后继续 queued follow-up。最终空闲必须等 agent_settled，避免中途误判 idle。
			runtime.activeAssistantMessageId = undefined;
			runtime.toolMessageIds.clear();
			// run 结束意味着本轮工具必然已结束。长任务中最后一个工具的 end 事件可能
			// 丢失（并行工具批次、错误/中断路径），残留 toolExecuting 会让空闲检查
			// （markIdleIfPiReportsNoWork）永远判 busy，UI 卡在 running、三点指示器
			// 无法消失。这里统一清残留；若 omp 实际还有排队工作，空闲检查的
			// get_state（queuedMessageCount）会正确判定并继续保持 running。
			runtime.activeToolCalls.clear();
			runtime.toolExecuting = null;
			// agent 异常结束时（如 API 返回 400、模型报错等），将错误提示写入会话，避免用户看到空白。
			// 错误信息的存放位置因 pi 版本和错误类型不同而有多种可能：
			//   1. agent_end 顶层 errorMessage
			//   2. messages 数组中 stopReason=error 的消息的 errorMessage
			//   3. messages 数组中 assistant 消息的 content 里包含 error 片段
			//   4. agent_end 顶层 stopReason=error 但无 messages
			const agentMessages = Array.isArray(typed.messages) ? typed.messages : [];
			const errorMessages = agentMessages.filter(
				(m: any) => m.stopReason === "error",
			);
			// 逐级查找错误文本：顶层 → 错误消息列表 → 仅检查最后一轮对话中 type=error 的 content 块
			const topMsg = errorMessages[errorMessages.length - 1];
			// 只从最后一条 assistant 消息中查找显式 type=error 的 content 块，
			// 避免扫描全部历史消息导致工具成功输出被误判为错误。
			const lastAssistant = agentMessages
				.filter((m: any) => m.role === "assistant")
				.pop();
			const contentError = Array.isArray(lastAssistant?.content)
				? lastAssistant.content.find((c: any) => c?.type === "error")
				: undefined;
			const errorMsg =
				(typed.errorMessage as string | undefined) ??
				topMsg?.errorMessage ??
				(typed.error as string | undefined) ??
				(typeof contentError?.text === "string" ? contentError.text : undefined) ??
				(typeof contentError?.message === "string"
					? contentError.message
					: undefined);
			if (typed.willRetry === true) {
				// agent_end.willRetry 表示 pi 已判定本次错误会进入自动重试；
				// 此时不写入最终错误，避免用户误以为会话已经失败。
				if (errorMsg && runtime.retryStatusMessageId === undefined) {
					this.upsertRetryStatusMessage(
						runtime,
						{
							attempt: 0,
							maxAttempts: 0,
							delayMs: 0,
							errorMessage: String(errorMsg),
						},
						"running",
					);
				}
				// 重试中保持 running，不能误置为 idle/error，否则宠物聚合状态会提前转 done/failed
				// 用户已主动中止时不覆盖 state，避免 abort 后收到此事件又重新激活 running
				if (!runtime.recentlyAborted) runtime.tab.status = "running";
			} else if (errorMsg) {
				this.addDetailedErrorMessage(runtime, String(errorMsg));
				// 有错误且不会重试 → Agent 进入 error 态，宠物聚合为 failed（行5），
				// 否则会被误置为 idle 触发"所有任务完成"通知
				runtime.tab.status = "error";
			} else if (
				typed.stopReason === "error" ||
				errorMessages.length > 0
			) {
				this.addDetailedErrorMessage(runtime, "Agent 返回未知错误，请重试");
				runtime.tab.status = "error";
			}
			this.emitState();
			// agent_end 后 runtimeState 可能暂时仍显示后续 compaction/retry；立即同步一次，
			// 但不要把它当作最终空闲信号，最终状态由 agent_settled 处理。
			void this.emitRuntimeState(agentId);

			// 兜底：omp 没有 agent_settled 事件（旧 pi 才有），
			// 定时查询 get_state 确认是否已无工作可做，避免 UI 动画永久卡住。
			// 压缩完成后会重新调度；agent_settled 正常触发时 markIdleIfPiReportsNoWork 会因 status!=="running" 提前返回。
			this.scheduleSettleCheck(runtime, agentId);
		}

		if (typed.type === "agent_settled") {
			// agent_settled 是旧 pi 的最终稳定点（omp 无此事件，走 scheduleSettleCheck 兜底）。
			// 通知 stream gate：abort 对应的 settled 已到。
			// 若 settled 前已有 agent_start（用户立刻重发），此处才真正解封；
			// 若还没有新 start，则保持封印，防止 settled 后残留 delta 复活旧气泡。
			// 先捕获「该 settled 是否由 abort 触发」再清标记：abortAgent 在发送 abort RPC 前
			// 置 recentlyAborted=true，此处若为 true 说明是用户手动停止后的收尾，
			// 不再发「已完成」系统通知（用户主动中止，无需提醒）。
			const settledAfterAbort = runtime.recentlyAborted;
			this.noteAgentAbortSettled(runtime);
			runtime.recentlyAborted = false;
			if (runtime.settleCheckTimer) {
				clearTimeout(runtime.settleCheckTimer);
				runtime.settleCheckTimer = undefined;
			}
			if (runtime.tab.status !== "error" && runtime.tab.status !== "closed") {
				// agent_settled 是 Pi 的最终稳定点：没有自动重试、自动压缩、压缩 retry
				// 或 queued follow-up 会继续执行，此时才允许恢复 idle 并通知用户完成。
				// 语义事件：仅当本次把 busy 状态收口为 idle 时发 settled——若 omp 兜底
				// （markIdleIfPiReportsNoWork）已先置 idle，此处幂等跳过，避免重复通知。
				const settledFromBusy =
					runtime.tab.status === "running" || runtime.tab.status === "starting";
				runtime.tab.status = "idle";
				runtime.streamingThinking = "";
				runtime.thinkingStartedAt = undefined;
				runtime.thinkingEndedAt = undefined;
				runtime.activeAssistantMessageId = undefined;
				runtime.toolMessageIds.clear();
				runtime.activeToolCalls.clear();
				runtime.toolExecuting = null;
				runtime.rpcCompacting = false;
				this.thinkingEmitter.cancel(agentId);
				this.emitThinking(agentId, "");
				this.emitState();
				void this.emitRuntimeState(agentId);
				if (settledFromBusy) {
					this.notifyEventListeners({ type: "settled", agentId });
				}

				const messages = runtime.messages;
				const lastMessage = messages[messages.length - 1];
				if (lastMessage?.role === "assistant" && !settledAfterAbort) {
					this.notifySessionEnd(runtime.tab.title);
				}
			}
		}

		if (
			typed.type === "message_update" &&
			typed.assistantMessageEvent
		) {
			// abort 封印后的延迟 text/thinking delta 一律丢弃，避免重建气泡或串台。
			if (this.isAgentStreamSealed(runtime)) {
				return;
			}
			this.handleAssistantMessageEvent(runtime, typed);
		}

		if (
			typed.type === "message_end" &&
			typed.message?.role === "assistant"
		) {
			if (this.isAgentStreamSealed(runtime)) {
				return;
			}
			if (runtime.activeAssistantMessageId !== undefined) {
				this.upsertAssistantMessage(runtime, typed.message);
				runtime.activeAssistantMessageId = undefined;
				// message_end 是本轮回答的最终状态，立即 flush 确保完整消息及时可见
				this.flushMessageEmit(runtime);
			}
		}

		if (typed.type === "tool_execution_start") {
			// abort 封印后的延迟工具事件应丢弃，避免重新激活流式状态。
			if (this.isAgentStreamSealed(runtime)) {
				return;
			}
			this.upsertToolMessage(runtime, typed, "running");
			// 并行工具会先连续发多个 start；按 toolCallId 追踪，只有最后一个 end 才能表示工具阶段完成。
			const toolName = typed.toolName ?? "tool";
			const toolCallId = String(typed.toolCallId ?? `${toolName}-${Date.now()}`);
			const toolState = updateActiveToolCalls(
				runtime.activeToolCalls,
				{ type: "start", toolCallId, toolName },
			);
			this.applyActiveToolCallState(runtime, toolState);
			// 工具调用开始时确保 agent 状态为 running
			runtime.tab.status = "running";
			this.emitState();
			// 完整 runtime 信息异步补发；工具边沿已经同步推送，不依赖此请求的完成顺序。
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "tool_execution_end") {
			// abort 封印后的延迟工具事件应丢弃。
			if (this.isAgentStreamSealed(runtime)) {
				return;
			}
			this.upsertToolMessage(
				runtime,
				typed,
				typed.isError ? "error" : "done",
			);
			// 工具执行结束是终态，立即 flush 把最终结果推给渲染进程，避免节流窗口内用户看不到完成状态。
			this.flushMessageEmit(runtime);
			// 清除本次 toolCall；并行批次仅在最后一个工具结束时发布 false，
			// 否则 steer 会在其他工具仍运行时过早进入 pi 队列。
			const toolState = updateActiveToolCalls(runtime.activeToolCalls, {
				type: "end",
				toolCallId: String(typed.toolCallId ?? ""),
			});
			this.applyActiveToolCallState(runtime, toolState);
			// 工具调用完成后保持 agent 状态为 running，等待后续的 agent_end 事件
			// 这样在工具完成到 agent 生成回复之间，thinking bubble 仍然会显示
			runtime.tab.status = "running";
			this.emitState();
			// 完整 runtime 信息异步补发；序号保证它不会倒灌旧工具状态。
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "tool_execution_update") {
			// abort 封印后的延迟工具事件应丢弃。
			if (this.isAgentStreamSealed(runtime)) {
				return;
			}
			this.upsertToolMessage(runtime, typed, "running");
		}

		if (typed.type === "extension_ui_request") {
			this.handleUIRequest(runtime, typed);
		}

		if (typed.type === "extension_error") {
			this.addMessage(
				runtime,
				"error",
				String(typed.error ?? "Extension error"),
			);
		}
	}

	/**
	 * 处理 pi 扩展发起的 UI 请求。
	 * 对话类请求写入消息流等待用户回答；fire-and-forget 请求只转发给渲染进程或忽略。
	 */
	private handleUIRequest(runtime: AgentRuntime, typed: Record<string, any>) {
		const agentId = runtime.tab.id;
		const method = String(typed.method ?? "");
		const requestId = String(typed.id ?? "");
		// pi RPC 协议将 setWidget / dialog 字段放在顶层，不嵌套 params
		if (method === "notify") {
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				message: String(typed.message ?? ""),
				notifyType: typed.notifyType,
			});
			return;
		}

		if (method === "set_editor_text") {
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				text: String(typed.text ?? ""),
			});
			return;
		}

		if (method === "setWidget") {
			// Plan Mode 等扩展会频繁刷新 widget；只走 IPC 状态，不落入会话消息，避免 JSONL 被进度噪声污染。
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				widgetKey: String(typed.widgetKey ?? requestId),
				widgetLines: Array.isArray(typed.widgetLines) ? typed.widgetLines : undefined,
				widgetPlacement: typed.widgetPlacement,
			});
			return;
		}
		// 其他非对话 UI 方法暂不占用桌面 UI 空间。
		if (["setStatus", "setTitle"].includes(method)) return;
		if (!["select", "confirm", "input", "editor"].includes(method)) return;

		// select 无选项时自动取消，不等用户响应
		if (method === "select" && (!Array.isArray(typed.options) || typed.options.length === 0)) {
			this.sendUIResponse(agentId, requestId, { cancelled: true });
			return;
		}

		// 批量 ask envelope：扩展把 questions JSON 塞进 input 的 title；
		// 桌面端识别后渲染 Tab 问卷，而不是把整段 JSON 当普通输入题。
		const rawTitle = String(typed.title ?? typed.question ?? "");
		const batchEnvelope = tryParseBatchAskEnvelope(rawTitle);
		const request = batchEnvelope
			? {
					agentId,
					requestId,
					method: "batch_ask" as const,
					title: `问卷（${batchEnvelope.questions.length} 题）`,
					batchQuestions: batchEnvelope.questions,
					batchReview: batchEnvelope.review === true,
			  }
			: {
					agentId,
					requestId,
					method,
					title: rawTitle,
					options: typed.options as string[] | undefined,
					placeholder: typed.placeholder as string | undefined,
					prefill: typed.prefill as string | undefined,
					allowOther: typed.allowOther === true,
			  };

		// 记录 pending UI 请求，用于 abort 时自动 cancel
		runtime.pendingUIRequests.set(requestId, { method, title: request.title });

		// 插入 system 消息作为卡片占位
		this.addMessage(runtime, "system", request.title, {
			type: "askQuestion",
			status: "pending",
			uiRequest: request,
		});

		// 通知渲染进程显示交互卡片
		this.emit(ipcChannels.agentsUiRequest, request);
		this.scheduleUIRequestTimeout(agentId, requestId, typed.timeout);
	}

	/**
	 * 发送 Extension UI 响应（extension_ui_response）到 pi 的 stdin。
	 * 同时更新对应卡片消息的状态。
	 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean | null; cancelled?: boolean; confirmed?: boolean }) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		// 写入 extension_ui_response 到 pi 的 stdin

		// 写入 extension_ui_response。
		// 注意：普通 select 取消应走 value:null（见 abort / 渲染层 respondCancel），
		// 不要对 select 误发 cancelled:true，否则 pi 返回 undefined，旧 ask 扩展会选第一项。
		const extPayload: Record<string, unknown> = {
			type: "extension_ui_response",
			id: requestId,
		};
		// value 允许显式 null（取消 select）；undefined 表示字段未提供则不写入。
		if ("value" in response) extPayload.value = response.value;
		// pi 的 ctx.ui.confirm() 检查 confirmed 字段
		if ("confirmed" in response) extPayload.confirmed = response.confirmed;
		if (response.cancelled) extPayload.cancelled = true;
		runtime.process.client.sendRaw(extPayload);

		// 清理 pending 记录
		const pending = runtime.pendingUIRequests;
		pending.delete(requestId);

		// 更新卡片消息状态为 answered 或 cancelled；cancelled 时从消息流移除，不留痕迹
		const messages = runtime.messages;
		if (response.cancelled) {
			// 取消交互：从消息流中移除对应的 askQuestion 卡片，不在时间线上留下痕迹
			const idx = messages.findIndex(
				(msg) =>
					msg.role === "system" &&
					msg.meta?.type === "askQuestion" &&
					(msg.meta as Record<string, unknown>).uiRequest &&
					((msg.meta as Record<string, unknown>).uiRequest as Record<string, unknown>).requestId === requestId,
			);
			if (idx !== -1) {
				messages.splice(idx, 1);
				this.markMessagesDirty(runtime, idx);
			}
		} else {
			for (const msg of messages) {
				if (
					msg.role === "system" &&
					msg.meta?.type === "askQuestion" &&
					(msg.meta as Record<string, unknown>).uiRequest &&
					((msg.meta as Record<string, unknown>).uiRequest as Record<string, unknown>).requestId === requestId
				) {
					(msg.meta as Record<string, string>).status = "answered";
					(msg.meta as Record<string, unknown>).response = response;
					this.markMessageDirty(runtime, msg);
					break;
				}
			}
		}
		this.scheduleMessageEmit(runtime, false);

		// 通知渲染进程 UI 请求已完成
		this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true, ...response });
	}

	/**
	 * pi 信任机制只对“含项目级 pi 资源”的项目触发，且 RPC 模式下 pi 的 project_trust 事件
	 * hasUI 恒为 false、ctx.ui.select 不接 RPC UI 协议，无法弹窗。
	 * 因此 pi-desktop 在启动 pi 进程前自行完成信任确认：干净项目自动信任并写入 trust.json；
	 * 含 .omp/.agents 资源且未记录的项目弹窗让用户决策。
	 */
	private static readonly TRUST_REQUIRING_RESOURCE_FILES = [
		"settings.json",
		"extensions",
		"skills",
		"prompts",
		"themes",
		"SYSTEM.md",
		"APPEND_SYSTEM.md",
	] as const;

	/**
	 * 复刻 pi 的 hasTrustRequiringProjectResources：检查项目目录或其父目录是否存在
	 * 需要信任才能加载的资源（.omp 下的配置/扩展/skills 等，或项目级 .agents/skills）。
	 * 用户全局 ~/.agents/skills 视为可信，不触发信任确认。
	 */
	private hasTrustRequiringResources(hostCwd: string): boolean {
		const configDir = join(hostCwd, ".omp");
		if (
			AgentManager.TRUST_REQUIRING_RESOURCE_FILES.some((file) => existsSync(join(configDir, file)))
		) {
			return true;
		}
		const userAgentsSkillsDir = join(
			this.wslEnvironment?.windowsHome ?? homedir(),
			".agents",
			"skills",
		);
		let currentDir = hostCwd;
		while (true) {
			const agentsSkillsDir = join(currentDir, ".agents", "skills");
			if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
				return true;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) return false;
			currentDir = parentDir;
		}
	}

	/**
	 * 启动 pi 前完成项目信任确认。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任，后续不再重复检查。
	 * - 含信任资源的项目：已信任则放行；已显式拒绝则抛错；未记录则弹窗等待用户决策。
	 */
	/**
	 * 启动 pi 前完成项目信任确认，返回需传给 pi 的信任覆盖指令。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任。
	 * - 已信任：放行，pi 查 trustStore 即可。
	 * - 未记录或曾记 false：弹窗让用户选择。不持久化 false，保证下次仍可重新选择。
	 *   - trust-remember：写 true，pi 信任加载资源。
	 *   - trust-session：用 --approve 本次覆盖，不落盘。
	 *   - deny：用 --no-approve 本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
	 */
	private async ensureProjectTrust(project: Project): Promise<"approve" | "no-approve" | undefined> {
		const cwd = this.wslEnvironment
			? toWslLinuxPath(project.path, this.wslEnvironment)
			: project.path;
		const hostCwd = this.wslEnvironment
			? toWindowsHostPath(project.path, this.wslEnvironment)
			: project.path;
		if (!this.hasTrustRequiringResources(hostCwd)) {
			// 干净项目：pi 无需加载项目级资源，pi-desktop 自动记入信任，避免每次创建 Agent 重复检查。
			void this.appLogger?.info("agent", "Agent ensure trusted directory start", { cwd });
			await this.configManager.ensureTrustedDirectory(cwd);
			void this.appLogger?.info("agent", "Agent ensure trusted directory completed", { cwd });
			return undefined;
		}
		const decision = await this.configManager.getProjectTrustDecision(cwd);
		if (decision === true) return undefined;
		// 未记录或曾记 false：弹窗让用户选择信任策略。不写 false，确保下次打开仍可重新决策。
		const choice = await this.requestProjectTrust(cwd, project.name);
		if (choice === "trust-remember") {
			await this.configManager.setProjectTrustDecision(cwd, true);
			return undefined;
		}
		if (choice === "trust-session") {
			return "approve";
		}
		// deny：本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
		return "no-approve";
	}

	/**
	 * 通过 IPC 请求渲染进程弹出项目信任确认窗，等待用户选择。
	 * 无窗口可用（如 headless）或 60 秒未响应时默认拒绝（安全优先）。
	 */
	private requestProjectTrust(cwd: string, projectName: string): Promise<ProjectTrustChoice> {
		const requestId = randomUUID();
		const win = this.getWindow();
		if (!win || win.isDestroyed()) {
			return Promise.resolve<ProjectTrustChoice>("deny");
		}
		return new Promise<ProjectTrustChoice>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingTrustRequests.delete(requestId)) {
					resolve("deny");
				}
			}, 60_000);
			this.pendingTrustRequests.set(requestId, {
				resolve: (choice) => {
					clearTimeout(timer);
					resolve(choice);
				},
			});
			win.webContents.send(ipcChannels.agentsTrustRequest, { requestId, cwd, projectName });
		});
	}

	/** 渲染进程回传用户对信任确认弹窗的选择，唤醒等待中的 Agent 创建流程。 */
	respondTrustRequest(requestId: string, choice: ProjectTrustChoice): void {
		const pending = this.pendingTrustRequests.get(requestId);
		if (pending) {
			this.pendingTrustRequests.delete(requestId);
			pending.resolve(choice);
		}
	}

	private handleAssistantMessageEvent(runtime: AgentRuntime, event: Record<string, any>) {
		// 双保险：即使调用方漏判，也在这里拦截封印 generation 的残留 delta。
		if (this.isAgentStreamSealed(runtime)) return;
		const assistantEvent = event.assistantMessageEvent as Record<string, any>;
		const eventType = assistantEvent.type as string | undefined;
		const partialMessage =
			event.message ??
			assistantEvent.message ??
			assistantEvent.partial ??
			assistantEvent.partialMessage;

		if (eventType === "start" || eventType === "message_start") {
			this.beginAssistantMessage(runtime);
			this.upsertAssistantMessage(runtime, partialMessage);
			return;
		}

		if (eventType === "text_start" || eventType === "text_end") {
			this.upsertAssistantMessage(runtime, partialMessage);
			return;
		}

		if (eventType === "text_delta") {
			// 增量模式：text_delta 是高频路径（每 token 一次），跳过对 partialMessage
			// 累积 content 的全量提取（extractMessageText 是 O(累积文本) 正则+拼接），
			// 直接追加 delta。delta 追加语义由 pi 协议保证；text_start/message_end 等
			// 终态仍走全量提取校准，最终文本不会漂移。
			this.upsertAssistantMessage(
				runtime,
				partialMessage,
				String(assistantEvent.delta ?? ""),
				true,
			);
			return;
		}
		if (eventType === "thinking_delta") {
			const prev = runtime.streamingThinking;
			const delta = String(assistantEvent.delta ?? "");
			// 同一轮 agent 内可能有多段思考（思考→工具→再思考）。
			// 上一段已结束（thinkingEndedAt 有值）时视为新一轮思考，刷新起点，
			// 否则时长会从第一段起点累计，把工具调用等无关时间算进本轮思考。
			if (runtime.thinkingStartedAt === undefined || runtime.thinkingEndedAt !== undefined) {
				runtime.thinkingStartedAt = Date.now();
			}
			runtime.thinkingEndedAt = undefined;
			// 只拼接一次、strip 一次；upsertAssistantMessage 的增量模式不会再全量
			// 提取 content，避免同一段思考文本被反复整段扫描。
			const nextThinking = prev + delta;
			runtime.streamingThinking = nextThinking;
			this.thinkingEmitter.push(runtime.tab.id, stripAnsi(nextThinking));
			this.upsertAssistantMessage(runtime, partialMessage, "", true);
			return;
		}

		if (eventType === "thinking_end") {
			const finalThinking = String(
				assistantEvent.content ?? runtime.streamingThinking ?? "",
			);
			if (finalThinking) {
				runtime.streamingThinking = finalThinking;
				this.thinkingEmitter.push(runtime.tab.id, stripAnsi(finalThinking));
				this.thinkingEmitter.flush(runtime.tab.id);
			}
			runtime.thinkingEndedAt = Date.now();
			this.upsertAssistantMessage(runtime, partialMessage);
			// 一段思考结束：清空累积缓冲。否则工具调用后第二段思考的
			// thinking_delta 会追加到本段完整文本之后，造成内容重复。
			runtime.streamingThinking = "";
			// thinking_end 是阶段性终态，立即 flush 让思考块完整落盘显示。
			this.flushMessageEmit(runtime);
			return;
		}

		if (eventType === "message_end" || eventType === "done" || eventType === "error") {
			this.upsertAssistantMessage(runtime, partialMessage);
			// message_end/done/error 是本轮回答的最终状态，立即 flush 确保完整消息及时可见。
			this.flushMessageEmit(runtime);
			runtime.activeAssistantMessageId = undefined;
		}
	}

	private beginAssistantMessage(runtime: AgentRuntime) {
		if (runtime.activeAssistantMessageId === undefined) {
			runtime.activeAssistantMessageId = randomUUID();
		}
	}

	private upsertAssistantMessage(
		runtime: AgentRuntime,
		partialMessage?: unknown,
		fallbackDelta = "",
		incremental = false,
	) {
		const agentId = runtime.tab.id;
		const list = runtime.messages;
		let messageId = runtime.activeAssistantMessageId;
		if (!messageId) {
			messageId = randomUUID();
			runtime.activeAssistantMessageId = messageId;
		}

		// 增量模式（text_delta / thinking_delta 高频路径）：跳过对 partialMessage.content
		// 的全量提取。每条 delta 都携带完整累积 content，全量 extractMessageText +
		// extractThinking + stripAnsi 是 O(累积文本)，长回答整体退化为 O(N²)。
		// delta 追加语义由 pi 协议保证（QuickGenProcess 同样按 delta 累积）；
		// message_end/text_end/thinking_end 等终态走全量提取，用完整 content 校准。
		const partialContent =
			partialMessage && typeof partialMessage === "object" && "content" in partialMessage
				? partialMessage.content
				: undefined;
		const extractedText =
			!incremental && partialContent !== undefined
				? extractMessageText(partialContent)
				: "";
		const extractedThinking =
			!incremental && partialContent !== undefined
				? extractThinking(partialContent)
				: "";
		const pendingThinking = runtime.streamingThinking;
		const nextThinking = stripAnsi(extractedThinking || pendingThinking || "");
		const thinkingStartedAt = runtime.thinkingStartedAt;
		const thinkingEndedAt = runtime.thinkingEndedAt;

		// 单次线性扫描定位（findIndex），避免原先 find + indexOf 的双重扫描；
		// 流式消息总是数组尾部，findIndex 命中即退出。
		const existingIndex = list.findIndex((message) => message.id === messageId);
		if (existingIndex !== -1) {
			const existing = list[existingIndex];
			existing.text = extractedText || `${existing.text}${fallbackDelta}`;
			if (nextThinking) existing.thinking = nextThinking;
			existing.timestamp = Date.now();
			if (thinkingStartedAt) {
				if (existing.thinkingStartedAt !== thinkingStartedAt) {
					// 新一轮思考开始（起点已刷新）：旧的 thinkingEndedAt 不再适用，
					// 必须清除，否则 UI 会误判思考已结束、停止实时计时。
					existing.thinkingEndedAt = undefined;
				}
				existing.thinkingStartedAt = thinkingStartedAt;
			}
			if (thinkingEndedAt) existing.thinkingEndedAt = thinkingEndedAt;
			// 就地更新：标记该消息自上次 flush 起已变更，增量推送需覆盖它。
			this.markMessagesDirty(runtime, existingIndex);
		} else {
			const text = extractedText || fallbackDelta;
			if (!text) return;
			list.push({
				id: messageId,
				agentId,
				role: "assistant",
				text,
				timestamp: Date.now(),
				...(nextThinking ? { thinking: nextThinking } : {}),
				...(thinkingStartedAt ? { thinkingStartedAt } : {}),
				...(thinkingEndedAt ? { thinkingEndedAt } : {}),
			});
			this.markMessagesDirty(runtime, list.length - 1);
		}

		if (nextThinking && (extractedText || fallbackDelta)) {
			runtime.streamingThinking = "";
			this.emitThinking(agentId, "");
		}

		// upsertAssistantMessage 被 text_delta/thinking_delta 高频调用，走节流合并；
		// message_end/thinking_end 等终态调用方会在调用后显式 flush，保证最终状态及时。
		this.scheduleMessageEmit(runtime);
	}

	/**
	 * 识别 todo 写入类工具（大小写不敏感）。
	 * omp 原生工具名为 "todo"；TodoWrite / todo_write 为其它 harness 命名变体。
	 * 只匹配写入工具，不匹配 todo_list / todo_get 等只读查询——它们不更新 todo 列表。
	 */
	private upsertToolMessage(
		runtime: AgentRuntime,
		event: Record<string, any>,
		status: "running" | "done" | "error",
	) {
		const agentId = runtime.tab.id;
		const toolName = event.toolName || "tool";
		const toolCallId = String(event.toolCallId ?? `${toolName}-${Date.now()}`);
		const agentTools = runtime.toolMessageIds;

		let messageId = agentTools.get(toolCallId);
		if (!messageId) {
			messageId = randomUUID();
			agentTools.set(toolCallId, messageId);
		}

		const list = runtime.messages;
		const existingIndex = list.findIndex((message) => message.id === messageId);
		const existing = existingIndex !== -1 ? list[existingIndex] : undefined;
		const isError = status === "error" || event.isError === true;
		const args = event.args ?? existing?.meta?.args;
		const startedAt =
			typeof existing?.meta?.startedAt === "number"
				? existing.meta.startedAt
				: Date.now();
		// 工具耗时只能由 start/end 两个事件推导；start 时先保存 startedAt，end 时再写入 durationMs，
		// 避免使用消息 timestamp（会在 update/end 时刷新）导致历史恢复后耗时不可还原。
		const durationMs =
			status === "running" ? undefined : Math.max(0, Date.now() - startedAt);
		const result =
			event.result ??
			event.partialResult ??
			event.output ??
			existing?.meta?.result;
		// 完整结果文本只算一次：detailText（截断版）、meta.result（截断版）、
		// truncated 判定与全文缓存（未截断）共用同一份，避免大工具结果在同一事件内
		// 被 extractToolResultText / safeJson 重复处理（历史实现计算了 2~3 次）。
		const fullResultText =
			extractToolResultText(result) || safeJson(result) || "";
		// tool_execution_start 事件（omp 协议）不带 result/partialResult/output，
		// result 为 undefined；safeJson 归一为 "" 后此处恒为字符串，下游 .length 安全。
		const detailText = formatToolDetail(toolName, args, result, isError, fullResultText);
		const icon = status === "running" ? "▶" : isError ? "✗" : "✓";
		const text =
			status === "running" ? `${icon} ${toolName}` : `${icon} ${toolName}`;
		// args 可能来自 event.args（对象）或 existing.meta.args（已序列化的 JSON 字符串）。
		// 如果是后者（如 tool_execution_end 不带 args），直接复用已有字符串避免 double encoding。
		const argsMeta = typeof args === "string" ? args : truncateForDetail(safeJson(args));
		// omp 等工具的结构化结果快照（todo 的 details.phases）以对象形式保存，
		// 供工具卡渲染与历史恢复解析；extractToolResultText 只保留文本会丢失该信息。
		const resultDetails = extractResultDetails(result);
		// 提取 ask_question 详情用于渲染提问卡片；支持批量（questions 数组）和单问题两种格式。
		// pi RPC 返回格式可能为 result.details 嵌套 或 result 顶层（无 details 包装）
		const askDetails = extractAskQuestionDetails(toolName, result, args);
		const askCard = buildAskCard(askDetails, runtime.abortedDuringAsk);
		if (fullResultText.length > MAX_TOOL_RESULT_CHARS) {
			this.toolFullTextByMessageId.set(messageId, fullResultText);
			// LRU：超限时删除最早插入的一条（Map 迭代序即插入序）
			if (this.toolFullTextByMessageId.size > AgentManager.TOOL_FULL_TEXT_LRU_MAX) {
				const oldest = this.toolFullTextByMessageId.keys().next().value;
				if (oldest !== undefined) this.toolFullTextByMessageId.delete(oldest);
			}
		}
		const meta = {
			status,
			toolName,
			toolCallId,
			startedAt,
			...(durationMs !== undefined ? { durationMs } : {}),
			args: argsMeta,
			result: truncateForDetail(fullResultText),
			...(fullResultText.length > MAX_TOOL_RESULT_CHARS
				? { truncated: true, fullLength: fullResultText.length }
				: {}),
			...(resultDetails !== undefined ? { details: resultDetails } : {}),
			isError,
			detailText,
			// originalContent 不再存储到消息中（full file 会使会话元数据体积过大）。
			// diff 使用工具参数（oldText/newText 等）展示变动区域，无需完整文件快照。

			...(askCard ? { _askCard: askCard } : {}),
		};

		if (existing) {
			existing.text = text;
			existing.timestamp = Date.now();
			existing.meta = meta;
			this.markMessagesDirty(runtime, existingIndex);
		} else {
			list.push({
				id: messageId,
				agentId,
				role: "tool",
				text,
				timestamp: Date.now(),
				meta,
			});
			this.markMessagesDirty(runtime, list.length - 1);
		}

		this.scheduleMessageEmit(runtime);
	}

	private addMessage(
		runtime: AgentRuntime,
		role: ChatMessage["role"],
		text: string,
		meta?: Record<string, unknown>,
		images?: ImageContent[],
	) {
		const agentId = runtime.tab.id;
		const message: ChatMessage = {
			id: randomUUID(),
			agentId,
			role,
			text,
			timestamp: Date.now(),
			meta,
			...(images && images.length > 0 ? { images } : {}),
		};
		runtime.messages.push(message);
		this.markMessagesDirty(runtime, runtime.messages.length - 1);
		if (role === "user" || role === "assistant") this.refreshAutoTitle(runtime);
		this.scheduleMessageEmit(runtime, true);
		// 语义事件：消息追加在统一写入点汇聚发出（而非散落在各调用处），
		// 保证订阅者拿到的 message 与 runtime.messages 中实际落库的对象完全同构。
		this.notifyEventListeners({ type: "messageAppended", agentId, message });
	}

	private refreshAutoTitle(runtime: AgentRuntime) {
		const project = this.getProject(runtime.tab.projectId);
		if (!project) return false;
		if (!this.isDefaultAgentTitle(runtime.tab.title, project)) return false;
		const nextTitle = this.inferTitleFromMessages(runtime.messages);
		if (!nextTitle || nextTitle === runtime.tab.title) return false;
		// Agent 列表标题应和历史会话列表的“摘要名”一致；
		// 只覆盖默认标题，避免打开/重命名过的历史会话名称被第一条消息反向改掉。
		runtime.tab.title = nextTitle;
		this.emitState();
		return true;
	}

	private isDefaultAgentTitle(title: string, project: Project) {
		return (
			title === `${project.name} agent` ||
			title === `${project.name} 历史会话` ||
			title === "历史会话"
		);
	}

	private inferTitleFromMessages(messages: ChatMessage[]) {
		const firstUserText = messages.find((message) => message.role === "user")?.text;
		const firstAssistantText = messages.find(
			(message) => message.role === "assistant",
		)?.text;
		return this.cleanTitle(firstUserText) || this.cleanTitle(firstAssistantText);
	}

	private cleanTitle(value?: string) {
		const text = value?.replace(/\s+/g, " ").trim();
		if (!text || /^untitled$/i.test(text)) return undefined;
		return text.length > 32 ? `${text.slice(0, 32)}…` : text;
	}

	private addDetailedErrorMessage(runtime: AgentRuntime, errorMessage: string) {
		const retryMessageId = runtime.retryStatusMessageId;
		const retryMessage = retryMessageId
			? runtime.messages.find((message) => message.id === retryMessageId)
			: undefined;
		const attempt = Number(retryMessage?.meta?.attempt ?? 0);
		const maxAttempts = Number(retryMessage?.meta?.maxAttempts ?? 0);
		const retryLine = maxAttempts > 0 ? `\n\n已自动重试：${attempt}/${maxAttempts} 次` : "";
		// 最终失败时把重试次数和原始错误放在同一条错误消息里，便于用户复制给模型/服务商排查。
		this.addMessage(runtime, "error", `请求失败。${retryLine}\n\n原因：${errorMessage}`);
	}

	private upsertRetryStatusMessage(
		runtime: AgentRuntime,
		event: Record<string, any>,
		status: "running" | "success" | "error",
	) {
		const agentId = runtime.tab.id;
		const list = runtime.messages;
		let messageId = runtime.retryStatusMessageId;
		let message = messageId ? list.find((item) => item.id === messageId) : undefined;
		if (!message) {
			messageId = randomUUID();
			message = {
				id: messageId,
				agentId,
				role: "system",
				text: "",
				timestamp: Date.now(),
			};
			list.push(message);
			this.markMessagesDirty(runtime, list.length - 1);
			runtime.retryStatusMessageId = messageId;
		}

		const attempt = Number(event.attempt ?? message.meta?.attempt ?? 0);
		const maxAttempts = Number(event.maxAttempts ?? message.meta?.maxAttempts ?? 0);
		const delayMs = Number(event.delayMs ?? 0);
		const reason = String(
			event.errorMessage ?? event.finalError ?? message.meta?.errorMessage ?? "未知错误",
		);
		const delayText = delayMs > 0 ? `，${Math.ceil(delayMs / 1000)} 秒后重试` : "";
		const countText = maxAttempts > 0 ? `${attempt}/${maxAttempts}` : String(attempt || 1);

		if (status === "running") {
			message.text = `正在自动重试 ${countText}${delayText}\n原因：${reason}`;
		} else if (status === "success") {
			message.text = `自动重试成功，共重试 ${attempt} 次`;
		} else {
			message.text = `自动重试失败，已重试 ${countText} 次\n原因：${reason}`;
		}
		message.timestamp = Date.now();
		message.meta = { status, attempt, maxAttempts, delayMs, errorMessage: reason };
		this.markMessageDirty(runtime, message);

		this.scheduleMessageEmit(runtime, true);
	}

	private scheduleUIRequestTimeout(agentId: string, requestId: string, timeout: unknown) {
		if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return;

		const timer = setTimeout(() => {
			const runtime = this.agents.get(agentId);
			if (!runtime) return;
			const pending = runtime.pendingUIRequests;
			if (!pending.has(requestId)) return;

			pending.delete(requestId);

			const messages = runtime.messages;
			const idx = messages.findIndex(
				(msg) =>
					msg.role === "system" &&
					msg.meta?.type === "askQuestion" &&
					(msg.meta as Record<string, unknown>).uiRequest &&
					((msg.meta as Record<string, unknown>).uiRequest as Record<string, unknown>).requestId === requestId,
			);
			if (idx !== -1) {
				messages.splice(idx, 1);
				this.markMessagesDirty(runtime, idx);
				this.scheduleMessageEmit(runtime, false);
			}

			this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true, cancelled: true });
		}, Math.floor(timeout));
		timer.unref?.();
	}

	private scheduleIdleCheckAfterExtensionCommand(agentId: string) {
		const timer = setTimeout(() => {
			void this.markIdleIfPiReportsNoWork(agentId);
		}, 100);
		timer.unref?.();
	}

	/**
	 * 调度一次最终空闲检查（omp 没有 agent_settled 事件）。
	 * agent_end / auto_compaction_end 后调用；延迟后通过 get_state 校验
	 * （isStreaming/isCompacting/pendingMessageCount）确认 pi 已无工作才置 idle，
	 * 因此提前检查不会误判压缩中或 queued follow-up 为完成。
	 */
	private scheduleSettleCheck(runtime: AgentRuntime, agentId: string) {
		clearTimeout(runtime.settleCheckTimer);
		runtime.settleCheckTimer = setTimeout(() => {
			runtime.settleCheckTimer = undefined;
			void this.markIdleIfPiReportsNoWork(agentId);
		}, AgentManager.AGENT_SETTLED_TIMEOUT_MS);
		runtime.settleCheckTimer.unref?.();
	}

	private async markIdleIfPiReportsNoWork(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime || runtime.tab.status !== "running") return;
		if (runtime.pendingUIRequests.size > 0) return;
		if (runtime.rpcCompacting || runtime.compacting) return;
		if (runtime.activeAssistantMessageId !== undefined) return;
		if (runtime.toolExecuting) return;

		const response = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => undefined);
		if (!response?.success || !response.data) return;

		const state = response.data as {
			isStreaming?: boolean;
			isCompacting?: boolean;
			pendingMessageCount?: number;
			queuedMessageCount?: number;
		};
		// omp 返回 queuedMessageCount，旧 pi 用 pendingMessageCount：两者都读，任一非零都视为仍有排队消息
		const queued = (state.pendingMessageCount ?? 0) + (state.queuedMessageCount ?? 0);
		// 布尔字段严格判定：omp 可能以字符串形式返回（"false" truthy），
		// 宽松判定会让空闲检查永远无法通过，UI 停在 running。
		if (
			state.isStreaming === true ||
			state.isCompacting === true ||
			queued > 0
		) return;

		runtime.tab.status = "idle";
		runtime.streamingThinking = "";
		runtime.thinkingStartedAt = undefined;
		runtime.thinkingEndedAt = undefined;
		this.emitThinking(agentId, "");
		this.emitState();
		void this.emitRuntimeState(agentId);
		// 语义事件：omp 无 agent_settled 事件，本函数（get_state 校验后确认无后续工作）
		// 就是 omp 下唯一真实的 settled 汇聚点；进入本函数时 status 必为 running，
		// 因此不会与 agent_settled 分支重复发（该分支先到会清掉本兜底定时器）。
		this.notifyEventListeners({ type: "settled", agentId });
	}

	private requireRuntime(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error(`Agent not found: ${agentId}`);
		return runtime;
	}

	/**
	 * 会话结束时发送系统通知。
	 * 仅在设置中启用通知且 Electron Notification 可用时触发，
	 * 通知用户 agent 已完成响应，可以查看结果或继续对话。
	 */
	private notifySessionEnd(sessionTitle: string) {
		try {
			const settings = this.settingsStore.get();
			if (!settings.enableNotifications) return;
			if (!Notification.isSupported()) return;

			// 使用应用名称作为通知标题，在 Windows/macOS 通知中心中显示为应用标识
			const appName = app.getName();
			const notification = new Notification({
				title: appName,
				body: `${sessionTitle} 已完成响应`,
				silent: false,
			});
			notification.show();
		} catch {
			// 通知失败不影响主流程，静默处理
		}
	}

	/** abort 时封印当前 generation。 */
	private sealAgentStream(runtime: AgentRuntime) {
		runtime.streamGate = sealStreamGate(runtime.streamGate);
	}

	/** agent_start 时尝试推进 generation；若仍在等 abort settled，则只记 pending。 */
	private openAgentStream(runtime: AgentRuntime) {
		runtime.streamGate = openStreamGateForNewRun(runtime.streamGate);
	}

	/** abort 后的 agent_settled：结束 waiting，必要时解封 pending start。 */
	private noteAgentAbortSettled(runtime: AgentRuntime) {
		this.clearAbortSettledFallback(runtime);
		runtime.streamGate = noteAbortSettled(runtime.streamGate);
	}

	/**
	 * pi 偶发不发 agent_settled 时的兜底：超时后按 settled 处理，
	 * 避免用户立刻重发时新一轮永远无法接收流式事件。
	 */
	private scheduleAbortSettledFallback(runtime: AgentRuntime) {
		this.clearAbortSettledFallback(runtime);
		const agentId = runtime.tab.id;
		const timer = setTimeout(() => {
			// 定时器触发时 agent 可能已被 stop 删除；重新查询，避免操作已脱离 map 的 runtime。
			const current = this.agents.get(agentId);
			if (!current) return;
			current.abortSettledFallbackTimer = undefined;
			// 仅在仍 waiting 时生效；正常 settled 路径会先 clear 定时器。
			if (current.streamGate.waitingForAbortSettled) {
				this.noteAgentAbortSettled(current);
			}
		}, AgentManager.ABORT_SETTLED_FALLBACK_MS);
		timer.unref?.();
		runtime.abortSettledFallbackTimer = timer;
	}

	private clearAbortSettledFallback(runtime: AgentRuntime) {
		const timer = runtime.abortSettledFallbackTimer;
		if (timer) {
			clearTimeout(timer);
			runtime.abortSettledFallbackTimer = undefined;
		}
	}

	/** 当前 generation 是否已封印，封印期间所有流式事件应丢弃。 */
	private isAgentStreamSealed(runtime: AgentRuntime): boolean {
		return isStreamGateSealed(runtime.streamGate);
	}

	/** agent 关闭/重建时清理 gate，避免泄漏到新生命周期。 */
	private clearStreamGate(runtime: AgentRuntime) {
		this.clearAbortSettledFallback(runtime);
		runtime.streamGate = createStreamGateState();
		runtime.recentlyAborted = false;
		this.thinkingEmitter.cancel(runtime.tab.id);
		this.cancelMessageEmit(runtime);
		// 清理运行态节流定时器与在途合并状态，避免 agent 删除后残留 timer / pending
		const throttleTimer = this.runtimeStateThrottleTimers.get(runtime.tab.id);
		if (throttleTimer) {
			clearTimeout(throttleTimer);
			this.runtimeStateThrottleTimers.delete(runtime.tab.id);
		}
		this.runtimeStatePending.delete(runtime.tab.id);
		this.runtimeStateInFlight.delete(runtime.tab.id);
		this.runtimeStateLastEmitAt.delete(runtime.tab.id);
	}

	private scheduleMessageEmit(runtime: AgentRuntime, immediate = false) {
		if (immediate) {
			this.flushMessageEmit(runtime);
			return;
		}
		if (runtime.pendingMessage) return;
		runtime.pendingMessage = true;
		const timer = setTimeout(() => this.flushMessageEmit(runtime), AgentManager.MESSAGE_FLUSH_INTERVAL_MS);
		// 节流定时器不应阻止进程退出
		timer.unref?.();
		runtime.messageFlushTimer = timer;
	}

	/** 记录消息数组自上次 flush 以来的最早变更下标，增量推送据此计算 replaceFrom。 */
	private markMessagesDirty(runtime: AgentRuntime, fromIndex: number): void {
		if (fromIndex < runtime.messageDirtyFrom) runtime.messageDirtyFrom = fromIndex;
	}

	/** 记录某条消息被就地变更（按引用定位下标，避免各调用方自己维护 index）。 */
	private markMessageDirty(runtime: AgentRuntime, message: ChatMessage | undefined): void {
		if (!message) return;
		const index = runtime.messages.indexOf(message);
		if (index !== -1) this.markMessagesDirty(runtime, index);
	}

	/** 整组消息被重建（历史加载/重启替换），下一次 flush 必须全量推送基线。 */
	private markAllMessagesDirty(runtime: AgentRuntime): void {
		runtime.messageDirtyFrom = 0;
	}

	/** 取消尚未 flush 的消息推送，abort 时避免旧数组晚到覆盖 UI。 */
	private cancelMessageEmit(runtime: AgentRuntime) {
		const timer = runtime.messageFlushTimer;
		if (timer) {
			clearTimeout(timer);
			runtime.messageFlushTimer = undefined;
		}
		runtime.pendingMessage = false;
	}

	private flushMessageEmit(runtime: AgentRuntime) {
		const timer = runtime.messageFlushTimer;
		if (timer) {
			clearTimeout(timer);
			runtime.messageFlushTimer = undefined;
		}
		runtime.pendingMessage = false;
		const messages = runtime.messages;
		// 增量推送：只传输 messageDirtyFrom 之后的变更。replaceFrom === 0 时是
		// 全量基线（渲染层 slice(0,0) 合并即整体替换），其余情况为尾部增量。
		const replaceFrom = Math.min(runtime.messageDirtyFrom, messages.length);
		// 本轮变更已随 slice 发出，重置为数组尾部；下一次变更再向前收缩。
		runtime.messageDirtyFrom = messages.length;
		const t0 = perfStart("agents:message-flush");
		this.emit(ipcChannels.agentsMessage, {
			agentId: runtime.tab.id,
			replaceFrom,
			messages: messages.slice(replaceFrom),
		});
		perfEnd("agents:message-flush", t0, {
			agentId: runtime.tab.id,
			replaceFrom,
			sent: messages.length - replaceFrom,
			total: messages.length,
		});
	}

	private emitThinking(agentId: string, thinking: string) {
		if (!thinking) this.thinkingEmitter.cancel(agentId);
		this.emitThinkingNow(agentId, thinking);
	}

	private emitThinkingNow(agentId: string, thinking: string) {
		const update: ThinkingUpdate = { agentId, thinking };
		this.emit(ipcChannels.agentsThinking, update);
	}

	/**
	 * 节流后的状态推送：50ms latest-wins 合并。
	 * 工具密集循环（tool_start/end 交替）每个事件都调 emitState，每次都全量
	 * AgentTab[] 排序 + 结构化克隆跨进程推送；合并窗口内只发最新一次，
	 * 渲染层无需中间态（与消息 flush 共用同一窗口策略）。
	 */
	private stateEmitTimer: NodeJS.Timeout | undefined;
	private static readonly STATE_EMIT_INTERVAL_MS = 50;

	private emitState() {
		if (this.stateEmitTimer) return;
		this.stateEmitTimer = setTimeout(() => {
			this.stateEmitTimer = undefined;
			this.emitStateNow();
		}, AgentManager.STATE_EMIT_INTERVAL_MS);
		this.stateEmitTimer.unref?.();
	}

	private emitStateNow() {
		const tabs = this.list();
		this.emit(ipcChannels.agentsState, tabs);
		// 同步通知主进程内部状态订阅者（PetStateBridge），使宠物窗能拿到聚合状态。
		// 设计文档原拟用 ipcMain.on("agents:state") 桥接是错的：webContents.send 是
		// 主进程→渲染层单向通道，ipcMain 收不到主进程自己发出的消息，故改用本钩子。
		this.notifyStateListeners(tabs);
		// 语义事件：statusChanged 只在状态实际变化时发（diff 上次已发表值）。
		// 不选 ~20 处 `tab.status =` 散点 hook：散点路径多（start/stop/exit/settle/restart
		// 等）易遗漏，且同一状态连续赋值不应重复通知；50ms 聚合点做 diff 侵入最小且不遗漏。
		for (const tab of tabs) {
			const previous = this.lastEmittedTabStatus.get(tab.id);
			if (previous !== tab.status) {
				this.lastEmittedTabStatus.set(tab.id, tab.status);
				this.notifyEventListeners({
					type: "statusChanged",
					agentId: tab.id,
					status: tab.status,
					tab,
				});
			}
		}
	}

	private emit(channel: string, payload: unknown) {
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return;
		window.webContents.send(channel, payload);
	}
}

/**
 * 单个 Agent 的全部运行态。
 *
 * 过去 per-agent 状态散落在 ~25 个 `Map<agentId, T>` / `Set<agentId>` side-table 里，
 * 理解一次 agent 生命周期需要逐个查 25 张表。这里把所有 per-agent 状态收拢进一个对象，
 * `handlePiEvent` 直接读写 runtime 字段，而不是散落地 mutate 多个 Map。
 *
 * 仍保留为类级字段的 per-agent 协调结构：
 * - `creatingSessionAgents`（按 sessionKey 索引，runtime 尚未创建前用于去重并发 create）
 * - `pendingTrustRequests`（按 requestId 索引，不属于某个 agent）
 * - `thinkingEmitter`（共享节流发射器，内部按 agentId 维度）
 */
type AgentRuntime = {
	// 身份与进程
	tab: AgentTab;
	process: PiProcess;

	// 消息时间线状态
	messages: ChatMessage[];
	/** 当前正在流式更新的 assistant 消息 id；tool 事件插入时继续更新同一回答块 */
	activeAssistantMessageId?: string;
	/** toolCallId -> messageId，把同一次工具调用合并成一条 UI 记录 */
	toolMessageIds: Map<string, string>;
	/** 每个 agent 只保留一条自动重试状态消息，避免短暂 5xx 刷屏 */
	retryStatusMessageId?: string;

	// 流式思考状态
	streamingThinking: string;
	thinkingStartedAt?: number;
	thinkingEndedAt?: number;

	// 工具运行态
	toolStateSequence: number;
	/** toolCallId -> toolName，并行工具等最后一个结束才发 false 边沿 */
	activeToolCalls: Map<string, string>;
	toolExecuting: string | null;
	/** 完整运行态推送的单调序号：渲染层据此丢弃乱序到达的旧快照（长任务后 RPC 慢更容易乱序）。 */
	runtimeStateSeq: number;

	// abort 流式闸门（按 generation 封印残留 delta）
	streamGate: StreamGateState;
	abortSettledFallbackTimer?: NodeJS.Timeout;
	/** omp 无 agent_settled 事件时的最终空闲检查定时器（agent_end/压缩结束后调度） */
	settleCheckTimer?: NodeJS.Timeout;

	// 消息 emit 节流
	messageFlushTimer?: NodeJS.Timeout;
	pendingMessage: boolean;
	/**
	 * 自上次 flush 以来最早被变更的消息下标，作为增量推送的 replaceFrom。
	 * flush 后重置为 messages.length；任何消息增/删/就地更新都向前收缩该值。
	 * 历史加载/重启重建时置 0，强制下一次 flush 全量推送基线。
	 */
	messageDirtyFrom: number;

	// 扩展 UI 请求（abort 时需 cancel，防止 pi 等待超时）
	pendingUIRequests: Map<string, { method: string; title: string }>;

	/**
	 * 会话文件写入互斥锁链（readFile→modify→writeFile 原子化）
	 */
	sessionLock?: Promise<void>;

	// 生命周期 flag（原为 Set<agentId>）
	rpcLogging: boolean;
	/** 手动压缩，用于 exit 处理器区分压缩重启与异常崩溃 */
	compacting: boolean;
	/** pi 报告的自动/手动压缩，agent_end 后仍可能压缩，避免过早置 idle */
	rpcCompacting: boolean;
	/** 模型配置刷新中，exit 处理器忽略退出事件（当前未写入，预留） */
	modelRefreshing: boolean;
	/** 用户主动停止，exit 处理器跳过自动重连 */
	userInitiatedStop: boolean;
	/** 已尝试过自动重连（防无限循环），重连成功后清除 */
	autoRestartAttempted: boolean;
	/** 用户主动 abort 后等待 pi 确认，抑制 auto-retry/compaction 状态回写 */
	recentlyAborted: boolean;
	/** abort 时正等待 ask_question 响应，工具结果中覆写 answer 为 null */
	abortedDuringAsk: boolean;
};

/** 创建一个带有全部 per-agent 状态默认值的 AgentRuntime。 */
function createAgentRuntime(tab: AgentTab, process: PiProcess): AgentRuntime {
	return {
		tab,
		process,
		messages: [],
		toolMessageIds: new Map(),
		streamingThinking: "",
		toolStateSequence: 0,
		activeToolCalls: new Map(),
		toolExecuting: null,
		streamGate: createStreamGateState(),
		pendingMessage: false,
		messageDirtyFrom: 0,
		pendingUIRequests: new Map(),
		rpcLogging: false,
		compacting: false,
		rpcCompacting: false,
		runtimeStateSeq: 0,
		modelRefreshing: false,
		userInitiatedStop: false,
		autoRestartAttempted: false,
		recentlyAborted: false,
		abortedDuringAsk: false,
	};
}
