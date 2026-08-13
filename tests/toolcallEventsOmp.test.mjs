import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/** thinkingEmitter 用 LatestByKeyEmitter；测试只验证工具状态路径，用最小 mock。 */
class LatestByKeyEmitter {
	constructor() {}
	push() {}
	flush() {}
	cancel() {}
	dispose() {}
}

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadAgentManager() {
	const registry = {};
	function sharedRequire(id) {
		if (id in registry) return registry[id];
		if (id === "electron") return { app: {}, Notification: class {} };
		if (id === "node:fs/promises") return { readFile: async () => "", writeFile: async () => {} };
		if (id === "node:fs") return { existsSync: () => false, statSync: () => ({ size: 0 }) };
		if (id === "node:path") return require("node:path").win32;
		if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
		if (id === "../../shared/ipc") return { ipcChannels: {} };
		if (id === "./PiProcess") return { PiProcess: class {} };
		if (id === "./bashResult") return { formatBashToolMessage: () => ({}) };
		if (id === "./messageContent") return { extractMessageText: (value) => String(value ?? "") };
		if (id === "./historyMessages") return { mergeHistoryWithPreservedMessages: (value) => value };
		if (id === "./LatestByKeyEmitter") return { LatestByKeyEmitter };
		if (id === "../wsl/WslPaths") return { createWslEnvironment: () => ({}) };
		return require(id);
	}

	function loadModule(filePath, filename) {
		const sandbox = {
			Buffer,
			clearTimeout,
			console: { log() {}, warn() {}, error() {} },
			exports: {},
			process: { ...process, platform: "win32" },
			setTimeout,
			require: sharedRequire,
		};
		vm.runInNewContext(transpile(filePath), sandbox, { filename });
		return sandbox.exports;
	}

	registry["../../shared/todo"] = loadModule("src/shared/todo.ts", "todo.ts");
	// 工具状态归并必须用真实实现：并行工具 start/end 的配对逻辑是本次测试的核心
	registry["../../shared/toolRuntimeState"] = loadModule("src/shared/toolRuntimeState.ts", "toolRuntimeState.ts");
	registry["./sessionEntryIds"] = loadModule("src/main/pi/sessionEntryIds.ts", "sessionEntryIds.ts");
	registry["./messageTextUtils"] = loadModule("src/main/pi/messageTextUtils.ts", "messageTextUtils.ts");
	registry["./askQuestionCard"] = loadModule("src/main/pi/askQuestionCard.ts", "askQuestionCard.ts");
	registry["./messageTimeline"] = loadModule("src/main/pi/messageTimeline.ts", "messageTimeline.ts");
	registry["./streamGate"] = loadModule("src/main/pi/streamGate.ts", "streamGate.ts");
	registry["./sessionJsonl"] = loadModule("src/main/pi/sessionJsonl.ts", "sessionJsonl.ts");
	registry["../perf"] = loadModule("src/main/perf.ts", "perf.ts");

	return loadModule("src/main/pi/AgentManager.ts", "AgentManager.ts");
}

function createManager(AgentManager) {
	return new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({ rpcTimeout: 60_000 }) },
		{},
	);
}

function makeRuntime() {
	return {
		process: { client: { request: async () => ({ success: true, data: {} }) } },
		tab: { id: "agent", projectId: "project", title: "Agent", status: "running", createdAt: 1 },
		messages: [],
		toolMessageIds: new Map(),
		activeToolCalls: new Map(),
		toolExecuting: null,
		toolStateSequence: 0,
		streamingThinking: "",
		thinkingStartedAt: undefined,
		thinkingEndedAt: undefined,
		activeAssistantMessageId: undefined,
		pendingMessage: false,
		messageDirtyFrom: 0,
		messageFlushTimer: undefined,
		streamGate: { sealed: false, waitingForAbortSettled: false },
		currentTodos: [],
		abortedDuringAsk: false,
		recentlyAborted: false,
		rpcCompacting: false,
		compacting: false,
	};
}

/** 构造 omp 17.2.15 实测形态的 message_update.toolcall 事件。 */
function toolcallEvent(type, overrides = {}) {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "我需要运行命令" },
				{ type: "toolCall", id: "call_abc", name: "bash", arguments: { command: "pwd" } },
			],
		},
		assistantMessageEvent: {
			type,
			contentIndex: 1,
			toolCall: {
				type: "toolCall",
				id: "call_abc",
				name: "bash",
				arguments: { command: "pwd" },
			},
			...overrides,
		},
	};
}

test("toolcall_start 置 isExecutingTool 并创建 running 工具卡片", () => {
	const { AgentManager } = loadAgentManager();
	const manager = createManager(AgentManager);
	const runtime = makeRuntime();
	manager.agents.set("agent", runtime);

	manager.handleAssistantMessageEvent(runtime, toolcallEvent("toolcall_start"));

	assert.equal(runtime.toolExecuting, "bash");
	assert.equal(runtime.toolStateSequence, 1);
	// 工具卡片消息存在且为 running 状态
	const card = runtime.messages.find((m) => m.role === "tool");
	assert.ok(card, "should create a tool card message");
	assert.equal(card.meta?.status, "running");
	assert.equal(card.meta?.toolName, "bash");
	assert.equal(runtime.toolMessageIds.get("call_abc"), card.id);
});

