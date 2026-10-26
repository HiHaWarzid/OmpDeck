import assert from "node:assert/strict";
import { test, vi } from "vitest";

import type {
	AgentManagerEvent,
	AgentStatus,
	AgentTab,
	ChatMessage,
} from "../../shared/types";
import { AgentManager, isRpcLogWorthy } from "./AgentManager";
import { ipcChannels } from "../../shared/ipc";
import { showAppNotification } from "../notifications";
import { createStreamGateState, type StreamGateState } from "./streamGate";
import { createTranscriptState, type AgentTranscriptState } from "./agentTranscript";
import { createRunState, RUN_SILENCE_FORCE_IDLE_MS, type AgentRunState } from "./agentRunState";
import { AGENT_SETTLED_TIMEOUT_MS } from "./settleReducer";
import type { AgentConfigDeps } from "./AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";

vi.mock("../notifications", () => ({
	showAppNotification: vi.fn(),
	focusMainWindow: vi.fn(),
}));

// electron 在 vitest（node 环境）下不可用；AgentManager 及其依赖只在构造/方法调用时
// 触碰 electron API，本测试不触发任何 UI/通知路径，提供最小桩即可。
vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
	BrowserWindow: class {},
	Notification: class {},
	shell: {},
	net: {},
}));

/** 覆盖本测试触达路径所需的 AgentRuntime 字段子集（AgentRuntime 未导出，按需声明）。 */
type TestRuntime = {
	tab: AgentTab;
	slot: {
		process: {
			client: {
				request: (req: unknown, timeoutMs?: number) => Promise<unknown>;
				sendRaw?: (payload: Record<string, unknown>) => void;
			};
		};
	};
	transcript: AgentTranscriptState;
	run: AgentRunState;
	toolStateSequence: number;
	activeToolCalls: Map<string, string>;
	toolExecuting: string | null;
	runtimeStateSeq: number;
	settleCheckTimer?: NodeJS.Timeout;
	/** 最近一次 pi 事件时刻：静默兜底按它计算事件流静默时长 */
	lastPiEventAt?: number;
	/** 最近一次工作事件时刻：会话结束通知按它计算静默窗口 */
	lastWorkEventAt?: number;
	/** 待消费的本地斜线命令名（command_output 标注来源用） */
	lastLocalCommand?: string;
	pendingUIRequests: Map<string, { method: string; title: string }>;
	rpcLogging: boolean;
	compacting: boolean;
	rpcCompacting: boolean;
	modelRefreshing: boolean;
	autoRestartAttempted: boolean;
};

/** 构造带全部默认字段的最小 runtime；client.request 默认抛错（RPC 路径由各测试按需覆盖）。 */
function makeRuntime(
	tab: AgentTab,
	client?: TestRuntime["slot"]["process"]["client"],
): TestRuntime {
	return {
		tab,
		slot: {
			process: {
				client: client ?? {
					request: async () => {
						throw new Error("RPC stub not needed");
					},
				},
			},
		},
		// 状态由模块工厂创建：测试不再手写字段清单，字段漂移在编译期暴露
		transcript: createTranscriptState(),
		run: createRunState(),
		toolStateSequence: 0,
		activeToolCalls: new Map(),
		toolExecuting: null,
		runtimeStateSeq: 0,
		pendingUIRequests: new Map(),
		rpcLogging: false,
		compacting: false,
		rpcCompacting: false,
		modelRefreshing: false,
		autoRestartAttempted: false,
	};
}

function makeTab(id: string, status: AgentStatus): AgentTab {
	return {
		id,
		projectId: "p1",
		cwd: "C:/work",
		title: `${id} agent`,
		status,
		createdAt: Date.now(),
	};
}

