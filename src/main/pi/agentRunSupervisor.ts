import type { AgentStatus } from "../../shared/types";
import type { AgentTranscriptState } from "./agentTranscript";
import {
	decideSettle,
	hasLocalWork,
	localWorkSignalsOf,
	normalizeCount,
	RUN_SILENCE_FORCE_IDLE_MS,
	SETTLE_POLL_TIMEOUT_MS,
	type AgentRunState,
	type PiStateFields,
} from "./agentRunState";
import { ABORT_SETTLED_FALLBACK_MS, AGENT_SETTLED_TIMEOUT_MS } from "./settleReducer";

/**
 * 单 agent 的「运行静默监督器」——per-run 定时器与事件流活性判定的唯一属主。
 *
 * 设计动机（deep module / locality）：
 *   settle 轮询定时器、abort 兜底定时器、空响应窗口、会话结束通知，此前是四份
 *   `Map<agentId, Timeout>` / runtime 字段 + 15 个 AgentManager 私有方法。要回答
 *   「这个 agent 还会不会自己回到 idle」必须同时读懂：settle 轮询怎么自我重排、
 *   静默兜底用什么窗口、abort 封印期间谁有权抢先收口、结束通知为何要再等两轮。
 *   这些知识互相纠缠（轮询要问兜底、兜底要问重试卡片、通知要问静默戳），却和
 *   AgentManager 的转录/事件/通知副作用写在同一层，任何时序调整都要重读 5000 行。
 *
 *   本模块把这些知识收进一个窄接口后面：外部只按领域事件通知它（run 开始/结束、
 *   收到 pi 事件、abort 已封印/已 settle），它自己决定何时查、何时收口、何时弹通知。
 *   定时器与活性戳没有任何外部读写点（原实现里测试要伸手进 `emptyResponseTimers`
 *   才能断言「定时器还在」，正是浅模块的症状）。
 *
 * 边界（seam）：
 *   - 判定与计时在这里；副作用经 effects 交回 AgentManager——写状态用视图的
 *     `status`（唯一可写字段），清转录/发事件/弹通知/落日志都在 effects 里。
 *   - get_state RPC 本身留在 AgentManager（effects.requestState），本模块不持有进程。
 *   - 窗口时长由构造参数注入（空响应窗口、结束通知窗口），测试可缩短而不改语义；
 *     调度器可注入，使单测完全脱离真实时钟与 Electron。
 *
 * 不变量（与抽离前逐条对应）：
 *   - 5s/30s/1200ms/1500ms/2.5s 窗口不变，abort 封印期间轮询不得越过 gate 抢先 idle；
 *   - 落定 idle 只由 `finishAsIdle` 施加一次（no-double-settled 竞态守卫在调用前复查 status）；
 *   - settle 观察与扩展命令复查各占一个定时器槽位：短复查不得顶掉已排队的 settle 链；
 *   - 结束通知在仍忙时自我重排、并按最后一次工作事件补足静默窗口；
 *   - dispose 清掉全部五个定时器，退役后没有任何回调能打到已摘除的 runtime。
 */

/** 监督器读取的运行态视图：只读，唯一可写字段是 status（收口 idle / 空响应落 error）。 */
export type AgentRunSupervisorView = {
	readonly agentId: string;
	/** 可由本模块改写：收口 idle、空响应落 error。 */
	status: AgentStatus;
	readonly run: AgentRunState;
	readonly transcript: AgentTranscriptState;
	readonly pendingUIRequests: ReadonlyMap<string, unknown>;
	readonly activeToolCalls: ReadonlyMap<string, unknown>;
	readonly toolExecuting: string | null;
	readonly compacting: boolean;
	readonly rpcCompacting: boolean;
};

/** get_state 响应（字段形态不可信，判定器内逐个归一化）。 */
export type SupervisorStateResponse = { success?: boolean; data?: unknown };

