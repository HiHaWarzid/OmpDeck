import { describe, expect, it, vi } from "vitest";
import { AgentManager, type AgentConfigDeps } from "./AgentManager";
import { createNullAgentEventSink } from "./agentEventSink";
import { AgentProcessSlot } from "./agentProcessSlot";
import { createRunState } from "./agentRunState";
import { createTranscriptState } from "./agentTranscript";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AgentStatus, AgentTab } from "../../shared/types";

vi.mock("electron", () => ({
	app: {
		getPath: () => "C:/tmp",
		getName: () => "OmpDeck",
		getVersion: () => "0.0.0",
		isPackaged: false,
		on: () => {},
	},
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
 * 「配置版本落后 → 重连会话」这条真实路径的行为测试。
 *
 * 该路径原先手写 starting → 替换 → 恢复选择 → idle，现在收进 ProcessReplacement 模块。
 * 这里驱动真实的 applyPendingConfig，断言用户可观察的结果：新进程起来后模型/思考档被恢复、
 * 会话回到 idle、锁被释放（否则后续 sendPrompt 会永远挂着），以及失败时落到可排查的 error。
 */

type TestRuntime = {
	tab: AgentTab;
	slot: AgentProcessSlot;
	transcript: ReturnType<typeof createTranscriptState>;
	run: ReturnType<typeof createRunState>;
	toolStateSequence: number;
	activeToolCalls: Map<string, string>;
	toolExecuting: string | null;
	runtimeStateSeq: number;
	pendingUIRequests: Map<string, unknown>;
	rpcLogging: boolean;
	compacting: boolean;
	rpcCompacting: boolean;
	modelRefreshing: boolean;
	autoRestartAttempted: boolean;
	appliedConfigEpoch: number;
	configApplyPromise?: Promise<void>;
	healingDeveloperRole?: boolean;
	lastModelSelection?: { provider?: string; modelId?: string; thinkingLevel?: string };
};

type Sent = Array<{ type: string; [key: string]: unknown }>;

function makeManager(): AgentManager {
	return new AgentManager(
		(id: string) =>
			id === "p1" ? { id: "p1", name: "p1", path: "C:/work", lastOpenedAt: 0 } : undefined,
		() => null,
		{ get: () => ({ rpcTimeout: 1_000 }) } as unknown as SettingsStore,
		{
			readOmpDefaultThinkingLevel: async () => undefined,
			trustStore: { decide: async () => undefined },
			disableDeveloperRole: async () => true,
		} as unknown as AgentConfigDeps,
		createNullAgentEventSink(),
		undefined,
		{ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
		undefined,
	);
}

/**
 * 用桩 process 建一个 idle 的 agent：get_state 报告会话正用 anthro/claude，
 * set_model 与 set_thinking_level 记录到 sent，便于断言恢复顺序。
 *
 * `failRestore` 让 set_model 回 success:false（模型不存在/未鉴权），
 * `processAlive:false` 模拟进程已退出（压缩重启场景），`compactThrows` 让 compact RPC 直接失败。
 */
function seedRuntime(
	manager: AgentManager,
	options: {
		status?: AgentStatus;
		failStart?: boolean;
		failRestore?: boolean;
		processAlive?: boolean;
		compactThrows?: boolean;
	} = {},
): { runtime: TestRuntime; sent: Sent } {
	const sent: Sent = [];
	const status = options.status ?? "idle";
	const tab = {
		id: "a1",
		projectId: "p1",
		cwd: "C:/work",
		title: "a1 agent",
		status,
		createdAt: 1,
		sessionPath: "C:/tmp/session.jsonl",
	} as AgentTab;

	const client = {
		request: async (req: { type: string }) => {
			sent.push(req as never);
			if (req.type === "compact" && options.compactThrows) {
				throw new Error("pi exited");
			}
			if (req.type === "set_model" && options.failRestore) {
				return { success: false, error: "model not available" };
			}
			if (req.type === "get_state") {
				return {
					success: true,
					data: {
						model: { provider: "anthropic", id: "claude-sonnet-4" },
						thinkingLevel: "high",
						sessionFile: "C:/tmp/session.jsonl",
					},
				};
			}
			return { success: true };
		},
		sendRaw: () => {},
	};
	const process = {
		client,
		on: () => {},
		off: () => {},
		isRunning: () => options.processAlive ?? true,
		getDiagnostics: () => null,
		start: async () => {
			if (options.failStart) throw new Error("spawn ENOENT");
			return client;
		},
		stop: async () => {},
	};
	const slot = new AgentProcessSlot(process as never);

	const runtime: TestRuntime = {
		tab,
		slot,
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
		appliedConfigEpoch: 0,
	};

	const agents = (manager as unknown as { agents: Map<string, TestRuntime> }).agents;
	agents.set("a1", runtime);
	// 让重连过程产生新的桩 process，而不是真的 spawn omp。
	(manager as unknown as Record<string, unknown>).createAgentProcess = () => process;
	return { runtime, sent };
}

function bumpConfigEpoch(manager: AgentManager): void {
	(manager as unknown as { configEpoch: number }).configEpoch += 1;
}

async function applyConfig(manager: AgentManager): Promise<void> {
	await (
		manager as unknown as { applyPendingConfig: (id: string, rt: TestRuntime) => Promise<void> }
	).applyPendingConfig("a1", (manager as unknown as { agents: Map<string, TestRuntime> }).agents.get("a1")!);
}

describe("applyPendingConfig", () => {
	it("重连后恢复模型与思考档，回到 idle 并释放锁", async () => {
		const manager = makeManager();
		const { runtime, sent } = seedRuntime(manager);
		bumpConfigEpoch(manager);

		await applyConfig(manager);

		// 恢复选择必须真的发出去，否则「只是保存了配置，会话悄悄换模型」。
		expect(sent.some((req) => req.type === "set_model")).toBe(true);
		expect(sent.some((req) => req.type === "set_thinking_level")).toBe(true);
		expect(runtime.tab.status).toBe("idle");
		// 锁必须释放：否则后续 sendPrompt 会永远 await 一个已完成的 promise。
		expect(runtime.configApplyPromise).toBeUndefined();
		// 陈旧错误必须被清掉，避免 UI 重连成功后仍展示上一次的报错。
		expect(runtime.tab.lastError).toBeUndefined();
	});

	it("重连失败时落 error、写入 lastError，并且仍然释放锁", async () => {
		const manager = makeManager();
		const { runtime } = seedRuntime(manager, { failStart: true });
		bumpConfigEpoch(manager);

		await applyConfig(manager);

		expect(runtime.tab.status).toBe("error");
		expect(runtime.tab.lastError).toContain("spawn ENOENT");
		expect(runtime.configApplyPromise).toBeUndefined();
	});

	it("会话不空闲时不重连，也不动锁", async () => {
		const manager = makeManager();
		const { runtime, sent } = seedRuntime(manager, { status: "running" });
		bumpConfigEpoch(manager);

		await applyConfig(manager);

		expect(sent.filter((req) => req.type === "get_state")).toHaveLength(0);
		expect(runtime.tab.status).toBe("running");
		expect(runtime.configApplyPromise).toBeUndefined();
	});

	it("恢复模型被拒时判为整次重连失败：落 error、写 lastError、不报「已重连」", async () => {
		const manager = makeManager();
		const { runtime, sent } = seedRuntime(manager, { failRestore: true });
		bumpConfigEpoch(manager);

		await applyConfig(manager);

		// 进程起来了但 set_model 失败：会话仍在用默认模型，不能算重连成功。
		expect(runtime.tab.status).toBe("error");
		expect(runtime.tab.lastError).toContain("model not available");
		expect(runtime.tab.lastError).not.toBeUndefined();
		expect(runtime.configApplyPromise).toBeUndefined();
		// 失败后不得再发 set_thinking_level：模型都没恢复，继续设置思考档只是噪音。
		expect(sent.filter((req) => req.type === "set_thinking_level")).toHaveLength(0);
		expect(
			runtime.transcript.messages.some((m) => m.role === "system"),
		).toBe(false);
		expect(runtime.transcript.messages.some((m) => m.role === "error")).toBe(true);
	});
});

describe("compact 触发的重连", () => {
	it("压缩期间进程已退出时按 lastModelSelection 重连并恢复选择", async () => {
		const manager = makeManager();
		const { runtime, sent } = seedRuntime(manager, {
			processAlive: false,
			compactThrows: true,
		});
		runtime.lastModelSelection = {
			provider: "anthropic",
			modelId: "claude-sonnet-4",
			thinkingLevel: "high",
		};

		const state = await manager.compact("a1");

		expect(sent.some((req) => req.type === "compact")).toBe(true);
		expect(sent.some((req) => req.type === "set_model")).toBe(true);
		expect(sent.some((req) => req.type === "set_thinking_level")).toBe(true);
		expect(runtime.tab.status).toBe("idle");
		expect(runtime.tab.lastError).toBeUndefined();
		// 压缩收口必须清标记，否则 UI 永远认为在压缩。
		expect(runtime.compacting).toBe(false);
		expect(runtime.rpcCompacting).toBe(false);
		expect(state).toBeTruthy();
	});

	/**
	 * 重连失败时 compact() 必须 reject：渲染层只要拿到 resolved promise 就弹
	 * 「上下文压缩完成」的成功 toast（App.compactAgent），而此刻会话其实不可用。
	 * 旧实现直接 `await this.reattachProcess(...)`，异常会自然冒出去；收进编排模块后
	 * 返回的是 ReplacementOutcome，丢掉它就会静默变成「成功」。
	 */
	it("重连失败时 compact() 抛错，且新 child 没起来落 closed", async () => {
		const manager = makeManager();
		const { runtime } = seedRuntime(manager, {
			processAlive: false,
			compactThrows: true,
			failStart: true,
		});
		runtime.lastModelSelection = { provider: "anthropic", modelId: "claude-sonnet-4" };

		await expect(manager.compact("a1")).rejects.toThrow("spawn ENOENT");

		// 没有活着的 child 可交互：停在 error 会让 UI 以为还能发消息。
		expect(runtime.tab.status).toBe("closed");
		expect(runtime.tab.lastError).toContain("spawn ENOENT");
		expect(runtime.compacting).toBe(false);
	});

	/**
	 * 新 child 起来了、只是 set_model 被拒：会话是活的，下一句话就能发出去。
	 * 这种失败必须落 error 而不是 closed，否则 UI 显示「已关闭」并让用户手动重启，
	 * 白白丢掉一段完全可以继续的上下文。
	 */
	it("只有模型恢复失败时落 error（会话仍可用），同样让 compact() 抛错", async () => {
		const manager = makeManager();
		const { runtime, sent } = seedRuntime(manager, {
			processAlive: false,
			compactThrows: true,
			failRestore: true,
		});
		runtime.lastModelSelection = { provider: "anthropic", modelId: "claude-sonnet-4" };

		await expect(manager.compact("a1")).rejects.toThrow("model not available");

		expect(runtime.tab.status).toBe("error");
		expect(runtime.tab.lastError).toContain("model not available");
		// 新 child 确实被拉起并尝试恢复过选择。
		expect(sent.some((req) => req.type === "set_model")).toBe(true);
	});
});