/** 最小依赖桩构造 AgentManager（本测试不调用设置/配置读取）。appLogger 可选：静默兜底告警断言用。 */
function makeManager(appLogger?: AppLogger): AgentManager {
	return new AgentManager(
		() => undefined, // getProject：不涉及项目解析
		() => null, // getWindow：不推送 IPC
		{} as unknown as SettingsStore, // 测试桩：不读写设置
		{} as unknown as AgentConfigDeps, // 测试桩：不读写配置
		undefined, // rpcLogger：本测试不落 RPC 日志
		appLogger,
	);
}

/**
 * 测试需触达 private 成员（agents/emitStateNow/addMessage/handlePiEvent 等）：
 * TS 的 private 仅是编译期约束，这里经 unknown 双断言收窄到本测试所需形状。
 */
type ManagerInternals = {
	agents: Map<string, TestRuntime>;
	emitStateNow(): void;
	addMessage(
		runtime: TestRuntime,
		role: string,
		text: string,
		meta?: Record<string, unknown>,
	): void;
	handlePiEvent(agentId: string, event: unknown): void;
	handleUIRequest(runtime: TestRuntime, event: Record<string, unknown>): void;
	emit: (channel: string, payload: unknown) => void;
	markIdleIfPiReportsNoWork(agentId: string): Promise<void>;
	emitRuntimeState(agentId: string): Promise<void>;
};

function internals(manager: AgentManager): ManagerInternals {
	return manager as unknown as ManagerInternals;
}

// ── onAgentEvent：订阅 / 退订 ───────────────────────────

test("onAgentEvent 收到 messageAppended，退订后不再收到", () => {
	const manager = makeManager();
	const events: AgentManagerEvent[] = [];
	const unsubscribe = manager.onAgentEvent((event) => events.push(event));
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "idle"));
	inner.agents.set("a1", runtime);

	inner.addMessage(runtime, "user", "你好");
	assert.equal(events.length, 1);
	const event = events[0];
	assert(event.type === "messageAppended");
	assert.equal(event.agentId, "a1");
	assert.equal(event.message.text, "你好");
	assert.equal(event.message.role, "user");
	assert.equal(event.message.agentId, "a1");
	assert.equal(event.message.id, runtime.transcript.messages[0]?.id);
	assert.equal(event.message, runtime.transcript.messages[0]); // 与落库对象同构
	assert.equal(typeof event.message.timestamp, "number");

	unsubscribe();
	inner.addMessage(runtime, "assistant", "回复");
	assert.equal(events.length, 1); // 退订后不再收到
});

test("退订函数可重复调用（幂等）", () => {
	const manager = makeManager();
	const events: AgentManagerEvent[] = [];
	const unsubscribe = manager.onAgentEvent((event) => events.push(event));
	unsubscribe();
	unsubscribe();
	const inner = internals(manager);
	inner.addMessage(makeRuntime(makeTab("a1", "idle")), "user", "x");
	assert.equal(events.length, 0);
});

// ── statusChanged：emitStateNow 聚合点 diff ─────────────

test("statusChanged 只在 status 实际变化时发（同一状态重复聚合不发）", () => {
	const manager = makeManager();
	const events: AgentManagerEvent[] = [];
	manager.onAgentEvent((event) => events.push(event));
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "idle"));
	inner.agents.set("a1", runtime);

	inner.emitStateNow();
	assert.equal(events.length, 1);
	assert(events[0].type === "statusChanged");
	assert.equal(events[0].agentId, "a1");
	assert.equal(events[0].status, "idle");
	assert.equal(events[0].tab, runtime.tab);

	// 同一状态再次聚合：不发重复事件
	inner.emitStateNow();
	assert.equal(events.length, 1);

	// 状态变化时只发变化的 agent；新出现的 agent 发首次状态，未变化的 agent 不发。
	// 注意：list() 按 createdAt 倒序，同毫秒创建的顺序不保证，因此按 agentId 取事件而不按下标。
	runtime.tab.status = "running";
	inner.agents.set("a2", makeRuntime(makeTab("a2", "idle")));
	inner.emitStateNow();
	assert.equal(events.length, 3);
	// events[0] 是首次聚合的 a1/idle；这里只看状态变化后新增的两个事件
	const changed = events.slice(1);
	const byAgent = new Map<string, Extract<AgentManagerEvent, { type: "statusChanged" }>>();
	for (const event of changed) {
		if (event.type === "statusChanged") byAgent.set(event.agentId, event);
	}
	assert.equal(changed.length, 2);
	assert.equal(byAgent.get("a1")?.status, "running");
	assert.equal(byAgent.get("a2")?.status, "idle");
});

