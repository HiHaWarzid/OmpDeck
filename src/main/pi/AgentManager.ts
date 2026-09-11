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
import { PiProcess } from "./PiProcess";
import type { RpcResponse } from "./PiRpcClient";
import { formatBashToolMessage } from "./bashResult";
import { extractMessageText } from "./messageContent";
import { mergeHistoryWithPreservedMessages } from "./historyMessages";
import {
	buildActiveBranchEntryIds,
	convertAgentMessages,
	getToolPathFromArgs,
	trimHistoryMessages,
} from "./messageTimeline";
import { perfEnd, perfStart } from "../perf";
import {
	tryParseBatchAskEnvelope,
} from "./askQuestionCard";
import {
	extractImages,
	stripAnsi,
} from "./messageTextUtils";
import {
	assertResendRootEntry,
	collectDescendantEntryIds,
	findLastUserMessageLine,
	takeActiveEntryId,
} from "./sessionEntryIds";
import { SessionJsonl } from "./sessionJsonl";
import { LatestByKeyEmitter } from "./LatestByKeyEmitter";

/**
 * 流式增量事件类型：text_delta/thinking_delta 每 token 一条，RPC 日志默认不落盘
 * （用户打开 RPC 控制台后记录全量）。其余 send/response/阶段事件低频且有诊断价值。
 */
const RPC_STREAMING_DELTA_TYPES: Record<string, true> = {
	text_delta: true,
	thinking_delta: true,
};

/** RPC 日志默认落盘判定：send 与阶段/响应事件全记，流式增量跳过。 */
export function isRpcLogWorthy(entry: { direction: string; data: unknown }): boolean {
	if (entry.direction === "send") return true;
	const data = entry.data as Record<string, unknown> | undefined;
	if (data?.type !== "message_update") return true;
	const eventType = (data.assistantMessageEvent as Record<string, unknown> | undefined)?.type;
	return typeof eventType !== "string" || RPC_STREAMING_DELTA_TYPES[eventType] !== true;
}
import {
	createStreamGateState,
	isStreamGateSealed,
	noteAbortSettled,
	openStreamGateForNewRun,
	sealStreamGate,
	type StreamGateState,
} from "./streamGate";
import {
	appendMessage as appendTranscriptMessage,
	beginAssistantMessage,
	appendThinkingDelta,
	cacheFullText,
	clearThinkingBuffer,
	createTranscriptState,
	endThinking,
	fullTextOf,
	markAllMessagesDirty,
	markDirtyFrom,
	markMessageDirty,
	replaceMessages,
	resetTranscriptRun,
	takeDirtySlice,
	upsertAssistantMessage,
	upsertToolMessage,
	type AgentTranscriptState,
} from "./agentTranscript";
import {
	closeRun as closeAgentRun,
	createRunState,
	decideSettle,
	hasLocalWork,
	isRunSealed,
	noteRunAbortSettled,
	sealRun,
	SETTLE_POLL_TIMEOUT_MS,
	type AgentRunState,
	type LocalWorkSignals,
	type PiStateFields,
} from "./agentRunState";
import {
  updateActiveToolCalls,
  type ActiveToolCallState,
} from "../../shared/toolRuntimeState";
import {
	ABORT_SETTLED_FALLBACK_MS,
	AGENT_SETTLED_TIMEOUT_MS,
	normalizePiBoolean,
	resolveSettle,
} from "./settleReducer";
import type { SettingsStore } from "../settings/SettingsStore";
import type { TrustStore } from "../config/TrustStore";
import type { RpcLogger } from "../logging/RpcLogger";
import type { AppLogger } from "../logging/AppLogger";
import {
	toWindowsHostPath,
	toWslLinuxPath,
	type WslEnvironment,
} from "../wsl/WslPaths";

/**
 * AgentManager 用到的配置能力（窄接口）。
 *
 * 原先整类依赖 862 行的 ConfigManager（实际只用到 3 个能力，且其中多数是
 * ConfigManager 对 rolesStore/trustStore 的纯转发）。收窄后依赖面就是这个对象：
 * 角色读取只留一个函数，信任决策拿到 store 本体，模型收敛只留一个函数。
 */