test("toolcall_end 清除执行状态并标记卡片 done", () => {
	const { AgentManager } = loadAgentManager();
	const manager = createManager(AgentManager);
	const runtime = makeRuntime();
	manager.agents.set("agent", runtime);

	manager.handleAssistantMessageEvent(runtime, toolcallEvent("toolcall_start"));
	manager.handleAssistantMessageEvent(runtime, toolcallEvent("toolcall_end"));

	assert.equal(runtime.toolExecuting, null);
	const card = runtime.messages.find((m) => m.role === "tool");
	assert.equal(card.meta?.status, "done");
	// 卡片复用同一 toolCallId，不重复创建
	assert.equal(runtime.messages.filter((m) => m.role === "tool").length, 1);
});

test("并行工具：仅最后一个 toolcall_end 才清除执行状态", () => {
	const { AgentManager } = loadAgentManager();
	const manager = createManager(AgentManager);
	const runtime = makeRuntime();
	manager.agents.set("agent", runtime);

	const bash = toolcallEvent("toolcall_start");
	const read = toolcallEvent("toolcall_start", {
		contentIndex: 2,
		toolCall: { type: "toolCall", id: "call_read", name: "read", arguments: { path: "a.ts" } },
	});
	manager.handleAssistantMessageEvent(runtime, bash);
	manager.handleAssistantMessageEvent(runtime, read);
	assert.equal(runtime.toolExecuting, "read", "并行批次执行中");
	assert.equal(runtime.activeToolCalls.size, 2);

	// 第一个工具结束：仍在执行
	manager.handleAssistantMessageEvent(
		runtime,
		toolcallEvent("toolcall_end", {
			contentIndex: 1,
			toolCall: { type: "toolCall", id: "call_abc", name: "bash", arguments: { command: "pwd" } },
		}),
	);
	assert.equal(runtime.toolExecuting, "read", "还剩一个工具时保持 executing");

	// 最后一个工具结束：清除
	manager.handleAssistantMessageEvent(
		runtime,
		toolcallEvent("toolcall_end", {
			contentIndex: 2,
			toolCall: { type: "toolCall", id: "call_read", name: "read", arguments: { path: "a.ts" } },
		}),
	);
	assert.equal(runtime.toolExecuting, null);
});

test("agent_end 的 toolResult 消息回填工具卡片输出", () => {
	const { AgentManager } = loadAgentManager();
	const manager = createManager(AgentManager);
	const runtime = makeRuntime();
	manager.agents.set("agent", runtime);

	manager.handleAssistantMessageEvent(runtime, toolcallEvent("toolcall_start"));
	manager.handleAssistantMessageEvent(runtime, toolcallEvent("toolcall_end"));

	// omp agent_end.messages 中的 toolResult 消息（role=toolResult，带 toolCallId）
	manager.completeToolResultsFromMessages(runtime, {
		messages: [
			{
				role: "toolResult",
				toolCallId: "call_abc",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "D:\\repo\n" }],
			},
		],
	});

	const card = runtime.messages.find((m) => m.role === "tool");
	assert.equal(card.meta?.status, "done");
	assert.equal(card.meta?.result, "D:\\repo\n");
	assert.equal(card.meta?.isError, false);
	// 展开正文（detailText）必须随结果重建，否则卡片展开看不到输出
	assert.match(String(card.meta?.detailText), /结果：\nD:\\repo\n/);
});

test("agent_end 的 toolResult 错误标记卡片 error 语义", () => {
	const { AgentManager } = loadAgentManager();
	const manager = createManager(AgentManager);
	const runtime = makeRuntime();
	manager.agents.set("agent", runtime);

	manager.handleAssistantMessageEvent(runtime, toolcallEvent("toolcall_start"));
	manager.handleAssistantMessageEvent(runtime, toolcallEvent("toolcall_end"));
	manager.completeToolResultsFromMessages(runtime, {
		messages: [
			{
				role: "toolResult",
				toolCallId: "call_abc",
				toolName: "bash",
				isError: true,
				content: "command not found",
			},
		],
	});

	const card = runtime.messages.find((m) => m.role === "tool");
	assert.equal(card.meta?.isError, true);
	assert.equal(card.meta?.result, "command not found");
});

test("无对应卡片的 toolResult（直发工具）安全跳过", () => {
	const { AgentManager } = loadAgentManager();
	const manager = createManager(AgentManager);
	const runtime = makeRuntime();
	manager.agents.set("agent", runtime);

	manager.completeToolResultsFromMessages(runtime, {
		messages: [
			{ role: "toolResult", toolCallId: "call_unknown", toolName: "bash", content: "x" },
		],
	});

	assert.equal(runtime.messages.length, 0);
	assert.equal(runtime.toolExecuting, null);
});
