import assert from "node:assert/strict";
import { test, vi } from "vitest";

import type { AgentStatus, AgentTab } from "../../shared/types";
import { AgentManager } from "./AgentManager";
import { createTranscriptState, type AgentTranscriptState } from "./agentTranscript";
import { createRunState, type AgentRunState } from "./agentRunState";
import type { AgentConfigDeps } from "./AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";

vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
	BrowserWindow: class {},
	Notification: class {},
	shell: {},
	net: {},
}));

type TestRuntime = {
	tab: AgentTab;
	slot: {
		process: {
			isRunning(): boolean;
			client: { request: (req: { type?: string }, timeoutMs?: number) => Promise<unknown> };
		};
	};
	transcript: AgentTranscriptState;
	run: AgentRunState;
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
	lastLocalCommand?: string;
};

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

/** prompt 响应按调用顺序出队；命令目录固定为空，让本地命令不被误判成扩展命令。 */
function makeRuntime(tab: AgentTab, promptResponses: unknown[]): TestRuntime {
	const queue = [...promptResponses];
	return {
		tab,
		slot: {
			process: {
				isRunning: () => true,
				client: {
					request: async (req) =>
						req.type === "prompt"
							? queue.shift()
							: { type: "response", command: req.type, success: true, data: { commands: [] } },
				},
			},
		},
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

function makeManager(): AgentManager {
	return new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({ rpcTimeout: 5_000 }) } as unknown as SettingsStore,
		{} as unknown as AgentConfigDeps,
		undefined,
		undefined,
		undefined,
		60,
	);
}

type Internals = {
	agents: Map<string, TestRuntime>;
	emptyResponseTimers: Map<string, NodeJS.Timeout>;
	getRuntimeState(agentId: string): Promise<unknown>;
};

function internals(m: AgentManager): Internals {
	return m as unknown as Internals;
}

/** omp 对本地斜线命令的响应：success + agentInvoked:false，之后没有 agent_end。 */
test("本地斜线命令(agentInvoked:false)立即收口到 idle，不再挂空响应兜底", async () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager();
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "idle"), [
			{ type: "response", command: "prompt", success: true, data: { agentInvoked: false } },
		]);
		inner.agents.set("a1", runtime);

		const result = await manager.sendPrompt({ agentId: "a1", message: "/context" });

		assert.deepEqual(result, { accepted: true });
		assert.equal(runtime.tab.status, "idle");
		assert.equal(inner.emptyResponseTimers.has("a1"), false);
		// 不能把本地命令误报成 provider 故障：只有用户自己那条消息。
		assert.deepEqual(
			runtime.transcript.messages.map((message) => message.role),
			["user"],
		);
		assert.equal(runtime.lastLocalCommand, undefined);

		// 兜底即使被别处重启，也不能再写错误消息。
		vi.advanceTimersByTime(200);
		assert.equal(runtime.tab.status, "idle");
	} finally {
		vi.useRealTimers();
	}
});

/** 旧版 pi 不返回 agentInvoked：仍按 provider 请求处理，保留空响应兜底。 */
test("缺少 agentInvoked 时仍走空响应兜底", async () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager();
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "idle"), [
			{ type: "response", command: "prompt", success: true, data: {} },
		]);
		inner.agents.set("a1", runtime);

		const result = await manager.sendPrompt({ agentId: "a1", message: "/context" });

		assert.deepEqual(result, { accepted: true });
		assert.equal(runtime.tab.status, "running");
		assert.equal(inner.emptyResponseTimers.has("a1"), true);
	} finally {
		vi.useRealTimers();
	}
});

/** 回归：本地命令不能清掉另一条在途 prompt 的空响应兜底，也不能用旧快照覆盖状态。 */
test("斜线命令不干扰在途 prompt 的空响应兜底", async () => {
	vi.useFakeTimers();
	try {
		const manager = makeManager();
		const inner = internals(manager);
		const runtime = makeRuntime(makeTab("a1", "idle"), [
			{ type: "response", command: "prompt", success: true, data: {} },
			{ type: "response", command: "prompt", success: true, data: { agentInvoked: false } },
		]);
		inner.agents.set("a1", runtime);

		await manager.sendPrompt({ agentId: "a1", message: "看下 README" });
		assert.equal(inner.emptyResponseTimers.has("a1"), true);

		await manager.sendPrompt({ agentId: "a1", message: "/context" });

		// 前一条 prompt 仍在等 provider 流：兜底必须保留，状态保持 running。
		assert.equal(inner.emptyResponseTimers.has("a1"), true);
		assert.equal(runtime.tab.status, "running");
	} finally {
		vi.useRealTimers();
	}
});