// ── 异常隔离 ───────────────────────────────────────────

test("listener 抛异常不影响其它监听器", () => {
	const manager = makeManager();
	const received: AgentManagerEvent[] = [];
	manager.onAgentEvent(() => {
		throw new Error("boom");
	});
	manager.onAgentEvent((event) => received.push(event));
	const inner = internals(manager);
	inner.agents.set("a1", makeRuntime(makeTab("a1", "idle")));

	inner.emitStateNow();
	assert.equal(received.length, 1);
	assert(received[0].type === "statusChanged");
	assert.equal(received[0].agentId, "a1");
});

// ── settled：agent_settled 事件（旧 pi）与兜底检查（omp）──

test("agent_settled 事件触发 settled；重复收到时幂等不发", () => {
	const manager = makeManager();
	const settled: string[] = [];
	manager.onAgentEvent((event) => {
		if (event.type === "settled") settled.push(event.agentId);
	});
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"));
	inner.agents.set("a1", runtime);

	inner.handlePiEvent("a1", { type: "agent_settled" });
	assert.deepEqual(settled, ["a1"]);
	assert.equal(runtime.tab.status, "idle");

	// 再次收到 agent_settled（如 omp 兜底已先置 idle）：幂等，不重复发
	inner.handlePiEvent("a1", { type: "agent_settled" });
	assert.deepEqual(settled, ["a1"]);
});

test("omp 无 agent_settled：markIdleIfPiReportsNoWork 兜底同样发 settled", async () => {
	const manager = makeManager();
	const settled: string[] = [];
	manager.onAgentEvent((event) => {
		if (event.type === "settled") settled.push(event.agentId);
	});
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true, data: {} }),
	});
	inner.agents.set("a1", runtime);

	await inner.markIdleIfPiReportsNoWork("a1");
	assert.deepEqual(settled, ["a1"]);
	assert.equal(runtime.tab.status, "idle");
});

test("兜底检查仍有排队消息时不发 settled", async () => {
	const manager = makeManager();
	const settled: string[] = [];
	manager.onAgentEvent((event) => {
		if (event.type === "settled") settled.push(event.agentId);
	});
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true, data: { pendingMessageCount: 1 } }),
	});
	inner.agents.set("a1", runtime);

	await inner.markIdleIfPiReportsNoWork("a1");
	assert.deepEqual(settled, []);
	assert.equal(runtime.tab.status, "running");
});

test("session_settled 事件（新 pi）与 agent_settled 走同一收口路径", () => {
	const manager = makeManager();
	const settled: string[] = [];
	manager.onAgentEvent((event) => {
		if (event.type === "settled") settled.push(event.agentId);
	});
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"));
	inner.agents.set("a1", runtime);

	inner.handlePiEvent("a1", { type: "session_settled" });
	assert.deepEqual(settled, ["a1"]);
	assert.equal(runtime.tab.status, "idle");

	// 再次收到（如兜底已先置 idle）：幂等，不重复发
	inner.handlePiEvent("a1", { type: "session_settled" });
	assert.deepEqual(settled, ["a1"]);
});

