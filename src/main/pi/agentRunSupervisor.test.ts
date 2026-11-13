import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi, type Mock } from "vitest";

import {
	AgentRunSupervisor,
	type AgentRunSupervisorEffects,
	type AgentRunSupervisorScheduler,
	type AgentRunSupervisorView,
} from "./agentRunSupervisor";
import {
	createRunState,
	RUN_SILENCE_FORCE_IDLE_MS,
	sealRun,
	type AgentRunState,
} from "./agentRunState";
import { createTranscriptState, type AgentTranscriptState } from "./agentTranscript";
import { ABORT_SETTLED_FALLBACK_MS, AGENT_SETTLED_TIMEOUT_MS } from "./settleReducer";

/**
 * AgentRunSupervisor 单测：不构造 AgentManager、不碰 Electron、不跑真实 RPC。
 *
 * 原实现把四个定时器藏在 AgentManager 的 Map/runtime 字段里，测试只能断言
 * 「定时器还在 Map 里」——那是对实现细节的断言，重构一次就全红。这里改为注入
 * 受控调度器 + 假时钟，一律断言可观察行为：窗口前不触发、到点只触发一次、
 * 收口时发 settled、弹通知、写告警。
 */

/** 受控调度器：记录全部在册定时器，advance 按到期顺序依次执行（含回调中新排的定时器）。 */
class FakeScheduler implements AgentRunSupervisorScheduler {
	private sequence = 0;
	private readonly live = new Map<number, { at: number; callback: () => void }>();

	get pendingCount(): number {
		return this.live.size;
	}

	setTimeout(callback: () => void, delayMs: number): unknown {
		const handle = ++this.sequence;
		this.live.set(handle, { at: Date.now() + delayMs, callback });
		return handle;
	}

	clearTimeout(handle: unknown): void {
		this.live.delete(handle as number);
	}

	advance(ms: number): void {
		const target = Date.now() + ms;
		for (;;) {
			let dueHandle: number | undefined;
			let dueAt = Number.POSITIVE_INFINITY;
			for (const [handle, timer] of this.live) {
				if (timer.at <= target && timer.at < dueAt) {
					dueHandle = handle;
					dueAt = timer.at;
				}
			}
			if (dueHandle === undefined) break;
			const timer = this.live.get(dueHandle);
			this.live.delete(dueHandle);
			vi.setSystemTime(dueAt);
			timer?.callback();
		}
		vi.setSystemTime(target);
	}
}

/** 监督器的 effects 在本测试里全是记录型 spy：断言「模块请求了什么副作用」。 */
type SupervisedEffectsSpies = {
	readonly [K in keyof AgentRunSupervisorEffects]: Mock;
};

/**
 * 可变背板：view 只是它的只读投影。测试改背板即模拟事件流（新工具、待答问题），
 * 而监督器只看到 ReadonlyMap —— 生产代码不可能误写视图。
 */
type ViewBacking = {
	agentId: string;
	status: AgentRunSupervisorView["status"];
	run: AgentRunState;
	transcript: AgentTranscriptState;
	pendingUIRequests: Map<string, unknown>;
	activeToolCalls: Map<string, unknown>;
	toolExecuting: string | null;
	compacting: boolean;
	rpcCompacting: boolean;
};

type Harness = {
	supervisor: AgentRunSupervisor;
	view: AgentRunSupervisorView;
	/** 视图的底层可变对象：用例只能从这里制造「本地忙碌」。 */
	backing: ViewBacking;
	run: AgentRunState;
	transcript: AgentTranscriptState;
	/** get_state 的可变响应：用例按需改 remote 字段。 */
	stateResponse: { current: { success?: boolean; data?: unknown } };
	effects: SupervisedEffectsSpies;
	scheduler: FakeScheduler;
};