/**
 * 副作用出口：本模块只做判定与计时，动转录/事件/通知/日志的活都在 AgentManager。
 * 这是薄适配层（adapter），不是第二个决策点。
 */
export type AgentRunSupervisorEffects = {
	/** get_state 轮询；失败由本模块按「未能确认」处理。 */
	requestState(): Promise<SupervisorStateResponse>;
	/** 运行收口：清转录运行态/工具残留/压缩标志并广播 settled（status 已由本模块置 idle）。 */
	finishAsIdle(): void;
	/** abort 对应的 settled：结束 gate 等待（agentRunState.noteRunAbortSettled）。 */
	abortSettled(): void;
	/** 空响应落 error：写 lastError、追加错误卡片、记录日志并广播。 */
	emptyResponse(timeoutMs: number): void;
	/** 弹「已完成响应」系统通知。 */
	notifyFinished(): void;
	/** 设置项开关（settingsStore 读取，失败按关闭处理）。 */
	notificationsEnabled(): boolean;
	/** 应用日志；level 只区分 warn/info，scope 由适配器决定。 */
	log(level: "info" | "warn", message: string, detail?: Record<string, unknown>): void;
};

/**
 * 定时器调度缝：默认用全局 setTimeout（unref，避免兜底定时器吊住进程）。
 * 测试注入受控调度器即可在假时钟上断言「窗口到点前不触发、到点只触发一次」。
 */