test("兜底轮询采信 pi 自报 isSettled：陈旧 isStreaming/isCompacting 不再卡住 running", async () => {
	// 录制故障形态：run 已结束，但 get_state 仍报 isStreaming/isCompacting/排队消息为真。
	// 旧实现只认忙碌标志 → 保持 running 且不再复查，UI 三点指示器永久不停。
	const manager = makeManager();
	const settled: string[] = [];
	manager.onAgentEvent((event) => {
		if (event.type === "settled") settled.push(event.agentId);
	});
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({
			success: true,
			data: { isStreaming: true, isCompacting: true, pendingMessageCount: 1, isSettled: true },
		}),
	});
	inner.agents.set("a1", runtime);

	await inner.markIdleIfPiReportsNoWork("a1");

	assert.deepEqual(settled, ["a1"]);
	assert.equal(runtime.tab.status, "idle");
});

test("兜底轮询：pi 报忙碌且事件流静默时重排下一次检查，静默超窗后强制收口", async () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager();
		const request = vi.fn(async () => ({ success: true, data: { isStreaming: true } }));
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"), { request });
		inner.agents.set("a1", runtime);
		// 静默超过轮询窗口、但还没到兜底窗口：属于"pi 报忙碌却没有任何事件"的可疑区间
		runtime.lastPiEventAt = Date.now() - 5_000;

		await inner.markIdleIfPiReportsNoWork("a1");
		assert.equal(request.mock.calls.length, 1);
		assert.equal(runtime.tab.status, "running");

		// 重排生效：下一次窗口到点会再查一次
		await vi.advanceTimersByTimeAsync(AGENT_SETTLED_TIMEOUT_MS + 10);
		assert.equal(request.mock.calls.length, 2);
		assert.equal(runtime.tab.status, "running");

		// 静默累计超过兜底窗口：不再无限观察，按陈旧标志强制收口
		await vi.advanceTimersByTimeAsync(RUN_SILENCE_FORCE_IDLE_MS);
		assert.equal(runtime.tab.status, "idle");
	} finally {
		vi.useRealTimers();
	}
});

test("静默兜底强制收口时记 warn 日志（保留陈旧标志证据）并发 settled", async () => {
	vi.useFakeTimers();
	try {
		const warns: Array<{ scope: string; message: string; detail?: unknown }> = [];
		const appLogger = {
			warn: (scope: string, message: string, detail?: unknown) => {
				warns.push({ scope, message, detail });
			},
		} as unknown as AppLogger;
		const manager = makeManager(appLogger);
		const settled: string[] = [];
		manager.onAgentEvent((event) => {
			if (event.type === "settled") settled.push(event.agentId);
		});
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"), {
			request: async () => ({
				success: true,
				data: { isStreaming: true, isCompacting: true, isSettled: false },
			}),
		});
		inner.agents.set("a1", runtime);
		runtime.lastPiEventAt = Date.now() - RUN_SILENCE_FORCE_IDLE_MS - 1_000;

		await inner.markIdleIfPiReportsNoWork("a1");

		assert.equal(runtime.tab.status, "idle");
		assert.deepEqual(settled, ["a1"]);
		assert.equal(warns.length, 1);
		assert.equal(warns[0].scope, "agent");
		assert.match(warns[0].message, /静默兜底/);
		// 告警里保留远端原始字段：下次复现能直接看出是哪个标志在说谎
		assert.deepEqual(warns[0].detail, {
			agentId: "a1",
			silentMs: RUN_SILENCE_FORCE_IDLE_MS + 1_000,
			queuedMessages: 0,
			remoteIsStreaming: true,
			remoteIsCompacting: true,
			remoteIsSettled: false,
		});
	} finally {
		vi.useRealTimers();
	}
});