function createHarness(
	options: { emptyResponseTimeoutMs?: number; notificationsEnabled?: boolean } = {},
): Harness {
	const run = createRunState();
	const transcript = createTranscriptState();
	const scheduler = new FakeScheduler();
	const stateResponse: Harness["stateResponse"] = {
		current: { success: true, data: {} },
	};
	const backing: ViewBacking = {
		agentId: "a1",
		status: "running",
		run,
		transcript,
		pendingUIRequests: new Map(),
		activeToolCalls: new Map(),
		toolExecuting: null,
		compacting: false,
		rpcCompacting: false,
	};
	const view: AgentRunSupervisorView = backing;
	const effects: SupervisedEffectsSpies = {
		requestState: vi.fn(async () => stateResponse.current),
		finishAsIdle: vi.fn(),
		abortSettled: vi.fn(),
		emptyResponse: vi.fn(),
		notifyFinished: vi.fn(),
		notificationsEnabled: vi.fn(() => options.notificationsEnabled ?? true),
		log: vi.fn(),
	};
	const supervisor = new AgentRunSupervisor(view, effects, {
		emptyResponseTimeoutMs: options.emptyResponseTimeoutMs ?? 60,
		notifyDelayMs: 2_500,
		scheduler,
	});
	return { supervisor, view, backing, run, transcript, stateResponse, effects, scheduler };
}

/**
 * 受控调度器不经过 vi 的定时器队列，promise 链不会随 advance 自动排空：
 * 推进时钟后手动排空微任务，让 pollIdleOnce 的 RPC await 走完。
 */
async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
	vi.useRealTimers();
});

// ── 空响应兜底 ──────────────────────────────────────

test("空响应窗口：到点前不触发，到点只触发一次并落 error", () => {
	const harness = createHarness({ emptyResponseTimeoutMs: 60 });
	harness.supervisor.scheduleEmptyResponse();

	harness.scheduler.advance(59);
	assert.equal(harness.effects.emptyResponse.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");

	harness.scheduler.advance(1);
	assert.equal(harness.effects.emptyResponse.mock.calls.length, 1);
	assert.equal(harness.effects.emptyResponse.mock.calls[0][0], 60);
	assert.equal(harness.view.status, "error");

	harness.scheduler.advance(10_000);
	assert.equal(harness.effects.emptyResponse.mock.calls.length, 1);
});

test("流式生命信号（clearEmptyResponse）撤销空响应窗口", () => {
	const harness = createHarness({ emptyResponseTimeoutMs: 60 });
	harness.supervisor.scheduleEmptyResponse();
	harness.supervisor.clearEmptyResponse();

	harness.scheduler.advance(10_000);
	assert.equal(harness.effects.emptyResponse.mock.calls.length, 0);
	assert.equal(harness.scheduler.pendingCount, 0);
});

test("noteRunEnded 清掉空响应窗口，run 结束后不再误报", () => {
	const harness = createHarness({ emptyResponseTimeoutMs: 60 });
	harness.supervisor.scheduleEmptyResponse();
	harness.supervisor.noteRunEnded();

	harness.scheduler.advance(10_000);
	assert.equal(harness.effects.emptyResponse.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");
});

// ── settle 轮询 / abort gate ─────────────────────────

test("abort 封印期间 settle 轮询判定 wait：不越过 gate 收口，也不重排", async () => {
	const harness = createHarness();
	sealRun(harness.run, Date.now());
	harness.supervisor.scheduleSettleCheck();

	harness.scheduler.advance(AGENT_SETTLED_TIMEOUT_MS);
	await flushMicrotasks();

	assert.equal(harness.effects.requestState.mock.calls.length, 1);
	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");
	assert.equal(harness.scheduler.pendingCount, 0);
});

test("轮询确认无工作：收口 idle 并发 settled，且不再重排", async () => {
	const harness = createHarness();
	harness.supervisor.scheduleSettleCheck();

	harness.scheduler.advance(AGENT_SETTLED_TIMEOUT_MS);
	await flushMicrotasks();

	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 1);
	assert.equal(harness.view.status, "idle");
	assert.equal(harness.scheduler.pendingCount, 0);
});

test("RPC 往返期间事件路径已收口：不重复收口（no-double-settled）", async () => {
	const harness = createHarness();
	harness.effects.requestState.mockImplementation(async () => {
		harness.view.status = "idle";
		return { success: true, data: {} };
	});

	await harness.supervisor.pollIdleOnce();

	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
});

test("get_state 失败视为未能确认：重排观察而不是永久挂着", async () => {
	const harness = createHarness();
	harness.effects.requestState.mockImplementation(async () => ({ success: false }));
	harness.supervisor.noteEvent("pi");
	// 静默已满一个轮询窗口才会重排（pi 正在推事件时不白烧 RPC）
	harness.scheduler.advance(AGENT_SETTLED_TIMEOUT_MS);

	await harness.supervisor.pollIdleOnce();

	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.scheduler.pendingCount, 1);
});

