/**
 * Agent settle 转移的纯函数判定器（"is the agent done"）。
 *
 * 从 AgentManager.ts 四条重叠的 settle 路径中提炼出的单一决策入口：
 * 1. agent_settled 事件（旧 pi 的最终稳定点，事件到达即无条件收口 idle）—— reason: 'event'
 * 2. scheduleSettleCheck / markIdleIfPiReportsNoWork（omp 兜底轮询：延迟后 get_state
 *    校验 isStreaming/isCompacting/pendingMessageCount 确认无后续工作）—— reason: 'poll' | 'no-work'
 * 3. ABORT_SETTLED_FALLBACK_MS 兜底（abort 后等待 settled 的超时解封 stream gate）—— reason: 'abort-fallback' | 'wait'
 * 4. ensureAgentIdle 复核（编辑/删除前的 busy 守卫，isStreaming/isCompacting/isExecutingTool）—— 复用 'poll' 语义
 *
 * 两条调用方约定（对应原实现里的 status 守卫，本函数只判定转移本身）：
 * - 事件路径原实现要求 tab.status 非 error/closed 才收口 idle：调用方拿到 'idle' 后自行施加
 *   error/closed 守卫，避免把失败态误收口成 idle（宠物聚合会误报完成）。
 * - markIdleIfPiReportsNoWork 原实现要求 status === 'running' 才会触发轮询：调用方应只在
 *   status 为 running 时调用本函数，否则是 no-op（保持现状，不产生转移）。
 */

/**
 * pi get_state 布尔字段的严格归一化（全仓库唯一实现）。
 * omp 可能以字符串形式返回布尔字段（"true"/"false" 均为 truthy），宽松判定会让空闲检查
 * 永远无法通过、UI 停在 running/三点指示器不消失；故只有严格 `=== true` 才算真，
 * 字符串/undefined/其它 truthy 非布尔一律归 false。
 * - 本 reducer 用它归一化 isStreaming（内部 settle 判定）；
 * - getRuntimeState 用它归一化 isStreaming/isCompacting（对外 API 输出，语义相同）。
 */
export function normalizePiBoolean(value: unknown): boolean {
	return value === true;
}

/** omp 无 agent_settled 事件时的 settle-check 窗口：agent_end / 自动压缩结束后延迟多久再 poll。 */
export const AGENT_SETTLED_TIMEOUT_MS = 1200;
/** abort settled 兜底超时：覆盖多数管道残留，同时不让"立刻重发"永久卡死。 */
export const ABORT_SETTLED_FALLBACK_MS = 1500;

export type SettleReason = "event" | "poll" | "abort-fallback" | "no-work";

export type SettleDecision =
	| { decision: "stay-running"; reason: "poll"; normalizedIsStreaming: boolean }
	| {
			decision: "idle";
			reason: "event" | "abort-fallback" | "no-work";
			normalizedIsStreaming: boolean;
	  }
	| { decision: "wait"; reason: "abort-fallback"; normalizedIsStreaming: boolean };

export type ResolveSettleInput = {
	/**
	 * get_state RPC 返回的原始 isStreaming 字段（可能是布尔、字符串 "true"/"false" 或 undefined）。
	 * 经 normalizePiBoolean（`=== true`）严格归一化——本 reducer 是内部 settle 判定的归一化所在。
	 */
	isStreaming: unknown;
	/**
	 * 仍有未决工作的聚合位：调用方把本地忙碌信号折算进来后再调用——
	 * pendingUIRequests.size > 0、rpcCompacting / compacting、
	 * activeAssistantMessageId 已设置、toolExecuting 非空、
	 * 以及 RPC 返回的 isCompacting === true / (pendingMessageCount + queuedMessageCount) > 0。
	 * 对应原实现 markIdleIfPiReportsNoWork 的提前返回条件与 ensureAgentIdle 的 isExecutingTool 判定。
	 */
	hasPendingGetState?: boolean;
	/** streamGate.waitingForAbortSettled：abort 封印后仍在等待对应的 agent_settled。 */
	gateWaitingAbort?: boolean;
	/** 当前时间戳（ms）。 */
	now: number;
	/**
	 * abort 兜底截止：abort 时刻 + ABORT_SETTLED_FALLBACK_MS。
	 * 仅在 gateWaitingAbort 为 true 时有意义；缺省表示没有在跑的 abort 兜底定时器。
	 */
	abortFallbackDeadline?: number;
	/** agent_settled 事件到达时刻；缺省表示事件尚未到达。 */
	settledAt?: number;
	/**
	 * settle-check 轮询窗口（AGENT_SETTLED_TIMEOUT_MS）。
	 * 用于双重超时博弈：settle 窗口（poll 何时该跑）与 abort 兜底截止（gate 何时解封）
	 * 相互独立、互不替代——gate 封印期间 poll 不得越过 gate 抢先下结论。
	 * 缺省表示 settle-check 轮询未被安排（无定时器在跑），此时 poll 路径无权给出 no-work 结论。
	 */
	timeoutMs?: number;
};