test("静默兜底：自动重试窗口与等待回答的 UI 请求期间不收口", async () => {
	const manager = makeManager();
	const settled: string[] = [];
	manager.onAgentEvent((event) => {
		if (event.type === "settled") settled.push(event.agentId);
	});
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true, data: { isStreaming: true } }),
	});
	inner.agents.set("a1", runtime);
	// 模拟 upsertRetryStatusMessage 写下的"正在自动重试"状态消息
	runtime.transcript.messages.push({
		id: "retry-1",
		agentId: "a1",
		role: "system",
		text: "正在自动重试 1/3",
		timestamp: Date.now(),
		meta: { status: "running" },
	});
	runtime.transcript.retryStatusMessageId = "retry-1";
	runtime.lastPiEventAt = Date.now() - RUN_SILENCE_FORCE_IDLE_MS - 1_000;

	await inner.markIdleIfPiReportsNoWork("a1");
	assert.deepEqual(settled, []);
	assert.equal(runtime.tab.status, "running");

	// 重试结束（meta.status 由 auto_retry_end 改写）：兜底重新生效
	(runtime.transcript.messages[0].meta as Record<string, unknown>).status = "success";
	await inner.markIdleIfPiReportsNoWork("a1");
	assert.deepEqual(settled, ["a1"]);
	assert.equal(runtime.tab.status, "idle");
});

test("轮询往返期间已被事件路径收口：不重复发 settled", async () => {
	const manager = makeManager();
	const settled: string[] = [];
	manager.onAgentEvent((event) => {
		if (event.type === "settled") settled.push(event.agentId);
	});
	const inner = internals(manager);
	let created: TestRuntime | undefined;
	created = makeRuntime(makeTab("a1", "running"), {
		request: async () => {
			// 模拟 get_state 往返期间 agent_settled 已把 run 收口 idle
			if (created) created.tab.status = "idle";
			return { success: true, data: {} };
		},
	});
	inner.agents.set("a1", created);

	await inner.markIdleIfPiReportsNoWork("a1");

	assert.deepEqual(settled, []);
});

// ── runtimeStateChanged ───────────────────────────────

test("emitRuntimeState 完成时发 runtimeStateChanged（与 IPC 同一份 state）", async () => {
	const manager = makeManager();
	const states: Array<{ agentId: string; state: unknown }> = [];
	manager.onAgentEvent((event) => {
		if (event.type === "runtimeStateChanged") states.push(event);
	});
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true, data: {} }),
	});
	inner.agents.set("a1", runtime);

	await inner.emitRuntimeState("a1");
	assert.equal(states.length, 1);
	assert.equal(states[0].agentId, "a1");
});

test("已收口 idle/error 后 runtime state 不再上报 pi 的陈旧 isStreaming/isCompacting", async () => {
	// 本地 status 是"本轮是否还有工作"的最终裁定：pi 的标志在 run 结束后可能是陈旧真值，
	// 若继续上报，渲染层会按 isStreaming 一直画三点指示器（录制故障的可见症状）。
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "idle"), {
		request: async () => ({ success: true, data: { isStreaming: true, isCompacting: true } }),
	});
	inner.agents.set("a1", runtime);

	const settledState = await manager.getRuntimeState("a1");
	assert.equal(settledState.isStreaming, false);
	assert.equal(settledState.isCompacting, false);

	// running 期间仍按 pi 的实时快照上报
	runtime.tab.status = "running";
	const runningState = await manager.getRuntimeState("a1");
	assert.equal(runningState.isStreaming, true);
	assert.equal(runningState.isCompacting, true);
});

// ── isRpcLogWorthy（RPC 日志默认落盘过滤）──────────────

