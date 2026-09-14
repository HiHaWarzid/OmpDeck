import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, vi } from "vitest";

import type { AgentTab, AvailableModel, ChatMessage, Project } from "../../shared/types";
import { AgentManager, type AgentConfigDeps } from "./AgentManager";
import type { AgentProcessFactory, AgentProcessPort } from "./agentProcessSlot";
import type { PiRpcClient } from "./PiRpcClient";
import type { SettingsStore } from "../settings/SettingsStore";

vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
	BrowserWindow: class {},
	Notification: class {},
	shell: {},
	net: {},
}));

/**
 * 子进程属主契约的行为测试：驱动真实的 create/stop/restart 路径（经注入的假 child），
 * 断言用户可见的结果——退役 runtime 不被迟到 exit 改写、stopAll 能终止已摘除的 child。
 *
 * 这两条正是「不在册的 child 活过应用 / 往已退役 transcript 写错误卡」的事故现场。
 */

const SESSION_PATH = "C:/sessions/s1.jsonl";
const PROJECT = { id: "p1", name: "项目", path: "C:/work" } as unknown as Project;

/** 假 pi child：只实现 AgentManager 用到的能力，退出/错误以事件形式暴露，与真实 PiProcess 同形。 */
class FakeChild extends EventEmitter {
	client: PiRpcClient;
	startCalls = 0;
	stopCalls = 0;
	running = false;
	/** start() 内同步触发，用于模拟 spawn/协议错误在 start 尚未返回时到达。 */
	onStart?: () => void;

	constructor() {
		super();
		const respond = async (command: { type?: string }) => {
			if (command.type === "get_state") {
				return {
					success: true,
					data: { sessionId: "s1", sessionFile: SESSION_PATH, sessionName: "会话" },
				};
			}
			if (command.type === "get_messages") return { success: true, data: { messages: [] } };
			if (command.type === "get_entries") return { success: true, data: { entries: [] } };
			return { success: true, data: undefined };
		};
		// 测试替身只需 request：断言不涉及其他客户端能力，装配点做一次显式收窄。
		this.client = { request: respond } as unknown as PiRpcClient;
	}

	async start(): Promise<PiRpcClient> {
		this.startCalls += 1;
		this.running = true;
		// 真实 PiProcess 的 spawn 错误可能在 start 尚未返回时就同步/微任务内到达：
		// 监听器必须已挂上，否则 0 listener 的 error 会被 EventEmitter 抛出。
		this.onStart?.();
		return this.client;
	}

	/** 与真实 PiProcess 一致：终止是异步确认（要等 exit），不是同步调用。 */
	async stop(): Promise<void> {
		this.stopCalls += 1;
		this.running = false;
	}

	isRunning(): boolean {
		return this.running;
	}

	getDiagnostics() {
		return null;
	}

	/** 被终止的 child 通常要到下一个事件循环才报退出。 */
	emitLateExit(): void {
		this.emit("exit", { code: 0, signal: null });
	}
}

type TestRuntime = { tab: AgentTab; transcript: { messages: ChatMessage[] } };

type Harness = {
	manager: AgentManager;
	agents: Map<string, TestRuntime>;
	children: FakeChild[];
};

function makeHarness(configureChild?: (child: FakeChild) => void): Harness {
	const children: FakeChild[] = [];
	const factory: AgentProcessFactory = () => {
		const child = new FakeChild();
		configureChild?.(child);
		children.push(child);
		return child as unknown as AgentProcessPort;
	};
	const manager = new AgentManager(
		() => PROJECT,
		() => null, // 不推送 IPC
		{ get: () => ({ rpcTimeout: 1_000 }) } as unknown as SettingsStore,
		{
			readOmpDefaultThinkingLevel: async () => undefined,
			filterConfiguredModels: async (models: AvailableModel[]) => models,
			trustStore: { decide: async () => undefined },
		} as unknown as AgentConfigDeps,
		undefined,
		undefined,
		factory,
	);
	return {
		manager,
		agents: (manager as unknown as { agents: Map<string, TestRuntime> }).agents,
		children,
	};
}

test("restart 后旧 child 的迟到 exit 不再改写退役 runtime", async () => {
	const { manager, agents, children } = makeHarness();
	const tab = await manager.create({ projectId: "p1" });
	const retired = agents.get(tab.id);
	assert(retired, "create 应产出 runtime");
	const oldChild = children[0];

	const restarted = await manager.restart(tab.id);
	assert.equal(oldChild.stopCalls, 1, "restart 应先终止旧 child");
	assert.equal(children.length, 2, "restart 应拉起新 child");
	assert.notEqual(restarted.id, tab.id);

	oldChild.emitLateExit();
	// 退出分支的后续（自动重连失败 → 写错误卡）在微任务里完成：先让它跑完，迟到 exit 的后果才算全部落地。
	await Promise.resolve();
	await Promise.resolve();

	const errorTexts = retired.transcript.messages
		.filter((message) => message.role === "error")
		.map((message) => message.text);
	assert.deepEqual(errorTexts, [], "退役 runtime 不应收到迟到 exit 的错误卡");
	assert.equal(retired.tab.status, "idle", "退役 runtime 的状态不应被迟到 exit 拉回 starting/closed");
	assert.equal(children.length, 2, "迟到 exit 不应触发自动重连再拉起 child");
});

test("stopAll 终止已从 agents 摘除、但仍在退役登记中的 child", async () => {
	const { manager, agents, children } = makeHarness();
	const tab = await manager.create({ projectId: "p1" });
	const child = children[0];
	assert(agents.has(tab.id));

	const firstStop = manager.stop(tab.id);
	assert.equal(agents.has(tab.id), false, "stop 先摘除 runtime，UI 立即响应");
	assert.equal(child.stopCalls, 1);

	// 此刻 child 已不在 agents 里，只有退役登记还能找到它。
	const all = manager.stopAll();
	assert.equal(child.stopCalls, 2, "stopAll 必须兜底终止退役登记里的 child");

	await Promise.all([firstStop, all]);
	assert.equal(child.isRunning(), false);
});

test("生命周期监听在 child.start 之前挂载：start 期间同步 error 不会丢失", async () => {
	const failure = Object.assign(new Error("spawn ENOENT during start"), { code: "ENOENT" });
	// 监听器若未在 start 之前挂上，EventEmitter 会因 0 listener 把 error 抛出（生产即未捕获异常 → 闪退）；
	// 捕获到抛出即代表这次失败事件丢失，测试据此断言挂载顺序。
	let emittedWithNoListener = false;
	const { manager, agents, children } = makeHarness((child) => {
		child.onStart = () => {
			try {
				child.emit("error", failure);
			} catch {
				emittedWithNoListener = true;
			}
		};
	});

	const tab = await manager.create({ projectId: "p1" });
	const runtime = agents.get(tab.id);
	assert(runtime, "create 应产出 runtime");
	assert.equal(children[0].startCalls, 1);
	assert.equal(
		emittedWithNoListener,
		false,
		"start 期间同步 error 不应因 0 listener 抛出——监听器必须在 start 之前挂载",
	);
	assert.equal(
		tab.lastError,
		failure.message,
		"监听器应在 start 期间就记录进程错误，失败不能被丢失",
	);
});