export type AgentConfigDeps = {
	/** 顶层 defaultThinkingLevel（config.yml，缺省 undefined）。 */
	readOmpDefaultThinkingLevel: () => Promise<string | undefined>;
	/** 按 models.json 收敛可用模型（pi 内置目录里未配置的供应商/模型剔除）。 */
	filterConfiguredModels: (models: AvailableModel[]) => Promise<AvailableModel[]>;
	/** 项目信任决策存储（探测/decide 注入 ask）。 */
	trustStore: TrustStore;
};

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
	 * omp settings.json 中 defaultThinkingLevel 的合法档位（含 auto）。
	 * 与 omp 的 parseConfiguredThinkingLevel 接受集合一致；值不在此集合内时
	 * 不向 RPC 转发，避免把用户配置的非法值变成每个会话启动时的报错。
	 */
	private static readonly OMP_THINKING_LEVELS: Record<string, true> = {
		off: true,
		minimal: true,
		low: true,
		medium: true,
		high: true,
		xhigh: true,
		max: true,
		auto: true,
	};
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
	/** 待处理的项目信任确认请求。key 为 requestId，用于在 Agent 启动前等待用户的信任决策。 */
	private readonly pendingTrustRequests = new Map<string, { resolve: (choice: ProjectTrustChoice) => void }>();
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
		private readonly config: AgentConfigDeps,
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
		return this.agents.get(agentId)?.transcript.messages ?? [];
	}

	/**
	 * 不启动 pi 进程，直接从 JSONL 构造与运行态相同的时间线数据。
	 * 转换规则（活动分支回溯 + 压缩归档参与）在 SessionJsonl.readDisplayMessages；
	 * 本方法只负责把协议路径交给 sessionJsonl 的宿主路径解析。
	 */
	async readSessionDisplayMessages(
		sessionPath: string,
		agentId = "_viewer",
		sessionContent?: string,
	): Promise<ChatMessage[]> {
		return this.sessionJsonl.readDisplayMessages(sessionPath, agentId, sessionContent);
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

		const messages = convertAgentMessages(agentId, finalRaw, activeEntryIds, runtime.run.abortedDuringAsk);
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
		runtime.run.abortedDuringAsk = false;
		const nextMessages = mergeHistoryWithPreservedMessages(
			messages,
			runtime.transcript.messages,
			options?.preserveMessagesAfter,
		);
		runtime.transcript.messages = nextMessages;
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

	/**
	 * 读取 omp config.yml 顶层 defaultThinkingLevel——config.yml 是 omp 全局权威源
	 * （omp 只在 config.yml 缺失时消费 settings.json）；旧 settings.json 的档位由
	 * 一次性迁移搬入 config.yml（只填空不覆盖，见 OmpRolesStore.migrateLegacy）。
	 * 只接受 omp 认识的档位，返回 undefined 表示未配置或值无效，不向 RPC 转发。
	 */
	private async readConfiguredDefaultThinkingLevel(): Promise<string | undefined> {
		try {
			const level = await this.config.readOmpDefaultThinkingLevel();
			return level !== undefined && AgentManager.OMP_THINKING_LEVELS[level] === true
				? level
				: undefined;
		} catch {
			// 读取失败按未配置处理：不阻塞 Agent 启动，用户仍可在输入栏手动切换。
			return undefined;
		}
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
			// AFK 编排器经 CreateAgentInput.cwd 指定 worktree 工作目录；tab.cwd 与 PiProcess 必须一致，
			// 半改会让 PiProcess 仍停留在项目根，出现「tab 显示 worktree 实际操作根目录」的错位。
			cwd: input.cwd ?? project.path,
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
		// cwd 与 tab.cwd 同源（input.cwd ?? project.path）：AFK 派发到 worktree 时进程必须落在同一目录。
		const process = new PiProcess(input.cwd ?? project.path, this.settingsStore.get(), undefined, {
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
			// lastError 供 AFK 编排器与错误卡读取（ADR-0005）；start 抛错即启动失败原因。
			tab.lastError = rawMessage;
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
			// 对齐 omp 默认思考级别：omp 创建会话时，默认模型角色里的 :level 后缀
			// （如 opencode/deepseek-v4-flash:max）优先级高于 settings.json 的
			// defaultThinkingLevel，导致用户配置的默认思考级别对新开会话不生效；
			// 会话就绪后主动 set 一次，让「默认思考级别」对所有新打开的会话生效。
			// 在历史消息加载前等待完成，保证 UI 拿到的首个 runtime state 已对齐。
			const configuredThinkingLevel = await this.readConfiguredDefaultThinkingLevel();
			if (configuredThinkingLevel) {
				const currentThinkingLevel = (state.data as { thinkingLevel?: unknown } | undefined)
					?.thinkingLevel;
				if (
					typeof currentThinkingLevel !== "string" ||
					currentThinkingLevel !== configuredThinkingLevel
				) {
					try {
						await client.request(
							{ type: "set_thinking_level", level: configuredThinkingLevel },
							10_000,
						);
						void this.appLogger?.info(
							"agent",
							"Configured default thinking level applied",
							{
								agentId: id,
								level: configuredThinkingLevel,
								previous: currentThinkingLevel,
							},
						);
					} catch (error) {
						// 应用失败不阻塞 Agent 启动：会话仍可用，用户可随时在输入栏手动切换。
						void this.appLogger?.warn(
							"agent",
							"Configured default thinking level apply failed",
							{
								agentId: id,
								level: configuredThinkingLevel,
								error: error instanceof Error ? error.message : String(error),
							},
						);
					}
				}
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
						const list = rt?.transcript.messages ?? [];
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
						const list = rt?.transcript.messages ?? [];
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
			tab.lastError = rawMessage;
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

		// 在设置状态为 running 之前检查进程是否还活着，避免进程崩溃后状态不一致
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			runtime.tab.lastError = errorMessage;
			this.addMessage(runtime, "error", errorMessage);
			this.emitState();
			return { accepted: false, error: errorMessage };
		}

		runtime.tab.status = "running";
		// 用户重新发送消息即恢复：清掉上次 error 的 lastError，避免状态恢复后展示陈旧错误。
		delete runtime.tab.lastError;
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
			runtime.tab.lastError = errorMessage;
			this.addMessage(runtime, "error", errorMessage);
			this.emitState();
			return { accepted: false, error: errorMessage };
		}

		runtime.tab.status = "running";
		// 重新执行命令即恢复：清掉上次 error 的 lastError，避免陈旧错误残留。
		delete runtime.tab.lastError;
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
			runtime.run.abortedDuringAsk = true;
			for (const [requestId] of pending) {
				runtime.process.client.sendRaw({
					type: "extension_ui_response",
					id: requestId,
					value: null,
				});
			}
		}

		// 标记最近中止的 agent，用于抑制 auto-retry/compaction 把状态重新标为 running；
		// 同时封印当前 stream generation（比 recentlyAborted 更硬）：残留 thinking/text/tool
		// 事件在 abort settled 前一律丢弃。必须在发送 abort RPC 之前完成，避免事件处理函数
		// 在 RPC 发出后、handlePiEvent 返回前收到管道中的旧事件并重建 assistant 消息。
		sealRun(runtime.run, Date.now());
		this.scheduleAbortSettledFallback(runtime);

		runtime.process.client
			.request({ type: "abort" }, 10_000)
			.catch(() => {
				// abort 超时或失败不影响前端状态切换
			});

		// 立即清理 pending UI 记录并移除 ask_question 卡片，不等待 abort 返回
		if (pending.size > 0) {
			const messages = runtime.transcript.messages;
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
		resetTranscriptRun(runtime.transcript);
		runtime.activeToolCalls.clear();
		runtime.toolExecuting = null;
		// 取消节流中的 thinking/message 推送，避免 abort 后还有 pending flush 把旧内容刷回 UI。
		this.thinkingEmitter.cancel(agentId);
		this.emitThinking(agentId, "");
		this.cancelMessageEmit(runtime);

		runtime.tab.status = "idle";
		// 中止即离开 error：清掉 lastError，避免状态恢复后展示陈旧错误。
		delete runtime.tab.lastError;
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

		// 非 AFK 路径（崩溃恢复/压缩重启）：不携带 CreateAgentInput.cwd，固定使用项目根目录；
		// 若未来需要按 worktree 重连，需与 createUnlocked 的 cwd 解析保持一致。
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
			runtime.run.abortedDuringAsk = false;

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
			// 空闲检查无法通过、左下角三点指示器卡住。这里与 settleReducer 共用同一
			// normalizePiBoolean 严格归一化（`=== true`，字符串/undefined/其它 truthy 一律 false）。
			isStreaming: normalizePiBoolean(state?.isStreaming),
			isCompacting:
				normalizePiBoolean(state?.isCompacting) ||
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
		return this.config.filterConfiguredModels(models);
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
				// 复用 agentRunState.decideSettle 的 poll 语义做即时复核：isStreaming/isCompacting
				// 的严格归一化、闸门封印与本地忙碌裁定与 settle 决策收敛到同一判定器。
				// timeoutMs=0：即时检查（无 settle 窗口概念），reducer 仅区分 undefined（未安排轮询）
				// 与有值（有权给结论），0 允许立即判定。
				const remote: PiStateFields = { isStreaming: state.isStreaming, isCompacting: state.isCompacting };
				const decision = decideSettle({
					run: runtime.run,
					local: this.localWorkSignals(runtime),
					remote,
					now: Date.now(),
					timeoutMs: 0,
				});
				// 非 idle 一律视为 busy（含 abort 封印中的 wait）：编辑/删除要在确定无事时才放行。
				if (decision.decision !== "idle") {
					throw new Error("BUSY_STREAMING: Agent is streaming, please wait");
				}
				// isExecutingTool 时也视为 busy（保留独立错误信息，便于 UI 区分展示）
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
				const messages = runtime.transcript.messages;
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
				const messages = runtime.transcript.messages;
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
	 * 优先本 agent 的运行时全文缓存（仅截断下发时才写入），
	 * 回退按 entryId 在会话文件里定位读取；找不到或读取失败抛错，由 IPC 层转结构化错误。
	 */
	async readMessageFullText(
		agentId: string,
		messageId: string,
		entryId?: string,
	): Promise<{ text: string }> {
		const runtime = this.agents.get(agentId);
		const cached = runtime ? fullTextOf(runtime.transcript, messageId) : undefined;
		if (cached !== undefined) return { text: cached };
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

			const messages = runtime.transcript.messages;
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
		// 临时会话（clone/export 等）非 AFK 路径：固定使用项目根目录，不接受 worktree cwd。
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
			// 默认（开关关闭）仍落盘低频事件（send/response/阶段事件），仅跳过
			// text_delta/thinking_delta 这类每 token 一条的流式增量——全量记录会
			// 拖慢事件循环且文件快速膨胀；用户打开 RPC 控制台后记录全量。
			const rt = this.agents.get(agentId);
			if (!rt || (!rt.rpcLogging && !isRpcLogWorthy(entry))) return;
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
				// 渲染层控制台只在开关打开时推送（实时逐条展示）；文件日志始终写。
				if (rt.rpcLogging) {
					this.emit(ipcChannels.agentsRpcLog, logEntry);
				}
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
			const message = error instanceof Error ? error.message : String(error);
			if (runtime) {
				runtime.tab.status = "error";
				// 进程级错误（spawn ENOENT、崩溃等）写入 lastError，供 AFK 判断失败原因（ADR-0005）。
				runtime.tab.lastError = message;
			}
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
			// 自动重连开始即恢复：清掉进程 error 留下的 lastError，避免重连成功后展示陈旧错误。
			delete tab.lastError;
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
			// 自动重连开始即恢复：清掉进程 error 留下的 lastError。
			delete runtime.tab.lastError;
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
			runtime.run.recentlyAborted = false;
			this.openAgentStream(runtime);
			if (runtime.settleCheckTimer) {
				clearTimeout(runtime.settleCheckTimer);
				runtime.settleCheckTimer = undefined;
			}
			runtime.tab.status = "running";
			// 新一轮回答开始即恢复：清掉上次 error 的 lastError（如 auto_retry_end 失败后重新触发）。
			delete runtime.tab.lastError;
			runtime.transcript.activeAssistantMessageId = undefined;
			runtime.transcript.toolMessageIds.clear();
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
			if (!runtime.run.recentlyAborted) {
				// pi 在等待指数退避期间可能短暂结束一轮 agent run；桌面端保持 running，
				// 让用户明确知道当前不是最终失败，而是在等待下一次自动重试。
				runtime.tab.status = "running";
				// 自动重试开始即恢复：清掉上次 error 的 lastError。
				delete runtime.tab.lastError;
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
			if (!typed.success && !runtime.run.recentlyAborted) {
				runtime.tab.status = "error";
				const reason = typed.finalError ?? typed.errorMessage ?? "API 请求失败";
				const failureText = `请求失败：${String(reason)}`;
				runtime.tab.lastError = failureText;
				this.addMessage(runtime, "error", failureText);
				this.emitState();
			}
		}

		// 自动/手动压缩事件（pi 发 compaction_start/end，omp 发 auto_compaction_start/end），
		// 用于记录压缩耗时和结果，便于排查压缩性能问题。
		if (typed.type === "compaction_start" || typed.type === "auto_compaction_start") {
			runtime.rpcCompacting = true;
			// 用户已主动中止或出错时不重新激活 running 状态
			if (!runtime.run.recentlyAborted && runtime.tab.status !== "error") {
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
			if (!runtime.run.recentlyAborted && runtime.tab.status !== "error") {
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
			runtime.transcript.activeAssistantMessageId = undefined;
			runtime.transcript.toolMessageIds.clear();
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
				if (errorMsg && runtime.transcript.retryStatusMessageId === undefined) {
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
				if (!runtime.run.recentlyAborted) {
					runtime.tab.status = "running";
					// 进入自动重试即恢复：清掉上次 error 的 lastError。
					delete runtime.tab.lastError;
				}
			} else if (errorMsg) {
				this.addDetailedErrorMessage(runtime, String(errorMsg));
				// 有错误且不会重试 → Agent 进入 error 态，宠物聚合为 failed（行5），
				// 否则会被误置为 idle 触发"所有任务完成"通知
				runtime.tab.status = "error";
				runtime.tab.lastError = String(errorMsg);
			} else if (
				typed.stopReason === "error" ||
				errorMessages.length > 0
			) {
				this.addDetailedErrorMessage(runtime, "Agent 返回未知错误，请重试");
				runtime.tab.status = "error";
				runtime.tab.lastError = "Agent 返回未知错误，请重试";
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
			const settledAfterAbort = runtime.run.recentlyAborted;
			this.noteAgentAbortSettled(runtime);
			runtime.run.recentlyAborted = false;
			if (runtime.settleCheckTimer) {
				clearTimeout(runtime.settleCheckTimer);
				runtime.settleCheckTimer = undefined;
			}
			// 事件路径：agent_settled 到达即无条件收口 idle（reason 'event'）。
			// 转移判定仍走同一决策器（settledAt 分支），便于单点维护事件路径语义。
			const settleDecision = resolveSettle({ isStreaming: undefined, now: Date.now(), settledAt: Date.now() });
			if (
				settleDecision.decision === "idle" &&
				runtime.tab.status !== "error" &&
				runtime.tab.status !== "closed"
			) {
				// agent_settled 是 Pi 的最终稳定点：没有自动重试、自动压缩、压缩 retry
				// 或 queued follow-up 会继续执行，此时才允许恢复 idle 并通知用户完成。
				// 语义事件：仅当本次把 busy 状态收口为 idle 时发 settled——若 omp 兜底
				// （markIdleIfPiReportsNoWork）已先置 idle，此处幂等跳过，避免重复通知。
				const settledFromBusy =
					runtime.tab.status === "running" || runtime.tab.status === "starting";
				runtime.tab.status = "idle";
				// 清转录运行态，但**不动闸门**：gate 由上面的 noteAgentAbortSettled 管理，
				// 按设计要一直封印到下一轮 agent_start，否则 settled 与 start 之间的残留
				// delta 会被放行，重新长出已被中止的气泡（abortStreamRegression 的原始问题）。
				resetTranscriptRun(runtime.transcript);
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

				const messages = runtime.transcript.messages;
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
			if (runtime.transcript.activeAssistantMessageId !== undefined) {
				this.upsertAssistantMessage(runtime, typed.message);
				runtime.transcript.activeAssistantMessageId = undefined;
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
		const messages = runtime.transcript.messages;
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
	 * 启动 pi 前完成项目信任确认（决策矩阵收敛于 TrustStore.decide——探测/存储/
	 * 编排全部模块化，本类只供弹窗适配器：requestId 注册表 + 60s/headless 拒绝，
	 * 见 requestProjectTrust）。返回需传给 pi 的信任覆盖指令：
	 * "approve"（trust-session 本次覆盖，不落盘）| "no-approve"（deny 不信任模式
	 * 启动）| undefined（放行：已信任/remember 已落盘/干净项目自动信任）。
	 */
	private async ensureProjectTrust(project: Project): Promise<"approve" | "no-approve" | undefined> {
		const cwd = this.wslEnvironment
			? toWslLinuxPath(project.path, this.wslEnvironment)
			: project.path;
		const hostCwd = this.wslEnvironment
			? toWindowsHostPath(project.path, this.wslEnvironment)
			: project.path;
		const trustStore = this.config.trustStore;
		void this.appLogger?.info("agent", "Agent trust decision start", { cwd });
		const result = await trustStore.decide({
			cwd,
			hostCwd,
			projectName: project.name,
			windowsHome: this.wslEnvironment?.windowsHome,
			ask: async () => this.requestProjectTrust(cwd, project.name),
		});
		void this.appLogger?.info("agent", "Agent trust decision completed", { cwd, result });
		return result;
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
			const delta = String(assistantEvent.delta ?? "");
			// 只拼接一次、strip 一次；upsertAssistantMessage 的增量模式不会再全量
			// 提取 content，避免同一段思考文本被反复整段扫描。
			const nextThinking = appendThinkingDelta(runtime.transcript, delta, Date.now());
			this.thinkingEmitter.push(runtime.tab.id, stripAnsi(nextThinking));
			this.upsertAssistantMessage(runtime, partialMessage, "", true);
			return;
		}

		if (eventType === "thinking_end") {
			const finalThinking = endThinking(runtime.transcript, assistantEvent.content, Date.now());
			if (finalThinking) {
				this.thinkingEmitter.push(runtime.tab.id, stripAnsi(finalThinking));
				this.thinkingEmitter.flush(runtime.tab.id);
			}
			this.upsertAssistantMessage(runtime, partialMessage);
			// 一段思考结束：清空累积缓冲。否则工具调用后第二段思考的
			// thinking_delta 会追加到本段完整文本之后，造成内容重复。
			clearThinkingBuffer(runtime.transcript);
			// thinking_end 是阶段性终态，立即 flush 让思考块完整落盘显示。
			this.flushMessageEmit(runtime);
			return;
		}

		if (eventType === "message_end" || eventType === "done" || eventType === "error") {
			this.upsertAssistantMessage(runtime, partialMessage);
			// message_end/done/error 是本轮回答的最终状态，立即 flush 确保完整消息及时可见。
			this.flushMessageEmit(runtime);
			runtime.transcript.activeAssistantMessageId = undefined;
		}
	}

	private beginAssistantMessage(runtime: AgentRuntime) {
		beginAssistantMessage(runtime.transcript);
	}

	private upsertAssistantMessage(
		runtime: AgentRuntime,
		partialMessage?: unknown,
		fallbackDelta = "",
		incremental = false,
	) {
		const { clearedThinking } = upsertAssistantMessage(runtime.transcript, {
			agentId: runtime.tab.id,
			partialMessage,
			fallbackDelta,
			incremental,
			now: Date.now(),
		});
		if (clearedThinking) {
			runtime.transcript.streamingThinking = "";
			this.emitThinking(runtime.tab.id, "");
		}

		// upsertAssistantMessage 被 text_delta/thinking_delta 高频调用，走节流合并；
		// message_end/thinking_end 等终态调用方会在调用后显式 flush，保证最终状态及时。
		this.scheduleMessageEmit(runtime);
	}

	/**
	 * upsert 一条工具消息（按 toolCallId 合并 start/end）。详细规则见 agentTranscript.upsertToolMessage。
	 */
	private upsertToolMessage(
		runtime: AgentRuntime,
		event: Record<string, any>,
		status: "running" | "done" | "error",
	) {
		upsertToolMessage(runtime.transcript, {
			agentId: runtime.tab.id,
			event,
			status,
			abortedDuringAsk: runtime.run.abortedDuringAsk,
			now: Date.now(),
		});
		this.scheduleMessageEmit(runtime);
	}

	private addMessage(
		runtime: AgentRuntime,
		role: ChatMessage["role"],
		text: string,
		meta?: Record<string, unknown>,
		images?: ImageContent[],
	) {
		const message = appendTranscriptMessage(runtime.transcript, {
			agentId: runtime.tab.id,
			role,
			text,
			meta,
			images,
			now: Date.now(),
		});
		if (role === "user" || role === "assistant") this.refreshAutoTitle(runtime);
		this.scheduleMessageEmit(runtime, true);
		// 语义事件：消息追加在统一写入点汇聚发出（而非散落在各调用处），
		// 保证订阅者拿到的 message 与 runtime.transcript.messages 中实际落库的对象完全同构。
		this.notifyEventListeners({ type: "messageAppended", agentId: runtime.tab.id, message });
	}

	private refreshAutoTitle(runtime: AgentRuntime) {
		const project = this.getProject(runtime.tab.projectId);
		if (!project) return false;
		if (!this.isDefaultAgentTitle(runtime.tab.title, project)) return false;
		const nextTitle = this.inferTitleFromMessages(runtime.transcript.messages);
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
		const retryMessageId = runtime.transcript.retryStatusMessageId;
		const retryMessage = retryMessageId
			? runtime.transcript.messages.find((message) => message.id === retryMessageId)
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
		const list = runtime.transcript.messages;
		let messageId = runtime.transcript.retryStatusMessageId;
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
			runtime.transcript.retryStatusMessageId = messageId;
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

			const messages = runtime.transcript.messages;
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
	 * 窗口时长收敛在 settleReducer.AGENT_SETTLED_TIMEOUT_MS。
	 */
	private scheduleSettleCheck(runtime: AgentRuntime, agentId: string) {
		clearTimeout(runtime.settleCheckTimer);
		runtime.settleCheckTimer = setTimeout(() => {
			runtime.settleCheckTimer = undefined;
			void this.markIdleIfPiReportsNoWork(agentId);
		}, AGENT_SETTLED_TIMEOUT_MS);
		runtime.settleCheckTimer.unref?.();
	}

	private async markIdleIfPiReportsNoWork(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime || runtime.tab.status !== "running") return;
		// 本地忙碌信号：命中任一即无需 RPC 查询（保持原提前返回，省一次 get_state）。
		const local = this.localWorkSignals(runtime);
		if (hasLocalWork(local)) return;

		const response = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => undefined);
		if (!response?.success || !response.data) return;

		// 统一收口到 agentRunState.decideSettle：isStreaming 严格归一化、gate 封印（wait）、
		// 本地/远端忙碌信号与 abort 兜底截止的裁定全部在单一决策器里完成。
		// 轮询已触发（无论 100ms 扩展命令窗口还是 1200ms settle 窗口）：timeoutMs 有值即有权
		// 给出 no-work 结论。
		// get_state 的 data 走本应用自有协议：只读 4 个可选字段，逐个在决策器内归一化，
		// 因此这里按已知形态收口一次，避免在读取点散布断言。
		const remoteState = response.data as PiStateFields;
		const decision = decideSettle({
			run: runtime.run,
			local,
			remote: remoteState,
			now: Date.now(),
			timeoutMs: SETTLE_POLL_TIMEOUT_MS,
		});
		// stay-running / wait 一律不产生转移。wait 是本次语义修正点：abort 封印中
		// poll 不得越过 gate 抢先置 idle 发 settled（原实现不查 gate 会误发）。
		if (
			decision.decision === "stay-running" ||
			decision.decision === "wait"
		) return;
		if (decision.reason === "abort-fallback") {
			// 封印窗口已超时（兜底定时器已/即将解封）：按 settled 解封即可。
			// 不置 idle、不发 settled——abort 已把 status 置 idle，settled 通知留给
			// 真实 agent_settled 或重发后的正常收口，避免 abort 误报完成。
			this.noteAgentAbortSettled(runtime);
			return;
		}

		runtime.tab.status = "idle";
		// 运行结束：思考缓冲与时间戳一并清空（与 abort/agent_end 共用同一清态语义）。
		clearThinkingBuffer(runtime.transcript);
		runtime.transcript.thinkingStartedAt = undefined;
		runtime.transcript.thinkingEndedAt = undefined;
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

	/** agent_start 时尝试推进 generation；若仍在等 abort settled，则只记 pending。 */
	private openAgentStream(runtime: AgentRuntime) {
		runtime.run.streamGate = openStreamGateForNewRun(runtime.run.streamGate);
	}

	/** abort 后的 agent_settled：结束 waiting，必要时解封 pending start。 */
	private noteAgentAbortSettled(runtime: AgentRuntime) {
		this.clearAbortSettledFallback(runtime);
		noteRunAbortSettled(runtime.run);
	}

	/** 本地忙碌信号（不需要 RPC 就能判定的部分），供 settle 决策器统一组装。 */
	private localWorkSignals(runtime: AgentRuntime): LocalWorkSignals {
		return {
			hasPendingUiRequest: runtime.pendingUIRequests.size > 0,
			compacting: runtime.rpcCompacting || runtime.compacting,
			hasActiveAssistant: runtime.transcript.activeAssistantMessageId !== undefined,
			toolExecuting: runtime.toolExecuting,
		};
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
			if (current.run.streamGate.waitingForAbortSettled) {
				// 定时器触发即兜底截止已到：经决策器判定为 abort 兜底解封才生效，
				// 与 markIdleIfPiReportsNoWork 共用同一判定。
				const decision = decideSettle({
					run: current.run,
					local: this.localWorkSignals(current),
					now: Date.now(),
				});
				if (decision.decision === "idle" && decision.reason === "abort-fallback") {
					noteRunAbortSettled(current.run);
				}
			}
		}, ABORT_SETTLED_FALLBACK_MS);
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
		return isRunSealed(runtime.run);
	}

	/** agent 关闭/重建时清理 gate，避免泄漏到新生命周期。 */
	private clearStreamGate(runtime: AgentRuntime) {
		this.clearAbortSettledFallback(runtime);
		closeAgentRun(runtime.run, runtime.transcript);
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
		if (runtime.transcript.pendingMessage) return;
		runtime.transcript.pendingMessage = true;
		const timer = setTimeout(() => this.flushMessageEmit(runtime), AgentManager.MESSAGE_FLUSH_INTERVAL_MS);
		// 节流定时器不应阻止进程退出
		timer.unref?.();
		runtime.transcript.messageFlushTimer = timer;
	}

	/** 记录消息数组自上次 flush 以来的最早变更下标，增量推送据此计算 replaceFrom。 */
	private markMessagesDirty(runtime: AgentRuntime, fromIndex: number): void {
		markDirtyFrom(runtime.transcript, fromIndex);
	}

	/** 记录某条消息被就地变更（按引用定位下标，避免各调用方自己维护 index）。 */
	private markMessageDirty(runtime: AgentRuntime, message: ChatMessage | undefined): void {
		markMessageDirty(runtime.transcript, message);
	}

	/** 整组消息被重建（历史加载/重启替换），下一次 flush 必须全量推送基线。 */
	private markAllMessagesDirty(runtime: AgentRuntime): void {
		markAllMessagesDirty(runtime.transcript);
	}

	/** 取消尚未 flush 的消息推送，abort 时避免旧数组晚到覆盖 UI。 */
	private cancelMessageEmit(runtime: AgentRuntime) {
		const timer = runtime.transcript.messageFlushTimer;
		if (timer) {
			clearTimeout(timer);
			runtime.transcript.messageFlushTimer = undefined;
		}
		runtime.transcript.pendingMessage = false;
	}

	private flushMessageEmit(runtime: AgentRuntime) {
		const timer = runtime.transcript.messageFlushTimer;
		if (timer) {
			clearTimeout(timer);
			runtime.transcript.messageFlushTimer = undefined;
		}
		runtime.transcript.pendingMessage = false;
		// 增量推送：只传输自上次 flush 起变更的部分。replaceFrom === 0 时是
		// 全量基线（渲染层 slice(0,0) 合并即整体替换），其余情况为尾部增量。
		const { replaceFrom, messages } = takeDirtySlice(runtime.transcript);
		const t0 = perfStart("agents:message-flush");
		this.emit(ipcChannels.agentsMessage, {
			agentId: runtime.tab.id,
			replaceFrom,
			messages,
		});
		perfEnd("agents:message-flush", t0, {
			agentId: runtime.tab.id,
			replaceFrom,
			sent: messages.length,
			total: runtime.transcript.messages.length,
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

	/** 会话转录：消息时间线 + 流式思考 + 增量推送统计（见 agentTranscript.ts）。 */
	transcript: AgentTranscriptState;
	/** 运行态：abort 闸门 + settle 判定输入（见 agentRunState.ts）。 */
	run: AgentRunState;

	// 工具运行态
	toolStateSequence: number;
	/** toolCallId -> toolName，并行工具等最后一个结束才发 false 边沿 */
	activeToolCalls: Map<string, string>;
	toolExecuting: string | null;
	/** 完整运行态推送的单调序号：渲染层据此丢弃乱序到达的旧快照（长任务后 RPC 慢更容易乱序）。 */
	runtimeStateSeq: number;

	/** 工具退出后的兜底定时器（agent_end/压缩结束后调度，见 scheduleSettleCheck） */
	settleCheckTimer?: NodeJS.Timeout;
	/** abort 后等 pi 确认的兜底定时器（见 scheduleAbortSettledFallback） */
	abortSettledFallbackTimer?: NodeJS.Timeout;

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
};

/** 创建一个带有全部 per-agent 状态默认值的 AgentRuntime。 */
function createAgentRuntime(tab: AgentTab, process: PiProcess): AgentRuntime {
	return {
		tab,
		process,
		transcript: createTranscriptState(),
		run: createRunState(),
		toolStateSequence: 0,
		activeToolCalls: new Map(),
		toolExecuting: null,
		pendingUIRequests: new Map(),
		rpcLogging: false,
		compacting: false,
		rpcCompacting: false,
		runtimeStateSeq: 0,
		modelRefreshing: false,
		userInitiatedStop: false,
		autoRestartAttempted: false,
	};
}