test("isRpcLogWorthy: send 方向与阶段/响应事件全记，流式增量跳过", () => {
	// send：无论类型都记录
	assert.equal(isRpcLogWorthy({ direction: "send", data: { type: "prompt" } }), true);
	// recv 响应：记录
	assert.equal(
		isRpcLogWorthy({ direction: "recv", data: { type: "response", command: "get_state", success: true } }),
		true,
	);
	// recv 阶段事件（toolcall_start / agent_start 等低频）：记录
	assert.equal(
		isRpcLogWorthy({
			direction: "recv",
			data: { type: "message_update", assistantMessageEvent: { type: "toolcall_start" } },
		}),
		true,
	);
	// recv 无 assistantMessageEvent 的 message_update：记录
	assert.equal(isRpcLogWorthy({ direction: "recv", data: { type: "message_update" } }), true);
	// recv 非 message_update 类型：记录
	assert.equal(isRpcLogWorthy({ direction: "recv", data: { type: "agent_start" } }), true);
	// 流式增量（每 token 一条）：默认不落盘
	assert.equal(
		isRpcLogWorthy({
			direction: "recv",
			data: { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
		}),
		false,
	);
	assert.equal(
		isRpcLogWorthy({
			direction: "recv",
			data: { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } },
		}),
		false,
	);
	// toolcall_delta：与文本增量同为每块一条（实测占单 agent 单日日志 83%），默认不落盘
	assert.equal(
		isRpcLogWorthy({
			direction: "recv",
			data: { type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } },
		}),
		false,
	);
	// 工具输出分片：默认不落盘；调用起止事件仍照常记录（顺序/耗时/成败可还原）
	assert.equal(
		isRpcLogWorthy({ direction: "recv", data: { type: "tool_execution_update" } }),
		false,
	);
	assert.equal(isRpcLogWorthy({ direction: "recv", data: { type: "tool_stream_update" } }), false);
	assert.equal(isRpcLogWorthy({ direction: "recv", data: { type: "tool_execution_start" } }), true);
	assert.equal(isRpcLogWorthy({ direction: "recv", data: { type: "tool_execution_end" } }), true);
	// send 方向不受上述过滤影响（用户主动命令全记）
	assert.equal(isRpcLogWorthy({ direction: "send", data: { type: "tool_execution_update" } }), true);
});

// ── omp 原生 ask（method: "ask"）协议适配 ──────────────────

test("native ask 转发结构化问题，回答走 answers 数组", () => {
	const manager = makeManager();
	const emitted: Array<{ channel: string; payload: any }> = [];
	const sent: Array<Record<string, unknown>> = [];
	const inner = internals(manager);
	inner.emit = (channel, payload) => emitted.push({ channel, payload });
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true }),
		sendRaw: (payload) => sent.push(payload),
	});
	inner.agents.set("a1", runtime);

	inner.handleUIRequest(runtime, {
		type: "extension_ui_request",
		id: "r1",
		method: "ask",
		timeout: 60_000,
		questions: [
			{
				id: "q1",
				header: "范围",
				question: "先改哪一块？",
				recommended: 1,
				options: [
					{ label: "主进程", description: "IPC 与进程管理" },
					{ label: "渲染层" },
				],
			},
		],
	});

	const ask = emitted.find((item) => item.payload?.requestId === "r1");
	assert.equal(ask?.payload.method, "ask");
	assert.equal(ask?.payload.askQuestions[0].id, "q1");
	assert.equal(ask?.payload.askQuestions[0].options[0].description, "IPC 与进程管理");
	assert.equal(ask?.payload.askQuestions[0].recommended, 1);
	assert.equal(ask?.payload.timeout, 60_000);
	assert.equal(runtime.pendingUIRequests.get("r1")?.method, "ask");

	manager.sendUIResponse("a1", "r1", {
		answers: [{ id: "q1", selectedOptions: ["渲染层"] }],
	});

	assert.deepEqual(sent[0], {
		type: "extension_ui_response",
		id: "r1",
		answers: [{ id: "q1", selectedOptions: ["渲染层"] }],
	});
	assert.equal(runtime.pendingUIRequests.size, 0);
});

