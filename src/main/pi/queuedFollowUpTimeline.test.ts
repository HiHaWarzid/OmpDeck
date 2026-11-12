import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

import type { AgentQueuedMessages, AgentStatus, AgentTab } from "../../shared/types";
import { AgentManager, type AgentConfigDeps } from "./AgentManager";
import { createTranscriptState, type AgentTranscriptState } from "./agentTranscript";
import { createRunState, type AgentRunState } from "./agentRunState";
import type { SettingsStore } from "../settings/SettingsStore";

vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
	BrowserWindow: class {},
	Notification: class {},
	shell: {},
	net: {},
}));

// 发送路径会挂空响应兜底/消息节流定时器；用假定时器隔离，避免跨用例串扰。
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

type StubData = { get_state?: AgentQueuedMessages; [command: string]: unknown };

type TestRuntime = {
	tab: AgentTab;
	slot: {
		process: {
			isRunning: () => boolean;
			client: { request: (request: Record<string, unknown>) => Promise<unknown> };
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
	appliedConfigEpoch: number;
	deferredFollowUps?: Array<{
		text: string;
		queueText: string;
		meta: Record<string, unknown>;
		images?: Array<{ type: string; data: string; mimeType: string }>;
	}>;
	withdrawnFollowUps?: Map<string, number>;
	lastQueuedSnapshot?: AgentQueuedMessages;
	lastQueueUpdateAt?: number;
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

/** get_state 回放固定队列快照；其它命令走 dataByCommand，未命中则返回空 data。 */
function makeRuntime(tab: AgentTab, dataByCommand: StubData): TestRuntime {
	return {
		tab,
		slot: {
			process: {
				isRunning: () => true,
				client: {
					request: async (request) => {
						const command = String(request.type);
						if (command === "prompt") {
							return { type: "response", command, success: true, data: {} };
						}
						if (command === "get_state") {
							return {
								type: "response",
								command,
								success: true,
								data: { queuedMessages: dataByCommand.get_state },
							};
						}
						const data = dataByCommand[command];
						return {
							type: "response",
							command,
							success: true,
							data: data ?? { commands: [] },
						};
					},
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
		appliedConfigEpoch: 0,
		deferredFollowUps: [],
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
	handlePiEvent(agentId: string, event: unknown): void;
};

function internals(manager: AgentManager): Internals {
	return manager as unknown as Internals;
}

function lines(runtime: TestRuntime): string[] {
	return runtime.transcript.messages.map((message) => `${message.role}:${message.text}`);
}

/**
 * 「结束后排队」的 follow-up 尚未进入本轮上下文：时间线不能提前插入用户气泡，
 * 否则当前这轮回答被切成两段，看起来像消息已经发送并打断了回答。
 */
test("排队中的 follow-up 不落气泡，投递后才出现在时间线", async () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		get_state: { steering: [], followUp: ["等这轮跑完再补"] },
	});
	inner.agents.set("a1", runtime);

	const result = await manager.sendPrompt({
		agentId: "a1",
		message: "等这轮跑完再补",
		streamingBehavior: "followUp",
	});

	assert.deepEqual(result, { accepted: true });
	assert.deepEqual(lines(runtime), [], "排队期间时间线不应出现用户气泡");
	assert.equal(runtime.deferredFollowUps?.length, 1);

	// omp 在本轮结束时把队列取出投递：queue_update 先于新一轮 agent_start 到达。
	inner.handlePiEvent("a1", { type: "queue_update", steering: [], followUp: [] });

	assert.deepEqual(lines(runtime), ["user:等这轮跑完再补"]);
	assert.equal(runtime.transcript.messages[0]?.meta?.streamingBehavior, "followUp");
	assert.equal(runtime.deferredFollowUps?.length, 0);
});

/** 本地 busy 快照过期时 omp 会立即开跑：那时队列里没有它，气泡必须马上补上。 */
test("队列里查不到时立即落气泡", async () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		get_state: { steering: [], followUp: [] },
	});
	inner.agents.set("a1", runtime);

	await manager.sendPrompt({
		agentId: "a1",
		message: "立即执行",
		streamingBehavior: "followUp",
	});

	assert.deepEqual(lines(runtime), ["user:立即执行"]);
	assert.equal(runtime.deferredFollowUps?.length, 0);
});

/** 撤回成功的消息不会再执行，队列清空事件不能把它补成一条幽灵气泡。 */
test("撤回排队 follow-up 后队列清空不补气泡", async () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		get_state: { steering: [], followUp: ["撤回我"] },
		remove_queued_message: { removed: true },
	});
	inner.agents.set("a1", runtime);

	await manager.sendPrompt({ agentId: "a1", message: "撤回我", streamingBehavior: "followUp" });
	const removal = await manager.removeQueuedMessage("a1", "撤回我", "followUp");
	inner.handlePiEvent("a1", { type: "queue_update", steering: [], followUp: [] });

	assert.deepEqual(removal, { removed: true });
	assert.deepEqual(lines(runtime), []);
});

/**
 * 中止+撤回队列（Esc）：omp 先清空队列并推 queue_update，再回响应。
 * 那次事件属于撤回本身，不能当成投递；恢复结果里的消息更不该留气泡。
 */