export type AgentRunSupervisorScheduler = {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type AgentRunSupervisorOptions = {
	/** 空响应兜底窗口（默认 30s，测试注入更小值）。 */
	emptyResponseTimeoutMs: number;
	/** 会话结束通知的静默窗口（2.5s）。 */
	notifyDelayMs: number;
	scheduler?: AgentRunSupervisorScheduler;
};

const defaultScheduler: AgentRunSupervisorScheduler = {
	setTimeout(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		(timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
		return timer;
	},
	clearTimeout(handle) {
		clearTimeout(handle as NodeJS.Timeout);
	},
};

export class AgentRunSupervisor {
	/**
	 * settle 轮询（1200ms 窗口）：pi 在 settled 事件之前「其实是 idle」时的兜底观察。
	 * 与下面的 `idleProbe` 分开两个槽位——合成一个的话，扩展命令的 100ms 复查会把
	 * 已在等待的 settle 观察顶掉，run 可能再无观察者而停在 running。
	 */
	private settleCheck?: unknown;
	/** 扩展命令后的 100ms 即时空闲复查（短窗口，用完即弃，不参与 settle 重排链）。 */
	private idleProbe?: unknown;
	/** abort 后等 pi 确认的兜底（abort 封印时布防，settle 或兜底到点时撤除）。 */
	private abortFallback?: unknown;
	/** 空响应窗口（prompt 被接收后布防，任何流式生命信号到达即撤除）。 */
	private emptyResponse?: unknown;
	/** 会话结束通知窗口（settled 后布防，新一轮 run 开始即撤销）。 */
	private notify?: unknown;

	/**
	 * 事件流活性戳。只由 noteEvent 刷新——get_state 是我们主动发的请求，
	 * 其响应不算事件流活性，否则静默兜底永远等不到窗口。
	 */
	private lastPiEventAt?: number;
	/** 用户可感知的工作事件（标题等元数据不刷新），结束通知据此补足静默窗口。 */
	private lastWorkEventAt?: number;

	/**
	 * 退役标记：dispose 之后不得再布防任何定时器，也不得再改写已摘除 runtime 的状态。
	 * 退役瞬间可能有一次 pollIdleOnce 正在 await get_state；原实现靠回调里重新查
	 * agents Map 自愈，收进本模块后必须用标记拦住，否则它会重排成永动的 1.2s 轮询。
	 */
	private disposed = false;

	private readonly scheduler: AgentRunSupervisorScheduler;

	constructor(
		private readonly view: AgentRunSupervisorView,
		private readonly effects: AgentRunSupervisorEffects,
		private readonly options: AgentRunSupervisorOptions,
	) {
		this.scheduler = options.scheduler ?? defaultScheduler;
	}

	// ── 事件流时间戳 ─────────────────────────────────

	/**
	 * 记录一次事件流活性。
	 * "pi"：任意事件（含被 gate 丢弃的 delta）都证明 pi 还活着，静默窗口从头计算；
	 * "work"：用户可感知的工作事件（消息/工具/压缩/UI 请求），会话结束通知只看它——
	 * 标题更新这类元数据若也刷新，"已完成"通知会被无限推迟。
	 */
	noteEvent(kind: "pi" | "work"): void {
		const now = Date.now();
		this.lastPiEventAt = now;
		if (kind === "work") this.lastWorkEventAt = now;
	}

	// ── run 生命周期 ────────────────────────────────

	/**
	 * 新一轮 run 开始（agent_start）：上一轮尚未触发的结束通知必须作废
	 * （排队消息会立刻接续，提示"已完成"是错的），空响应窗口与空闲轮询同样不再适用。
	 */
	noteRunStarted(): void {
		this.cancelSessionEndNotification();
		this.clearEmptyResponse();
		this.clearIdleChecks();
	}

	/** 一次底层 run 结束（agent_end）：空响应窗口到点即失效（此后等的是 settled/压缩）。 */
	noteRunEnded(): void {
		this.clearEmptyResponse();
	}

	// ── settle 轮询 ─────────────────────────────────

	/**
	 * 安排一次最终空闲检查（omp / 新 pi 的 settled 事件之前的兜底）。
	 * 窗口时长收敛在 settleReducer.AGENT_SETTLED_TIMEOUT_MS；pi 报忙碌且事件流静默时
	 * 轮询会自我重排（见 rearmSettleCheck），直到收口或 pi 重新产出事件。
	 */
	scheduleSettleCheck(): void {
		this.armIdleCheck("settle", AGENT_SETTLED_TIMEOUT_MS);
	}

	/**
	 * 扩展命令后的即时复查（100ms）：Pi 扩展命令在 prompt 阶段就地执行、不进入 run，
	 * 既没有 agent_start 也没有 agent_end，只能主动查一次 get_state 才敢回 idle。
	 *
	 * 它走独立槽位，不覆盖已排队的 settle 观察：扩展命令的 prompt 成功不代表这次 run
	 * 已经收口，1200ms 那条链仍是「事件流静默但 pi 报忙碌」时唯一的观察者。
	 */
	scheduleIdleCheck(delayMs: number): void {
		this.armIdleCheck("idleProbe", delayMs);
	}

	/**
	 * 查一次 get_state 并收口。这是 omp 下唯一真实的 settled 汇聚点：
	 * 判定全部交给 decideSettle（gate 封印、本地/远端忙碌、abort 兜底截止同一份口径）。
	 */
	async pollIdleOnce(): Promise<void> {
		if (this.disposed) return;
		if (this.view.status !== "running") return;
		// 本地忙碌信号命中即省一次 RPC；但不能就此放弃观察——本地信号可能陈旧，
		// 也可能 pi 早已空闲，因此重排一次等信号消失或静默兜底窗口到点。
		const local = localWorkSignalsOf(this.view);
		if (hasLocalWork(local)) {
			this.rearmSettleCheck();
			return;
		}

		const response = await this.effects.requestState().catch(() => undefined);
		// 往返期间 runtime 可能已被退役（stop/restart 调 dispose）：此时任何结论都属于
		// 已消失的 run，既不能补发 settled，也不能再排下一轮轮询。
		if (this.disposed) return;
		if (!response?.success || !response.data) {
			// RPC 失败/无数据同样是"未能确认"：重排继续观察，而不是把 run 永远挂着。
			this.rearmSettleCheck();
			return;
		}

		// 轮询已触发（100ms 扩展命令窗口或 1200ms settle 窗口）：timeoutMs 有值即有权给结论。
		const remote = response.data as PiStateFields;
		const decision = decideSettle({
			run: this.view.run,
			local,
			remote,
			now: Date.now(),
			timeoutMs: SETTLE_POLL_TIMEOUT_MS,
		});

		// wait：abort 封印中，不得越过 gate 抢先置 idle 发 settled。
		// gate 的解封由 abort 兜底定时器负责，无需重排。
		if (decision.decision === "wait") return;
		if (decision.decision === "stay-running") {
			// pi 仍报忙碌：真忙则等它推事件，标志陈旧则由静默兜底收口。
			if (!this.forceIdleOnDeadSilence(remote)) this.rearmSettleCheck();
			return;
		}
		if (decision.reason === "abort-fallback") {
			// 兜底截止已过：只按 settled 解封，不置 idle、不发 settled——abort 已把状态
			// 置 idle，完成通知留给真实 settled 或重发后的正常收口，避免 abort 误报完成。
			// 兜底定时器若尚未触发也要撤除，否则它会在 gate 已解封后再空跑一次。
			this.clearAbortFallback();
			this.effects.abortSettled();
			return;
		}
		// no-double-settled 竞态：RPC 往返期间事件路径可能已收口（idle/error）或新 run
		// 已开始，此时再收口会重复发 settled（重复"已完成"通知），放弃本次结论。
		if (this.view.status !== "running") return;
		this.finishAsIdle();
	}

	/** 再排一次空闲检查：pi 报忙碌却又不推任何事件时，必须继续观察。 */
	private rearmSettleCheck(): void {
		// 只在事件流已静默时重排：pi 仍在推事件说明 run 明显活着，重排只会白烧 RPC。
		const lastEvent = this.lastPiEventAt ?? 0;
		if (Date.now() - lastEvent < AGENT_SETTLED_TIMEOUT_MS) return;
		this.scheduleSettleCheck();
	}

	private armIdleCheck(slot: "settle" | "idleProbe", delayMs: number): void {
		if (this.disposed) return;
		this.clearCheck(slot);
		const handle = this.scheduler.setTimeout(() => {
			if (slot === "settle") this.settleCheck = undefined;
			else this.idleProbe = undefined;
			void this.pollIdleOnce();
		}, delayMs);
		if (slot === "settle") this.settleCheck = handle;
		else this.idleProbe = handle;
	}

	private clearCheck(slot: "settle" | "idleProbe"): void {
		if (slot === "settle") {
			if (this.settleCheck === undefined) return;
			this.scheduler.clearTimeout(this.settleCheck);
			this.settleCheck = undefined;
			return;
		}
		if (this.idleProbe === undefined) return;
		this.scheduler.clearTimeout(this.idleProbe);
		this.idleProbe = undefined;
	}

	/** 撤掉两条空闲观察链（settle 与扩展命令复查）。 */
	private clearIdleChecks(): void {
		this.clearCheck("settle");
		this.clearCheck("idleProbe");
	}

	/**
	 * 静默兜底：pi 报告仍有工作，但事件流已完全静默超过 RUN_SILENCE_FORCE_IDLE_MS 时，
	 * 判定忙碌标志是陈旧真值，强制收口 idle——否则三点指示器与侧边栏状态永久停在 running。
	 *
	 * 反向误判（把真实长任务当成空闲）由这些条件共同压低：
	 *  - pi 只要还在推任何事件就会刷新 lastPiEventAt，静默窗口从头计算；
	 *  - 本地忙碌信号（等待回答的扩展 UI 请求、压缩中、工具执行中）与自动重试窗口一律不收口；
	 *  - 新 run 的 agent_start 会清掉轮询定时器，run 期间的检查走不到这里。
	 * 返回 true 表示本轮已处理（强制收口或状态已被其它路径接管），调用方不再重排。
	 */
	private forceIdleOnDeadSilence(remote: PiStateFields): boolean {
		const silentMs = Date.now() - (this.lastPiEventAt ?? Date.now());
		if (silentMs < RUN_SILENCE_FORCE_IDLE_MS) return false;
		// get_state 往返期间状态可能已被事件路径接管。
		if (this.view.status !== "running") return true;
		// 本地忙碌信号以最新为准：往返期间可能刚起压缩、刚进入等待提问。
		if (hasLocalWork(localWorkSignalsOf(this.view))) return false;
		if (this.isAutoRetryPending()) return false;

		// 远端排队计数不阻止收口：pi 若真有排队的 follow-up，它会立刻开新 run 并推
		// agent_start（那时 status 变 running，本兜底自然失效）；而该计数与陈旧忙碌标志
		// 同样可能不可信，用它挡住收口等于把故障原样保留。仅作为日志证据记录。
		const queued =
			normalizeCount(remote.pendingMessageCount) + normalizeCount(remote.queuedMessageCount);
		this.effects.log("warn", "pi 静默兜底：强制收口 idle", {
			agentId: this.view.agentId,
			silentMs,
			queuedMessages: queued,
			remoteIsStreaming: remote.isStreaming,
			remoteIsCompacting: remote.isCompacting,
			remoteIsSettled: remote.isSettled,
		});
		this.finishAsIdle();
		return true;
	}

	/** 自动重试是否仍在进行（重试卡片 meta.status="running" 表示退避等待中）。 */
	private isAutoRetryPending(): boolean {
		const messageId = this.view.transcript.retryStatusMessageId;
		if (messageId === undefined) return false;
		const message = this.view.transcript.messages.find((item) => item.id === messageId);
		return message?.meta?.status === "running";
	}

	/**
	 * 收口 idle：写状态后把清态/广播交给 AgentManager。
	 * 刻意不动 stream gate：封印与解封只由 abort 与 agent_start 管理，settled 与下一个
	 * start 之间的残留 delta 必须继续被丢弃（abortStreamRegression 的原始问题）。
	 */
	private finishAsIdle(): void {
		if (this.disposed) return;
		this.view.status = "idle";
		// 收口即「跑完了」：本模块只管这一种终态，不发布 settled 的分支并不存在，
		// 因此不把它做成参数（否则下一个改动会以为有第二条路可走）。
		this.effects.finishAsIdle();
	}

	// ── abort 兜底 ──────────────────────────────────

	/**
	 * abort 已封印：布防兜底定时器。pi 偶发不发 settled 时不至于让"立刻重发"永久卡死
	 * （新一轮永远收不到流式事件）。
	 */
	noteAbortSealed(): void {
		if (this.disposed) return;
		this.clearAbortFallback();
		this.abortFallback = this.scheduler.setTimeout(() => {
			this.abortFallback = undefined;
			// 仅在仍 waiting 时生效；正常 settled 路径会先撤除本定时器。
			if (!this.view.run.streamGate.waitingForAbortSettled) return;
			// 兜底截止已到：经决策器判定为 abort 兜底解封才生效，与轮询共用同一判定。
			const decision = decideSettle({
				run: this.view.run,
				local: localWorkSignalsOf(this.view),
				now: Date.now(),
			});
			if (decision.decision === "idle" && decision.reason === "abort-fallback") {
				this.effects.abortSettled();
			}
		}, ABORT_SETTLED_FALLBACK_MS);
	}

	/** abort 对应的 settled 已到（事件或兜底）：结束 gate 等待，后续不再需要空闲轮询。 */
	noteAbortSettled(): void {
		this.clearAbortFallback();
		this.clearIdleChecks();
		this.effects.abortSettled();
	}

	private clearAbortFallback(): void {
		if (this.abortFallback === undefined) return;
		this.scheduler.clearTimeout(this.abortFallback);
		this.abortFallback = undefined;
	}

	// ── 空响应兜底 ──────────────────────────────────

	/**
	 * 空响应兜底：prompt accepted 后启动窗口倒计时，到点若 status 仍是 running
	 * 且期间没有任何流式生命信号，按上游 provider 空响应处理。
	 * 慢思考/长 thinking 都会先有 message_start(assistant) 到达，不会误判。
	 */
	scheduleEmptyResponse(): void {
		if (this.disposed) return;
		this.clearEmptyResponse();
		this.emptyResponse = this.scheduler.setTimeout(() => {
			this.emptyResponse = undefined;
			// 已收到流式生命信号但忘了 clear（防御，正常路径都 clear 了）。
			if (this.view.status !== "running") return;
			this.view.status = "error";
			this.effects.emptyResponse(this.options.emptyResponseTimeoutMs);
		}, this.options.emptyResponseTimeoutMs);
	}

	/** 流式生命信号到达 / run 结束 / 主动取消时调用，幂等。 */
	clearEmptyResponse(): void {
		if (this.emptyResponse === undefined) return;
		this.scheduler.clearTimeout(this.emptyResponse);
		this.emptyResponse = undefined;
	}

	// ── 会话结束通知 ────────────────────────────────

	/**
	 * 会话结束通知：不在 settled 当场弹窗——pi 判定 settle 后，最终 assistant 消息的
	 * 收尾事件或紧接着的短工作仍可能到达（用户反馈"通知比对话结束早几秒"）。
	 * 窗口结束时复查状态与本地忙碌信号，只有真正安静才弹；新一轮 run 的
	 * noteRunStarted 会直接撤销定时器。重复调用等价于重置窗口。
	 */
	scheduleSessionEndNotification(): void {
		this.armNotify(this.options.notifyDelayMs);
	}

	/** 用户主动停止/新 run 开始时撤销尚未触发的结束通知。 */
	cancelSessionEndNotification(): void {
		if (this.notify === undefined) return;
		this.scheduler.clearTimeout(this.notify);
		this.notify = undefined;
	}

	private armNotify(delayMs: number): void {
		if (this.disposed) return;
		// 设置读取在单测里可能只是空桩；通知失败不应影响 settle 收口。
		// 递归重排时同样复查：窗口期间用户可能刚关掉通知。
		if (!this.effects.notificationsEnabled()) return;
		this.cancelSessionEndNotification();
		this.notify = this.scheduler.setTimeout(() => {
			this.notify = undefined;
			if (this.view.status !== "idle" || this.view.run.recentlyAborted) return;
			// 窗口结束时仍在流式/工具/压缩/待回答，说明这一轮并没有真的结束；
			// 重新等一个窗口，而不是直接放弃——否则收尾事件晚到时会永远收不到通知。
			// 只问 hasLocalWork：activeToolCalls 与 toolExecuting 恒同时写入，
			// 再并一份就是第二个忙碌口径，正是本模块要消灭的漂移点。
			if (hasLocalWork(localWorkSignalsOf(this.view))) {
				this.armNotify(this.options.notifyDelayMs);
				return;
			}
			// settled 到最终消息之间可能还有一段事件空档：以最后一次工作事件为准补足
			// 静默窗口，避免通知比用户看到的最后一段输出早几秒。
			const quietFor = Date.now() - (this.lastWorkEventAt ?? this.lastPiEventAt ?? 0);
			const remaining = this.options.notifyDelayMs - quietFor;
			if (remaining > 0) {
				this.armNotify(remaining);
				return;
			}
			this.effects.notifyFinished();
		}, delayMs);
	}

	// ── 生命周期 ────────────────────────────────────

	/** agent 关闭/重建：清掉全部五个定时器，退役后没有任何回调能打到旧 runtime。 */
	dispose(): void {
		this.disposed = true;
		this.clearIdleChecks();
		this.clearAbortFallback();
		this.clearEmptyResponse();
		this.cancelSessionEndNotification();
	}
}