test("native ask 被 pi 取消时清理 pending 并通知渲染层收起", () => {
	const manager = makeManager();
	const emitted: Array<{ channel: string; payload: any }> = [];
	const inner = internals(manager);
	inner.emit = (channel, payload) => emitted.push({ channel, payload });
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true }),
		sendRaw: () => undefined,
	});
	inner.agents.set("a1", runtime);

	inner.handleUIRequest(runtime, {
		type: "extension_ui_request",
		id: "r2",
		method: "ask",
		questions: [{ id: "q1", question: "继续？", options: ["是", "否"] }],
	});
	assert.equal(runtime.pendingUIRequests.size, 1);

	inner.handleUIRequest(runtime, {
		type: "extension_ui_request",
		id: "cancel-1",
		method: "cancel",
		targetId: "r2",
	});

	assert.equal(runtime.pendingUIRequests.size, 0);
	assert.ok(
		emitted.some(
			(item) =>
				item.payload?.requestId === "r2" &&
				item.payload?.completed === true &&
				item.payload?.cancelled === true,
		),
	);
});

test("会话结束通知在 2.5s 静默窗口后触发，期间重新开跑则取消", () => {
	vi.useFakeTimers();
	const manager = new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({ enableNotifications: true }) } as unknown as SettingsStore,
		{} as unknown as AgentConfigDeps,
		undefined,
		undefined,
	);
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true, data: {} }),
		sendRaw: () => undefined,
	});
	inner.agents.set("a1", runtime);
	inner.addMessage(runtime, "assistant", "已完成");
	const notify = vi.mocked(showAppNotification);
	notify.mockClear();

	inner.handlePiEvent("a1", { type: "session_settled" });
	vi.advanceTimersByTime(2_499);
	assert.equal(notify.mock.calls.length, 0);

	// 新一轮 run 已开始：旧通知必须撤销，不能提示"已完成"。
	inner.handlePiEvent("a1", { type: "agent_start" });
	vi.advanceTimersByTime(5_000);
	assert.equal(notify.mock.calls.length, 0);

	inner.handlePiEvent("a1", { type: "agent_end" });
	inner.handlePiEvent("a1", { type: "session_settled" });
	vi.advanceTimersByTime(2_500);
	assert.equal(notify.mock.calls.length, 1);
	vi.useRealTimers();
});

test("会话结束通知的静默窗口不被标题等元数据事件刷新", () => {
	vi.useFakeTimers();
	const manager = new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({ enableNotifications: true }) } as unknown as SettingsStore,
		{} as unknown as AgentConfigDeps,
		undefined,
		undefined,
	);
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true, data: {} }),
		sendRaw: () => undefined,
	});
	inner.agents.set("a1", runtime);
	inner.addMessage(runtime, "assistant", "已完成");
	const notify = vi.mocked(showAppNotification);
	notify.mockClear();

	inner.handlePiEvent("a1", { type: "session_settled" });
	vi.advanceTimersByTime(2_000);
	// 标题更新只刷新 lastPiEventAt，不应把通知再推迟 2.5s。
	inner.handlePiEvent("a1", { type: "session_info_update", name: "新标题" });
	vi.advanceTimersByTime(499);
	assert.equal(notify.mock.calls.length, 0);
	vi.advanceTimersByTime(1);
	assert.equal(notify.mock.calls.length, 1);
	vi.useRealTimers();
});

test("窗口结束时仍在执行工具则不弹通知，等收尾后重新计时", () => {
	vi.useFakeTimers();
	const manager = new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({ enableNotifications: true }) } as unknown as SettingsStore,
		{} as unknown as AgentConfigDeps,
		undefined,
		undefined,
	);
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true, data: {} }),
		sendRaw: () => undefined,
	});
	inner.agents.set("a1", runtime);
	inner.addMessage(runtime, "assistant", "已完成");
	const notify = vi.mocked(showAppNotification);
	notify.mockClear();

	inner.handlePiEvent("a1", { type: "session_settled" });
	runtime.activeToolCalls.set("tool-1", "read");
	vi.advanceTimersByTime(2_500);
	assert.equal(notify.mock.calls.length, 0);

	runtime.activeToolCalls.clear();
	vi.advanceTimersByTime(2_500);
	assert.equal(notify.mock.calls.length, 1);
	vi.useRealTimers();
});

