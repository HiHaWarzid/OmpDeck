import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "./AgentManager";
import { createTranscriptState, type AgentTranscriptState } from "./agentTranscript";
import { createRunState, type AgentRunState } from "./agentRunState";
import type { ConfigManager } from "../config/ConfigManager";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AgentStatus, AgentTab } from "../../shared/types";

vi.mock("electron", () => ({
	app: { getPath: () => "C:/tmp", getName: () => "OmpDeck", getVersion: () => "0.0.0", isPackaged: false, on: () => {} },
	BrowserWindow: class {},
	Notification: class {
		static isSupported() {
			return false;
		}
		show() {}
	},
	shell: {},
	net: {},
}));

/**
 * abort 的流式闸门行为测试。
 *
 * 取代原先对 AgentManager.ts 做正则的「源码契约测试」：那类断言在方法改名时失败、
 * 在方法被改成空实现时照样通过。这里改为驱动真实方法，断言用户可见的结果——
 * abort 后残留 delta 不得进入转录，且下一轮 agent_start 后必须恢复放行。
 */

type Harness = {
	manager: AgentManager;
	agents: Map<string, TestRuntime>;
	handlePiEvent(agentId: string, event: unknown): void;
	ipc: Array<{ channel: string; payload: unknown }>;
};

type TestRuntime = {
	tab: AgentTab;
	process: {
		client: {
			request: (req: unknown, timeoutMs?: number) => Promise<unknown>;
			sendRaw: (req: unknown) => void;
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
	userInitiatedStop: boolean;
	autoRestartAttempted: boolean;
};

function makeHarness(): Harness {
	const ipc: Array<{ channel: string; payload: unknown }> = [];
	const manager = new AgentManager(
		() => undefined,
		() =>
			({
				isDestroyed: () => false,
				webContents: { send: (channel: string, payload: unknown) => ipc.push({ channel, payload }) },
			}) as unknown as Electron.BrowserWindow,
		{} as unknown as SettingsStore,
		{} as unknown as ConfigManager,
	);
	return {
		manager,
		agents: (manager as unknown as { agents: Map<string, TestRuntime> }).agents,
		handlePiEvent: (agentId, event) =>
			(manager as unknown as { handlePiEvent(id: string, e: unknown): void }).handlePiEvent(agentId, event),
		ipc,
	};
}

function makeTab(id: string, status: AgentStatus): AgentTab {
	return { id, projectId: "p1", cwd: "C:/work", title: `${id} agent`, status, createdAt: 1 };
}

function makeRuntime(tab: AgentTab): TestRuntime {
	return {
		tab,
		process: {
			client: {
				request: async () => ({ success: true }),
				sendRaw: () => {},
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
		userInitiatedStop: false,
		autoRestartAttempted: false,
	};
}

/** 流式文本增量：abort 后这类事件必须被闸门拦下。 */
function textDeltaEvent(text: string) {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: text },
	};
}

describe("abort stream gate", () => {
	it("abort seals the run and keeps the stop feedback out of the transcript", async () => {
		const { manager, agents, ipc } = makeHarness();
		const runtime = makeRuntime(makeTab("a1", "running"));
		agents.set("a1", runtime);

		await manager.abort("a1");

		// 停止反馈走 toast（notice 通道），不再往时间线塞系统卡片
		expect(runtime.transcript.messages).toHaveLength(0);
		expect(ipc.some((entry) => entry.channel.includes("notice"))).toBe(true);
		// 闸门封印 + 等待 abort settled
		expect(runtime.run.streamGate.waitingForAbortSettled).toBe(true);
		expect(runtime.tab.status).toBe("idle");
	});

	it("residual deltas after abort never reach the transcript", async () => {
		const { manager, agents, handlePiEvent } = makeHarness();
		const runtime = makeRuntime(makeTab("a1", "running"));
		agents.set("a1", runtime);

		await manager.abort("a1");
		handlePiEvent("a1", textDeltaEvent("ghost"));
		handlePiEvent("a1", { type: "tool_execution_start", toolName: "bash", toolCallId: "t1" });

		expect(runtime.transcript.messages).toHaveLength(0);
	});

	it("a settled abort followed by a new run unseals the gate and streams again", async () => {
		const { manager, agents, handlePiEvent } = makeHarness();
		const runtime = makeRuntime(makeTab("a1", "running"));
		agents.set("a1", runtime);

		await manager.abort("a1");
		handlePiEvent("a1", { type: "agent_settled" });
		// settled 之后闸门按设计仍封印：必须等到下一轮 agent_start 才放行
		handlePiEvent("a1", textDeltaEvent("still-ghost"));
		expect(runtime.transcript.messages).toHaveLength(0);

		handlePiEvent("a1", { type: "agent_start" });
		handlePiEvent("a1", textDeltaEvent("fresh"));
		expect(runtime.transcript.messages.map((message) => message.text)).toEqual(["fresh"]);
	});

	it("without a prior abort, deltas stream straight into the transcript", () => {
		const { agents, handlePiEvent } = makeHarness();
		const runtime = makeRuntime(makeTab("a1", "idle"));
		agents.set("a1", runtime);

		handlePiEvent("a1", textDeltaEvent("hello"));

		expect(runtime.transcript.messages.map((message) => message.text)).toEqual(["hello"]);
	});
});
