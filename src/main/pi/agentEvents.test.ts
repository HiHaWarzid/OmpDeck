import assert from "node:assert/strict";
import { test, vi } from "vitest";

import type {
	AgentManagerEvent,
	AgentStatus,
	AgentTab,
	ChatMessage,
} from "../../shared/types";
import { AgentManager, isRpcLogWorthy } from "./AgentManager";
import { createStreamGateState, type StreamGateState } from "./streamGate";
import type { ConfigManager } from "../config/ConfigManager";
import type { SettingsStore } from "../settings/SettingsStore";

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
	process: {
		client: {
			request: (req: unknown, timeoutMs?: number) => Promise<unknown>;
		};
	};
	messages: ChatMessage[];
	activeAssistantMessageId?: string;
	toolMessageIds: Map<string, string>;
	streamingThinking: string;
	thinkingStartedAt?: number;
	thinkingEndedAt?: number;
	toolStateSequence: number;
	activeToolCalls: Map<string, string>;
	toolExecuting: string | null;
	runtimeStateSeq: number;
	streamGate: StreamGateState;
	settleCheckTimer?: NodeJS.Timeout;
	messageFlushTimer?: NodeJS.Timeout;
	pendingMessage: boolean;
	messageDirtyFrom: number;
	pendingUIRequests: Map<string, { method: string; title: string }>;
	rpcLogging: boolean;
	compacting: boolean;
	rpcCompacting: boolean;
	modelRefreshing: boolean;
	userInitiatedStop: boolean;
	autoRestartAttempted: boolean;
	recentlyAborted: boolean;
	abortedDuringAsk: boolean;
};

/** 构造带全部默认字段的最小 runtime；client.request 默认抛错（RPC 路径由各测试按需覆盖）。 */
function makeRuntime(
	tab: AgentTab,
	client?: TestRuntime["process"]["client"],
): TestRuntime {
	return {
		tab,
		process: {
			client: client ?? {
				request: async () => {
					throw new Error("RPC stub not needed");
				},
			},
		},
		messages: [],
		toolMessageIds: new Map(),
		streamingThinking: "",
		toolStateSequence: 0,
		activeToolCalls: new Map(),
		toolExecuting: null,
		runtimeStateSeq: 0,
		streamGate: createStreamGateState(),
		pendingMessage: false,
		messageDirtyFrom: 0,
		pendingUIRequests: new Map(),
		rpcLogging: false,
		compacting: false,
		rpcCompacting: false,
		modelRefreshing: false,
		userInitiatedStop: false,
		autoRestartAttempted: false,
		recentlyAborted: false,
		abortedDuringAsk: false,
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

/** 最小依赖桩构造 AgentManager（本测试不调用设置/配置读取）。 */
function makeManager(): AgentManager {
	return new AgentManager(
		() => undefined, // getProject：不涉及项目解析
		() => null, // getWindow：不推送 IPC
		{} as unknown as SettingsStore, // 测试桩：不读写设置
		{} as unknown as ConfigManager, // 测试桩：不读写配置
	);
}

/**
 * 测试需触达 private 成员（agents/emitStateNow/addMessage/handlePiEvent 等）：
 * TS 的 private 仅是编译期约束，这里经 unknown 双断言收窄到本测试所需形状。
 */
type ManagerInternals = {
	agents: Map<string, TestRuntime>;
	emitStateNow(): void;
	addMessage(runtime: TestRuntime, role: string, text: string): void;
	handlePiEvent(agentId: string, event: unknown): void;
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
	assert.equal(event.message.id, runtime.messages[0]?.id);
	assert.equal(event.message, runtime.messages[0]); // 与落库对象同构
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

	// 状态变化时只发变化的 agent；新出现的 agent 发首次状态，未变化的 agent 不发
	runtime.tab.status = "running";
	inner.agents.set("a2", makeRuntime(makeTab("a2", "idle")));
	inner.emitStateNow();
	assert.equal(events.length, 3);
	assert(events[1].type === "statusChanged");
	assert.equal(events[1].agentId, "a1");
	assert.equal(events[1].status, "running");
	assert(events[2].type === "statusChanged");
	assert.equal(events[2].agentId, "a2");
	assert.equal(events[2].status, "idle");
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
});