test("native ask 载荷有坏题时整体取消，避免 answers 与问题错位", () => {
	const manager = makeManager();
	const emitted: Array<{ channel: string; payload: any }> = [];
	const sent: Array<Record<string, unknown>> = [];
	const inner = internals(manager);
	inner.emit = (channel, payload) => emitted.push({ channel, payload });
	const runtime = makeRuntime(makeTab("a1", "running"), {
		request: async () => ({ success: true }),
		sendRaw: (payload) => sent.push(payload),
	});
	inner.agents.set("a1", runtime);

	inner.handleUIRequest(runtime, {
		type: "extension_ui_request",
		id: "r3",
		method: "ask",
		questions: [{ id: "q1", question: "正常" }, { id: "q2" }],
	});

	assert.deepEqual(sent[0], {
		type: "extension_ui_response",
		id: "r3",
		cancelled: true,
	});
	assert.equal(runtime.pendingUIRequests.size, 0);
	assert.ok(
		!emitted.some(
			(item) => item.payload?.requestId === "r3" && item.payload?.method === "ask",
		),
	);
});

// ── 本地斜线命令输出（command_output） ───────────────────

test("command_output 落成 commandOutput 系统消息，同一命令多帧沿用命令名", () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"));
	inner.agents.set("a1", runtime);
	runtime.lastLocalCommand = "context";

	inner.handlePiEvent("a1", {
		type: "command_output",
		// omp 输出带终端颜色序列，落库前必须清掉，否则卡片里是乱码。
		text: "\u001b[38;5;243mContext window\u001b[39m: 1000000 tokens (1% used)\n",
	});

	const message = runtime.transcript.messages.at(-1);
	assert(message);
	assert.equal(message.role, "system");
	assert.equal(message.text, "Context window: 1000000 tokens (1% used)");
	assert.equal(message.meta?.type, "commandOutput");
	assert.equal(message.meta?.command, "context");
	// 标签由 sendPrompt 在收到 prompt 响应时清理，事件层只读不消费。
	assert.equal(runtime.lastLocalCommand, "context");

	// 空白输出不造消息；同一条命令的第二帧仍带命令名。
	inner.handlePiEvent("a1", { type: "command_output", text: "  \n" });
	inner.handlePiEvent("a1", { type: "command_output", text: "No background jobs running." });
	assert.equal(runtime.transcript.messages.length, 2);
	const second = runtime.transcript.messages.at(-1);
	assert.equal(second?.meta?.type, "commandOutput");
	assert.equal(second?.meta?.command, "context");
});

// ── 命令目录推送 ──────────────────────────────────────

test("available_commands_update 归一化后推送到 agents:command-catalog，不落时间线", () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "idle"));
	inner.agents.set("a1", runtime);
	const emit = vi.fn();
	inner.emit = emit;

	inner.handlePiEvent("a1", {
		type: "available_commands_update",
		commands: [
			{
				name: "fast",
				description: "Toggle priority service tier",
				source: "builtin",
				input: { hint: "[on|off|status]" },
				subcommands: [{ name: "on", description: "Enable" }],
			},
			{ name: "" },
		],
	});

	assert.equal(emit.mock.calls.length, 1);
	const [channel, payload] = emit.mock.calls[0] as [string, { agentId: string; commands: unknown[] }];
	assert.equal(channel, ipcChannels.agentsCommandCatalog);
	assert.equal(payload.agentId, "a1");
	assert.deepEqual(payload.commands, [
		{
			name: "fast",
			description: "Toggle priority service tier",
			source: "builtin",
			inputHint: "[on|off|status]",
			subcommands: [{ name: "on", description: "Enable" }],
		},
	]);
	// 目录更新是元数据，不应污染会话时间线
	assert.equal(runtime.transcript.messages.length, 0);
});
