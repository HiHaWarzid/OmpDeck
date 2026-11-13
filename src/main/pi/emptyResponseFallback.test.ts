import assert from "node:assert/strict";
import { test, vi } from "vitest";

import type { AgentStatus, AgentTab } from "../../shared/types";
import { AgentManager } from "./AgentManager";
import { createNullAgentEventSink } from "./agentEventSink";
import { createTranscriptState } from "./agentTranscript";
import { createRunState } from "./agentRunState";
import type { AgentConfigDeps } from "./AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";

vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
	BrowserWindow: class {},
	Notification: class {},
	shell: {},
	net: {},
}));

/** 本测试只触达 AgentRuntime 内部字段的一个子集；用最小形状 + 双断言。 */
type TestRuntime = {
	tab: AgentTab;
	slot: { process: { client: { request: (req: unknown) => Promise<unknown> } } };
	transcript: ReturnType<typeof createTranscriptState>;
	run: ReturnType<typeof createRunState>;
	toolStateSequence: number;
	activeToolCalls: Map<string, string>;
	toolExecuting: string | null;
	runtimeStateSeq: number;
	pendingUIRequests: Map<string, { method: string; title: string }>;
	rpcLogging: boolean;
	compacting: boolean;
	rpcCompacting: boolean;
	modelRefreshing: boolean;
	autoRestartAttempted: boolean;
	supervisor?: unknown;
};

function makeRuntime(tab: AgentTab): TestRuntime {
	return {
		tab,
		slot: { process: { client: { request: async () => ({ success: true }) } } },
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

function makeManager(timeoutMs = 60): AgentManager {
	return new AgentManager(
		() => undefined,
		() => null,
		{} as unknown as SettingsStore,
		{} as unknown as AgentConfigDeps,
		createNullAgentEventSink(),
		undefined,
		undefined,
		undefined,
		timeoutMs,
	);
}

/**
 * 只暴露监督器的公开接口：窗口布防走 `scheduleEmptyResponse`（prompt accepted 用的入口），
 * 撤销走真实的 `handlePiEvent` 事件路径。断言全部落在可观察行为（status/错误卡片）上，
 * 不再读取定时器容器——那是实现细节，收进 agentRunSupervisor 后就不该被测试穿透。
 */
type Internals = {
	agents: Map<string, TestRuntime>;
	runSupervisor(runtime: TestRuntime): { scheduleEmptyResponse(): void };
	handlePiEvent(agentId: string, event: unknown): void;
};

function internals(m: AgentManager): Internals {
	return m as unknown as Internals;
}

test("agent_start 后清空兜底窗口，到点不再报空响应", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.runSupervisor(runtime).scheduleEmptyResponse();
		inner.handlePiEvent("a1", { type: "agent_start" });

		vi.advanceTimersByTime(200);
		assert.notEqual(runtime.tab.status, "error");
		assert.equal(runtime.tab.lastError, undefined);
	} finally {
		vi.useRealTimers();
	}
});

test("message_start(assistant) 后清空兜底窗口", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.runSupervisor(runtime).scheduleEmptyResponse();
		inner.handlePiEvent("a1", {
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		});

		vi.advanceTimersByTime(200);
		assert.notEqual(runtime.tab.status, "error");
		assert.equal(runtime.tab.lastError, undefined);
	} finally {
		vi.useRealTimers();
	}
});

test("auto_retry_start 也清空兜底窗口（视为上游在重试）", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.runSupervisor(runtime).scheduleEmptyResponse();
		inner.handlePiEvent("a1", {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "",
		});

		vi.advanceTimersByTime(200);
		assert.notEqual(runtime.tab.status, "error");
		assert.equal(runtime.tab.lastError, undefined);
	} finally {
		vi.useRealTimers();
	}
});

test("窗口内无流式信号 → 兜底触发，落 error + lastError + 错误卡片", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.runSupervisor(runtime).scheduleEmptyResponse();
		vi.advanceTimersByTime(59);

		assert.equal(runtime.tab.status, "running", "窗口未到不得提前落 error");
		// 先取值再断言：assert 的 asserts 签名会收窄「传入的那个变量」的类型，
		// 直接传 runtime.tab.lastError 会让后续读取退化成 never。
		const errorBeforeWindow = runtime.tab.lastError;
		assert.equal(errorBeforeWindow, undefined, "窗口未到不得写入 lastError");

		vi.advanceTimersByTime(1);
		assert.equal(runtime.tab.status, "error", "超时后 status 必须为 error");
		// 上方 assert.equal 的 asserts 签名把 lastError 收窄为 undefined，
		// 因此这里用显式标注的局部变量重新取值，避免拿到 never 类型。
		const errorText: string | undefined = runtime.tab.lastError;
		assert.ok(errorText?.includes("Provider"));
		const last = runtime.transcript.messages.at(-1);
		assert.equal(last?.role, "error");
		assert.equal(last?.text, errorText);

		// 只触发一次：再推进时钟不会追加第二张卡片
		vi.advanceTimersByTime(500);
		assert.equal(runtime.transcript.messages.length, 1);
	} finally {
		vi.useRealTimers();
	}
});

test("agent_end 也清空兜底窗口（run 结束后窗口立即释放）", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.runSupervisor(runtime).scheduleEmptyResponse();
		inner.handlePiEvent("a1", { type: "agent_end", messages: [] });

		vi.advanceTimersByTime(200);
		assert.notEqual(runtime.tab.status, "error");
		assert.equal(runtime.tab.lastError, undefined);
	} finally {
		vi.useRealTimers();
	}
});

test("status 已非 running 时窗口到点不落 error（防御）", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "idle"));
		inner.agents.set("a1", runtime);

		inner.runSupervisor(runtime).scheduleEmptyResponse();
		vi.advanceTimersByTime(80);
		assert.equal(runtime.tab.status, "idle", "status 非 running 时兜底不应当场落 error");
		assert.equal(runtime.transcript.messages.length, 0);
	} finally {
		vi.useRealTimers();
	}
});
