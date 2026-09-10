import {
	ABORT_SETTLED_FALLBACK_MS,
	AGENT_SETTLED_TIMEOUT_MS,
	normalizePiBoolean,
	resolveSettle,
	type SettleDecision,
} from "./settleReducer";
import {
	createStreamGateState,
	isStreamGateSealed,
	noteAbortSettled,
	sealStreamGate,
	type StreamGateState,
} from "./streamGate";
import { resetTranscriptRun, type AgentTranscriptState } from "./agentTranscript";

/**
 * 单 agent 的运行态（AgentRunState）——abort 闸门、settle/空闲判定与运行结束清态。
 *
 * 设计动机（deep module）：
 *   - settleReducer 只承载纯决策表，输入组装与转移后的效果原先散在 4 个调用点，
 *     每处各写一套「忙碌信号并集」：markIdleIfPiReportsNoWork 查本地 4 个信号 +
 *     远端 get_state，ensureAgentIdle 用 timeoutMs:0 加裸 isCompacting 再单独查一次
 *     工具执行，agent_settled 分支只传 settledAt 后自己重写转移，abort 兜底定时器
 *     又维护一份 deadline。四份输入 = 四种口径。
 *   - 运行结束的「清态」原本在 abort / agent_start / agent_end / agent_settled /
 *     markIdle 五处各复制一遍（清思考、清 activeAssistant、清 toolMessageIds）。
 *     漏改一处就会出现上一轮的思考块挂到下一轮。
 *   - 本模块把「输入从哪来、什么算忙碌、何时可判空闲、结束时要清什么」收进一处；
 *     副作用（置 idle、发事件、IPC）仍由 AgentManager 施加，模块只做判定与状态迁移。
 *
 * 边界：定时器由调用方持有（scheduleAbortFallback / scheduleSettleCheck 仍在
 * AgentManager，因为它们的回调要触发副作用），模块只维护 deadline 与闸门语义。
 */

/** pi get_state 返回的忙碌相关字段（新旧字段名并存；形态不可信，读取时逐个归一化）。 */
export type PiStateFields = {
	isStreaming?: unknown;
	isCompacting?: unknown;
	pendingMessageCount?: unknown;
	queuedMessageCount?: unknown;
};

/** 本地忙碌信号：不需要 RPC 就能判定的部分。 */
export type LocalWorkSignals = {
	/** 有等待回答的扩展 UI 请求（agent 正阻塞在 ask 上）。 */
	hasPendingUiRequest: boolean;
	/** 手动压缩或 pi 报告的自动压缩进行中。 */
	compacting: boolean;
	/** 有正在流式更新的 assistant 消息。 */
	hasActiveAssistant: boolean;
	/** 正在执行的工具名（null = 无）。 */
	toolExecuting: string | null;
};

export type AgentRunState = {
	/** abort 流式闸门（按 generation 封印残留 delta）。 */
	streamGate: StreamGateState;
	/** 最近一次 abort 的时刻（ms）：+ ABORT_SETTLED_FALLBACK_MS 即 settleReducer 的 abortFallbackDeadline。 */
	abortSettledAt?: number;
	/** 用户主动 abort 后等待 pi 确认：抑制 auto-retry / 压缩状态回写。 */
	recentlyAborted: boolean;
	/** abort 时正等待 ask_question 响应，工具结果中覆写 answer 为 null。 */
	abortedDuringAsk: boolean;
};

export function createRunState(): AgentRunState {
	return {
		streamGate: createStreamGateState(),
		recentlyAborted: false,
		abortedDuringAsk: false,
	};
}

/**
 * 本地忙碌信号是否已足以判定「不空闲」。
 * 命中任一即可跳过 get_state：省一次 RPC，也避免把正在阻塞的 agent 误判为空闲。
 */
export function hasLocalWork(signals: LocalWorkSignals): boolean {
	return (
		signals.hasPendingUiRequest ||
		signals.compacting ||
		signals.hasActiveAssistant ||
		signals.toolExecuting !== null
	);
}

/**
 * pi get_state 的计数字段归一化：非有限数字一律视为 0。
 * 直接用 `value ?? 0` 会把字符串（如 "1"）与 0 相加成 "10" —— 真值恒真，
 * 空闲检查再也无法通过，UI 永远停在 running（与布尔字段同样的形态坑）。
 */
export function normalizeCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 统一组装 settle 输入并交给决策表。
 *
 * 这是本模块存在的核心理由：忙碌信号的口径只能有一份。远端字段的归一化
 * （omp/pi 布尔形态、queuedMessageCount 与 pendingMessageCount 并存）也在此收口。
 */
export function decideSettle(input: {
	run: AgentRunState;
	local: LocalWorkSignals;
	remote?: PiStateFields;
	/** 已确认无本地工作、且轮询窗口已到时给出。无值表示调用方不授权 no-work 结论。 */
	timeoutMs?: number;
	now: number;
}): SettleDecision {
	const remote = input.remote;
	const queued = remote ? normalizeCount(remote.pendingMessageCount) + normalizeCount(remote.queuedMessageCount) : 0;
	return resolveSettle({
		isStreaming: remote?.isStreaming,
		hasPendingGetState:
			hasLocalWork(input.local) ||
			(remote ? normalizePiBoolean(remote.isCompacting) || queued > 0 : false),
		gateWaitingAbort: input.run.streamGate.waitingForAbortSettled,
		now: input.now,
		abortFallbackDeadline: abortFallbackDeadline(input.run),
		timeoutMs: input.timeoutMs,
	});
}

/** 默认 settle 轮询窗口（与 scheduleSettleCheck 一致）。 */
export const SETTLE_POLL_TIMEOUT_MS = AGENT_SETTLED_TIMEOUT_MS;

/** abort 后的 agent_settled：结束 waiting，必要时解封 pending start。 */
export function noteRunAbortSettled(run: AgentRunState): void {
	run.abortSettledAt = undefined;
	run.streamGate = noteAbortSettled(run.streamGate);
}

/** abort 兜底定时器的截止时刻（abort 时刻 + 兜底窗口）；无 abort 记录时 undefined。 */
export function abortFallbackDeadline(run: AgentRunState): number | undefined {
	return run.abortSettledAt !== undefined ? run.abortSettledAt + ABORT_SETTLED_FALLBACK_MS : undefined;
}

/** abort 时封印当前 generation，并记录时刻供兜底判定。 */
export function sealRun(run: AgentRunState, now: number): void {
	run.streamGate = sealStreamGate(run.streamGate);
	run.abortSettledAt = now;
	run.recentlyAborted = true;
}

/**
 * 当前 generation 是否已封印：封印期间所有流式事件应丢弃。
 * 解封条件由 streamGate 决定（须先见到 abort 后的 settled，再收到新的 agent_start），
 * 因此这里只做转发，不提供「强制解封」入口。
 */
export function isRunSealed(run: AgentRunState): boolean {
	return isStreamGateSealed(run.streamGate);
}

/** 运行结束的统一清态：闸门重置 + abort 标记清空 + 转录运行态清空。
 * abort / agent_start / agent_end / agent_settled / 置 idle 五条路径共用。
 */
export function closeRun(run: AgentRunState, transcript: AgentTranscriptState): void {
	run.streamGate = createStreamGateState();
	run.abortSettledAt = undefined;
	run.recentlyAborted = false;
	run.abortedDuringAsk = false;
	resetTranscriptRun(transcript);
}