// ── 静默兜底 ───────────────────────────────────────

test("静默兜底：事件流新鲜时不收口，静默超过 30s 才强制 idle", async () => {
	const harness = createHarness();
	harness.stateResponse.current = { success: true, data: { isStreaming: true } };
	harness.supervisor.noteEvent("pi");
	harness.supervisor.scheduleSettleCheck();

	harness.scheduler.advance(AGENT_SETTLED_TIMEOUT_MS);
	await flushMicrotasks();

	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");
	// 窗口未到但已静默一个轮询窗口：必须重排继续观察
	assert.ok(harness.scheduler.pendingCount > 0, "pi 报忙碌且静默时必须重排");

	harness.scheduler.advance(RUN_SILENCE_FORCE_IDLE_MS);
	await flushMicrotasks();

	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 1);
	assert.equal(harness.view.status, "idle");
	assert.equal(harness.effects.log.mock.calls.length, 1);
	assert.equal(harness.effects.log.mock.calls[0][0], "warn");
	assert.match(String(harness.effects.log.mock.calls[0][1]), /静默兜底/);
	const detail = harness.effects.log.mock.calls[0][2] as {
		agentId: string;
		silentMs: number;
		queuedMessages: number;
		remoteIsStreaming: boolean;
	};
	assert.equal(detail.agentId, "a1");
	// 静默时长由两个窗口叠加得出（settle 轮询窗 + 静默窗），只断言已越过阈值。
	assert.ok(detail.silentMs >= RUN_SILENCE_FORCE_IDLE_MS);
	assert.equal(detail.queuedMessages, 0);
	assert.equal(detail.remoteIsStreaming, true);
});

test("静默兜底：等待回答的 UI 请求与工具执行中都不收口（且短路 get_state）", async () => {
	const harness = createHarness();
	harness.stateResponse.current = { success: true, data: { isStreaming: true } };
	harness.supervisor.noteEvent("pi");
	harness.scheduler.advance(RUN_SILENCE_FORCE_IDLE_MS + 1_000);

	harness.backing.pendingUIRequests.set("ask-1", {});
	await harness.supervisor.pollIdleOnce();
	assert.equal(harness.effects.requestState.mock.calls.length, 0);
	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");

	harness.backing.pendingUIRequests.clear();
	harness.backing.toolExecuting = "read";
	await harness.supervisor.pollIdleOnce();
	assert.equal(harness.effects.requestState.mock.calls.length, 0);
	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");
});

test("静默兜底：自动重试窗口内不收口", async () => {
	const harness = createHarness();
	harness.stateResponse.current = { success: true, data: { isStreaming: true } };
	harness.transcript.messages.push({
		id: "retry-1",
		agentId: "a1",
		role: "system",
		text: "正在自动重试 1/3",
		timestamp: Date.now(),
		meta: { status: "running" },
	});
	harness.transcript.retryStatusMessageId = "retry-1";
	harness.supervisor.noteEvent("pi");
	harness.scheduler.advance(RUN_SILENCE_FORCE_IDLE_MS + 1_000);

	await harness.supervisor.pollIdleOnce();
	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");
});