test("abortAndRestoreQueue 的队列清空事件不算投递", async () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		get_state: { steering: [], followUp: ["停止前排队"] },
	});
	inner.agents.set("a1", runtime);
	await manager.sendPrompt({ agentId: "a1", message: "停止前排队", streamingBehavior: "followUp" });

	const baseRequest = runtime.slot.process.client.request;
	runtime.slot.process.client.request = async (request) => {
		if (request.type === "abort_and_restore_queue") {
			inner.handlePiEvent("a1", { type: "queue_update", steering: [], followUp: [] });
			return {
				type: "response",
				command: "abort_and_restore_queue",
				success: true,
				data: { steering: [], followUp: [{ text: "停止前排队" }] },
			};
		}
		return baseRequest(request);
	};

	const restored = await manager.abortAndRestoreQueue("a1");

	assert.deepEqual(restored.followUp, [{ text: "停止前排队" }]);
	assert.deepEqual(lines(runtime), [], "撤回的消息不应在时间线留下气泡");
	assert.equal(runtime.deferredFollowUps?.length, 0);
});

/**
 * 撤回/中止可能落在准入对账（get_state 在途）的窗口里：那时离队的消息不是被投递，
 * 而是被我们自己拿回了输入框。时间线不能再补一条用户气泡。
 */
test("对账在途时撤回，不把撤回误判成投递", async () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		get_state: { steering: [], followUp: ["对账中撤回"] },
		remove_queued_message: { removed: true },
	});
	inner.agents.set("a1", runtime);

	const baseRequest = runtime.slot.process.client.request;
	let releaseState: (() => void) | undefined;
	const stateGate = new Promise<void>((resolve) => {
		releaseState = resolve;
	});
	runtime.slot.process.client.request = async (request) => {
		if (request.type === "get_state") {
			await stateGate;
			// 撤回已经生效：服务端队列此刻是空的，但对账早于撤回发出。
			return { type: "response", command: "get_state", success: true, data: { queuedMessages: { steering: [], followUp: [] } } };
		}
		return baseRequest(request);
	};

	const sending = manager.sendPrompt({
		agentId: "a1",
		message: "对账中撤回",
		streamingBehavior: "followUp",
	});
	await vi.advanceTimersByTimeAsync(0);
	await manager.removeQueuedMessage("a1", "对账中撤回", "followUp");
	releaseState?.();
	await sending;

	assert.deepEqual(lines(runtime), [], "撤回的消息不应在时间线留下气泡");
	assert.equal(runtime.deferredFollowUps?.length, 0);
});

/**
 * 同文案连发两条（例如两次只发图片）：omp 按 FIFO 投递，补气泡必须用先投递那条的
 * 图片/meta，否则两条气泡的内容会对调。
 */
test("同文案连发时按 FIFO 归属气泡内容", async () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		get_state: { steering: [], followUp: ["重试", "重试"] },
	});
	inner.agents.set("a1", runtime);

	const imageA = { type: "image" as const, data: "AAA", mimeType: "image/png" };
	const imageB = { type: "image" as const, data: "BBB", mimeType: "image/png" };
	await manager.sendPrompt({
		agentId: "a1",
		message: "重试",
		images: [imageA],
		streamingBehavior: "followUp",
	});
	await manager.sendPrompt({
		agentId: "a1",
		message: "重试",
		images: [imageB],
		streamingBehavior: "followUp",
	});
	assert.equal(runtime.deferredFollowUps?.length, 2);

	// 第一条离队 = 先投递的那条（imageA）。
	inner.handlePiEvent("a1", { type: "queue_update", steering: [], followUp: ["重试"] });
	assert.equal(runtime.transcript.messages.length, 1);
	assert.equal(runtime.transcript.messages[0]?.images?.[0]?.data, "AAA");

	inner.handlePiEvent("a1", { type: "queue_update", steering: [], followUp: [] });
	assert.equal(runtime.transcript.messages.length, 2);
	assert.equal(runtime.transcript.messages[1]?.images?.[0]?.data, "BBB");
});

/** 撤回 steering 队列里同文案的消息，不能连坐摘掉 follow-up 的快照。 */
test("撤回 steering 不影响同文案的 follow-up 快照", async () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		get_state: { steering: [], followUp: ["继续"] },
		remove_queued_message: { removed: true },
	});
	inner.agents.set("a1", runtime);

	await manager.sendPrompt({ agentId: "a1", message: "继续", streamingBehavior: "followUp" });
	assert.equal(runtime.deferredFollowUps?.length, 1);

	await manager.removeQueuedMessage("a1", "继续", "steering");
	assert.equal(runtime.deferredFollowUps?.length, 1, "steering 撤回不能动 follow-up 快照");

	inner.handlePiEvent("a1", { type: "queue_update", steering: [], followUp: [] });
	assert.deepEqual(lines(runtime), ["user:继续"]);
});

/** prompt 响应超时/断线时结果未知：omp 可能已收下并投递，时间线不能永久缺这条消息。 */
test("投递结果未知时补气泡而不是静默丢弃", async () => {
	const manager = makeManager();
	const inner = internals(manager);
	const runtime = makeRuntime(makeTab("a1", "running"), {
		get_state: { steering: [], followUp: ["断线前排队"] },
	});
	inner.agents.set("a1", runtime);
	const baseRequest = runtime.slot.process.client.request;
	runtime.slot.process.client.request = async (request) => {
		if (request.type === "prompt") throw new Error("管道已关闭");
		return baseRequest(request);
	};

	const result = await manager.sendPrompt({
		agentId: "a1",
		message: "断线前排队",
		streamingBehavior: "followUp",
	});

	assert.deepEqual(result, { accepted: false, error: "管道已关闭", delivery: "unknown" });
	assert.equal(runtime.transcript.messages[0]?.role, "user");
	assert.equal(runtime.transcript.messages[0]?.text, "断线前排队");
	assert.equal(runtime.transcript.messages[1]?.role, "error");
});