/**
 * 判定 agent 的 settle 转移。
 *
 * 优先级（与原实现的事件/定时器相互清理顺序一致）：
 * 1. agent_settled 事件已到 → 无条件 idle（'event'）：事件路径会先清掉 settle 定时器并
 *    解封 gate，其它机制无需再参与。
 * 2. abort 封印中（gateWaitingAbort）→ deadline 已过则 idle（'abort-fallback'，
 *    对应 noteAbortSettled 解封）；未到则 'wait'——即使 poll 显示无工作也不得收口，
 *    否则 settled 前残留的 delta 会从已解封的/未封印的 generation 泄漏（原实现
 *    markIdleIfPiReportsNoWork 不查 gate，abort 后它可能抢先置 idle 并误发 settled，
 *    这是本函数统一收口的语义修正点）。
 * 3. 常规 poll 路径：hasPendingGetState 为 true（本地忙碌信号 / 排队消息）或
 *    normalizedIsStreaming 为 true（远端仍在流式）→ 保持 running（'poll'）；
 *    且 settle-check 轮询必须已安排（timeoutMs 有值），否则无 poll 结论可言。
 * 4. 其余情况 → 无工作，收口 idle（'no-work'，对应 markIdleIfPiReportsNoWork 置 idle
 *    并通知 settled）。
 */
export function resolveSettle(
	input: ResolveSettleInput,
): SettleDecision {
	// 严格布尔归一化（全仓库唯一实现 normalizePiBoolean）：
	// omp 的 get_state 布尔字段可能以字符串返回（"false" 是 truthy），宽松判定会让空闲检查
	// 永远无法通过、UI 停在 running。原实现此归一化散落在两处（getRuntimeState 的
	// `state?.isStreaming === true` 与 markIdleIfPiReportsNoWork 的 `state.isStreaming === true`），
	// 两处各自为政是历史包袱，这里收敛为一次，调用方复用 normalizedIsStreaming。
	const normalizedIsStreaming = normalizePiBoolean(input.isStreaming);

	// 1) 事件路径：agent_settled 是旧 pi 的最终稳定点（无自动重试/压缩/queued follow-up 会继续）。
	if (input.settledAt !== undefined) {
		return { decision: "idle", reason: "event", normalizedIsStreaming };
	}

	// 2) abort 封印中：gate 未解封前一切按"等待"处理。
	if (input.gateWaitingAbort === true) {
		if (
			input.abortFallbackDeadline !== undefined &&
			input.now >= input.abortFallbackDeadline
		) {
			return {
				decision: "idle",
				reason: "abort-fallback",
				normalizedIsStreaming,
			};
		}
		return { decision: "wait", reason: "abort-fallback", normalizedIsStreaming };
	}

	// 3) poll 路径：settle-check 轮询未安排 → 无权给出 no-work 结论。
	if (input.timeoutMs === undefined) {
		return { decision: "stay-running", reason: "poll", normalizedIsStreaming };
	}

	if (input.hasPendingGetState === true || normalizedIsStreaming) {
		return { decision: "stay-running", reason: "poll", normalizedIsStreaming };
	}

	// 4) 本地与远端均无忙碌信号 → 无工作可做，收口 idle。
	return { decision: "idle", reason: "no-work", normalizedIsStreaming };
}