test("静默兜底：get_state 往返期间新出现的本地忙碌必须先于收口生效", async () => {
	const harness = createHarness();
	harness.stateResponse.current = { success: true, data: { isStreaming: true } };
	harness.supervisor.noteEvent("pi");
	harness.scheduler.advance(RUN_SILENCE_FORCE_IDLE_MS + 1_000);

	// 静默窗口已到，进入兜底时本地无忙碌；但 RPC 往返期间用户提问/工具启动，
	// 此时不得按陈旧快照强制收口——否则正在等待回答的 run 会被判成完成。
	harness.effects.requestState.mockImplementationOnce(async () => {
		harness.backing.pendingUIRequests.set("ask-late", {});
		return harness.stateResponse.current;
	});
	await harness.supervisor.pollIdleOnce();

	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");
});

test("abort 兜底到点只解封 gate，不置 idle、不发 settled", () => {
	const harness = createHarness();
	sealRun(harness.run, Date.now());
	harness.supervisor.noteAbortSealed();

	harness.scheduler.advance(ABORT_SETTLED_FALLBACK_MS);
	assert.equal(harness.effects.abortSettled.mock.calls.length, 1);
	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");
});

test("noteAbortSettled 撤销兜底定时器并结束 gate 等待", () => {
	const harness = createHarness();
	sealRun(harness.run, Date.now());
	harness.supervisor.noteAbortSealed();

	harness.supervisor.noteAbortSettled();
	assert.equal(harness.scheduler.pendingCount, 0);
	assert.equal(harness.effects.abortSettled.mock.calls.length, 1);

	harness.scheduler.advance(ABORT_SETTLED_FALLBACK_MS);
	assert.equal(harness.effects.abortSettled.mock.calls.length, 1);
});

// ── 会话结束通知 ───────────────────────────────────

test("会话结束通知：仍忙时自我重排，最终只弹一次", () => {
	const harness = createHarness();
	harness.view.status = "idle";
	harness.supervisor.noteEvent("work");
	harness.backing.activeToolCalls.set("tool-1", "read");
	harness.supervisor.scheduleSessionEndNotification();

	harness.scheduler.advance(2_499);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 0);

	// 窗口到点仍在执行工具：重排而不是放弃
	harness.scheduler.advance(1);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 0);

	harness.backing.activeToolCalls.clear();
	harness.scheduler.advance(2_500);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 1);

	harness.scheduler.advance(10_000);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 1);
});

test("会话结束通知：静默窗口按最后一次工作事件补足", () => {
	const harness = createHarness();
	harness.view.status = "idle";
	harness.supervisor.scheduleSessionEndNotification();

	// 窗口中途还有工作事件：通知必须等它之后满 2.5s
	harness.scheduler.advance(1_000);
	harness.supervisor.noteEvent("work");

	harness.scheduler.advance(1_500);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 0);

	harness.scheduler.advance(1_000);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 1);
});

test("会话结束通知：新一轮 run 开始时撤销", () => {
	const harness = createHarness();
	harness.view.status = "idle";
	harness.supervisor.scheduleSessionEndNotification();
	harness.scheduler.advance(1_000);

	harness.supervisor.noteRunStarted();
	assert.equal(harness.scheduler.pendingCount, 0);

	harness.scheduler.advance(10_000);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 0);
});

test("通知关闭时不布防（设置读取失败也不影响收口）", () => {
	const harness = createHarness({ notificationsEnabled: false });
	harness.view.status = "idle";
	harness.supervisor.scheduleSessionEndNotification();

	assert.equal(harness.scheduler.pendingCount, 0);
	harness.scheduler.advance(10_000);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 0);
});

// ── 生命周期 ───────────────────────────────────────

test("dispose 清掉全部定时器，之后推进时钟不产生任何副作用", () => {
	const harness = createHarness();
	harness.supervisor.scheduleSettleCheck();
	harness.supervisor.noteAbortSealed();
	harness.supervisor.scheduleEmptyResponse();
	harness.view.status = "idle";
	harness.supervisor.scheduleSessionEndNotification();
	assert.equal(harness.scheduler.pendingCount, 4);

	harness.supervisor.dispose();
	assert.equal(harness.scheduler.pendingCount, 0);

	harness.scheduler.advance(60_000);
	assert.equal(harness.effects.requestState.mock.calls.length, 0);
	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.effects.emptyResponse.mock.calls.length, 0);
	assert.equal(harness.effects.abortSettled.mock.calls.length, 0);
	assert.equal(harness.effects.notifyFinished.mock.calls.length, 0);
});

