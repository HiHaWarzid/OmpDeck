import assert from "node:assert/strict";
import { test, vi } from "vitest";

import type { AgentStatus, AgentTab } from "../../shared/types";
import { AgentManager } from "./AgentManager";
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
		undefined,
		undefined,
		undefined,
		timeoutMs,
	);
}

type Internals = {
	agents: Map<string, TestRuntime>;
	scheduleEmptyResponseFallback(runtime: TestRuntime): void;
	clearEmptyResponseTimer(runtime: TestRuntime): void;
	handlePiEvent(agentId: string, event: unknown): void;
	emitStateNow(): void;
	emptyResponseTimers: Map<string, NodeJS.Timeout>;
};

function internals(m: AgentManager): Internals {
	return m as unknown as Internals;
}

test("agent_start 后清空兜底，timer 不再触发", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.scheduleEmptyResponseFallback(runtime);
		assert.equal(inner.emptyResponseTimers.has("a1"), true);

		inner.handlePiEvent("a1", { type: "agent_start" });
		assert.equal(inner.emptyResponseTimers.has("a1"), false);

		vi.advanceTimersByTime(200);
		assert.notEqual(runtime.tab.status, "error");
	} finally {
		vi.useRealTimers();
	}
});

test("message_start(assistant) 后清空兜底", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.scheduleEmptyResponseFallback(runtime);
		inner.handlePiEvent("a1", {
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		});
		assert.equal(inner.emptyResponseTimers.has("a1"), false);

		vi.advanceTimersByTime(200);
		assert.notEqual(runtime.tab.status, "error");
	} finally {
		vi.useRealTimers();
	}
});

test("auto_retry_start 也清空兜底（视为上游在重试）", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.scheduleEmptyResponseFallback(runtime);
		inner.handlePiEvent("a1", {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "",
		});
		assert.equal(inner.emptyResponseTimers.has("a1"), false);

		vi.advanceTimersByTime(200);
		assert.notEqual(runtime.tab.status, "error");
	} finally {
		vi.useRealTimers();
	}
});

test("窗口内无流式信号 → 兜底触发，落 error + lastError", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.scheduleEmptyResponseFallback(runtime);
		vi.advanceTimersByTime(80);
		assert.equal(runtime.tab.status, "error", "超时后 status 必须为 error");
		assert.ok(runtime.tab.lastError?.includes("Provider"));
	} finally {
		vi.useRealTimers();
	}
});

test("agent_end 也清空兜底（run 结束后 timer 立即释放）", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "running"));
		inner.agents.set("a1", runtime);

		inner.scheduleEmptyResponseFallback(runtime);
		inner.handlePiEvent("a1", { type: "agent_end", messages: [] });
		assert.equal(inner.emptyResponseTimers.has("a1"), false);

		vi.advanceTimersByTime(200);
		assert.notEqual(runtime.tab.status, "error");
	} finally {
		vi.useRealTimers();
	}
});

test("status 已非 running 时 timer 触发也不报错（防御）", () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager(60);
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "idle"));
		inner.agents.set("a1", runtime);

		inner.scheduleEmptyResponseFallback(runtime);
		vi.advanceTimersByTime(80);
		assert.equal(runtime.tab.status, "idle", "status 非 running 时兜底不应当场落 error");
	} finally {
		vi.useRealTimers();
	}
});