test("dispose 之后在途轮询的回包既不收口也不再重排", async () => {
	const harness = createHarness();
	const gate = Promise.withResolvers<{ success?: boolean; data?: unknown }>();
	harness.effects.requestState.mockImplementation(() => gate.promise);
	harness.supervisor.noteEvent("pi");
	const pending = harness.supervisor.pollIdleOnce();
	harness.supervisor.dispose();
	harness.scheduler.advance(AGENT_SETTLED_TIMEOUT_MS);
	// 回包说「无工作」——若没有 dispose 守卫，这里会为已退役的 agent 补发一次 settled。
	gate.resolve({ success: true, data: { isStreaming: false, isSettled: true } });
	await pending;
	await flushMicrotasks();

	assert.equal(harness.effects.finishAsIdle.mock.calls.length, 0);
	assert.equal(harness.view.status, "running");
	assert.equal(harness.scheduler.pendingCount, 0);
});

test("dispose 之后在途轮询失败也不得重排（不留到期即空跑的定时器）", async () => {
	const harness = createHarness();
	const gate = Promise.withResolvers<{ success?: boolean; data?: unknown }>();
	harness.effects.requestState.mockImplementation(() => gate.promise);
	harness.supervisor.noteEvent("pi");
	const pending = harness.supervisor.pollIdleOnce();
	harness.supervisor.dispose();
	harness.scheduler.advance(AGENT_SETTLED_TIMEOUT_MS);
	// RPC 失败本应「重排继续观察」；但 supervisor 已退役，重排只会留下空跑定时器。
	gate.resolve({ success: false });
	await pending;
	await flushMicrotasks();

	assert.equal(harness.scheduler.pendingCount, 0);
});

test("扩展命令后的即时复查：100ms 窗口到点才查 get_state", async () => {
	const harness = createHarness();
	harness.supervisor.scheduleIdleCheck(100);

	harness.scheduler.advance(99);
	await flushMicrotasks();
	assert.equal(harness.effects.requestState.mock.calls.length, 0);

	harness.scheduler.advance(1);
	await flushMicrotasks();
	assert.equal(harness.effects.requestState.mock.calls.length, 1);
	assert.equal(harness.view.status, "idle");
});

test("扩展命令复查不得顶掉已排队的 settle 观察", async () => {
	// 回归来源：两条调度曾共用同一个定时器槽位。agent_end 排的 1200ms settle 链若被
	// 300ms 后扩展命令 prompt 的 100ms 复查清掉，而复查又因 pi 陈旧忙碌标志走了
	// stay-running + rearm 静默门限（事件流刚有事件，不重排），这次 run 就再无观察者，
	// 永久停在 running——正是本模块存在的理由。
	const harness = createHarness();
	harness.supervisor.noteRunStarted();
	harness.supervisor.scheduleSettleCheck();
	// 事件流刚有活动（< 1200ms）：rearm 的静默门限会拦住重排，这次 run 只剩这条链。
	harness.supervisor.noteEvent("pi");
	// pi 仍报忙碌，且事件流新鲜（< 1200ms），rearm 不会重排。
	harness.stateResponse.current = {
		success: true,
		data: { isStreaming: true, isCompacting: false, autoRetryAttempt: 0, messageCount: 1 },
	};

	harness.supervisor.scheduleIdleCheck(100);
	harness.scheduler.advance(100);
	await flushMicrotasks();
	assert.equal(harness.effects.requestState.mock.calls.length, 1);
	assert.equal(harness.view.status, "running");

	// settle 那条链必须仍然活着：推进到 1200ms 窗口仍会再查一次。
	harness.scheduler.advance(AGENT_SETTLED_TIMEOUT_MS);
	await flushMicrotasks();
	assert.equal(
		harness.effects.requestState.mock.calls.length,
		2,
		"settle 观察被 100ms 复查顶掉了",
	);
});
