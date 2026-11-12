import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { test } from "vitest";

import { ipcChannels } from "../../shared/ipc";
import type { AgentTab } from "../../shared/types";
import { createAgentEventSink, type AgentEvent, type AgentEventSink } from "../pi/agentEventSink";
import { createElectronAgentEventBridge } from "./agentEventBridge";

/**
 * 适配器契约测试：这是「语义事件 → 桌面通道」的唯一映射点，
 * 负载形状就是渲染层的 wire 契约，回归时必须在测试里立刻可见。
 */

type SentMessage = { channel: string; payload: unknown };

/** 只实现桥接用到的 BrowserWindow 面：once/removeListener/isDestroyed/webContents.send。 */
class FakeWindow extends EventEmitter {
	readonly sent: SentMessage[] = [];
	destroyed = false;
	readonly webContents = {
		send: (channel: string, payload: unknown) => this.sent.push({ channel, payload }),
	};

	isDestroyed(): boolean {
		return this.destroyed;
	}
}

/** 桥接只用到 once/removeListener/isDestroyed/webContents.send，其余 BrowserWindow 面不参与。 */
function asWindow(window: FakeWindow): BrowserWindow {
	return window as unknown as BrowserWindow;
}

function makeSink(): AgentEventSink {
	return createAgentEventSink({ snapshot: async () => ({ tabs: [], agents: {} }) });
}

const TAB: AgentTab = { id: "a1", projectId: "p1", cwd: "C:/work", title: "t", status: "running", createdAt: 1 };

function publishAll(sink: AgentEventSink) {
	const events: AgentEvent[] = [
		{ kind: "message-appended", agentId: "a1", replaceFrom: 0, messages: [] },
		{ kind: "thinking-delta", agentId: "a1", thinking: "想" },
		{ kind: "runtime-changed", agentId: "a1", state: { runtimeStateSeq: 1 } as never },
		{ kind: "tabs-changed", tabs: [TAB] },
		{ kind: "ui-request", request: { agentId: "a1", requestId: "r1", method: "select" } },
		{ kind: "trust-request", requestId: "tr1", cwd: "C:/work", projectName: "proj" },
		{
			kind: "notice",
			notice: { agentId: "a1", message: "已停止", i18nKey: "notice.aborted", kind: "info", durationMs: 3000 },
		},
		{ kind: "log", agentId: "a1", text: "hello" },
		{ kind: "subagents-changed", agentId: "a1", subagents: [] },
		{ kind: "command-catalog", agentId: "a1", commands: [] },
		{ kind: "settled", agentId: "a1" },
		{ kind: "status-changed", agentId: "a1", status: "idle", tab: { ...TAB, status: "idle" } },
	];
	for (const event of events) sink.publish(event);
}

test("每条语义事件映射到对应桌面通道，负载字段保真", () => {
	const sink = makeSink();
	const bridge = createElectronAgentEventBridge(sink);
	const window = new FakeWindow();
	bridge.attach(asWindow(window));

	publishAll(sink);

	const byChannel = new Map(window.sent.map((item) => [item.channel, item.payload]));
	assert.deepEqual(byChannel.get(ipcChannels.agentsMessage), { agentId: "a1", replaceFrom: 0, messages: [] });
	assert.deepEqual(byChannel.get(ipcChannels.agentsThinking), { agentId: "a1", thinking: "想" });
	assert.deepEqual(byChannel.get(ipcChannels.agentsRuntimeState), {
		agentId: "a1",
		state: { runtimeStateSeq: 1 },
	});
	assert.deepEqual(byChannel.get(ipcChannels.agentsState), [TAB]);
	assert.deepEqual(byChannel.get(ipcChannels.agentsUiRequest), {
		agentId: "a1",
		requestId: "r1",
		method: "select",
	});
	assert.deepEqual(byChannel.get(ipcChannels.agentsTrustRequest), {
		requestId: "tr1",
		cwd: "C:/work",
		projectName: "proj",
	});
	assert.deepEqual(byChannel.get(ipcChannels.agentsNotice), {
		agentId: "a1",
		message: "已停止",
		i18nKey: "notice.aborted",
		kind: "info",
		duration: 3000,
	});
	assert.deepEqual(byChannel.get(ipcChannels.agentsLog), { agentId: "a1", text: "hello" });
	assert.deepEqual(byChannel.get(ipcChannels.agentsSubagents), { agentId: "a1", subagents: [] });
	assert.deepEqual(byChannel.get(ipcChannels.agentsCommandCatalog), { agentId: "a1", commands: [] });
	// settled / status-changed 是进程内信号，不得携带桌面通道
	assert.equal(window.sent.length, 10);
});

test("窗口 closed 后退订：hasUiResponders 归零，后续事件不再发送", () => {
	const sink = makeSink();
	const bridge = createElectronAgentEventBridge(sink);
	const window = new FakeWindow();
	bridge.attach(asWindow(window));
	assert.equal(sink.hasUiResponders(), true);

	window.emit("closed");
	assert.equal(sink.hasUiResponders(), false);

	sink.publish({ kind: "settled", agentId: "a1" });
	sink.publish({ kind: "log", agentId: "a1", text: "after-close" });
	assert.equal(window.sent.length, 0);
});

test("只读消费者（宠物/编排器）不算作答者，但仍收到事件", () => {
	const sink = makeSink();
	const seen: AgentEvent[] = [];
	sink.onEvent((event) => seen.push(event));

	// 只有宠物/编排器在线时，信任确认必须走安全默认而不是白等 60s。
	assert.equal(sink.hasUiResponders(), false);
	sink.publish({ kind: "settled", agentId: "a1" });
	assert.equal(seen.length, 1);
});

test("重复 attach 只绑定最新窗口，旧窗口不再收到事件", () => {
	const sink = makeSink();
	const bridge = createElectronAgentEventBridge(sink);
	const first = new FakeWindow();
	const second = new FakeWindow();
	bridge.attach(asWindow(first));
	bridge.attach(asWindow(second));

	sink.publish({ kind: "log", agentId: "a1", text: "x" });
	assert.equal(first.sent.length, 0);
	assert.equal(second.sent.length, 1);

	// detach 后连最新窗口也不再收到
	bridge.detach();
	sink.publish({ kind: "log", agentId: "a1", text: "y" });
	assert.equal(second.sent.length, 1);
	assert.equal(sink.hasUiResponders(), false);
});

test("已销毁窗口不发送；消费者抛错被 sink 隔离，不影响后续事件", () => {
	const errors: unknown[] = [];
	const sink = createAgentEventSink({
		snapshot: async () => ({ tabs: [], agents: {} }),
		onListenerError: (error) => errors.push(error),
	});
	const bridge = createElectronAgentEventBridge(sink);
	const window = new FakeWindow();
	bridge.attach(asWindow(window));
	sink.onEvent(() => {
		throw new Error("consumer boom");
	});

	window.destroyed = true;
	sink.publish({ kind: "log", agentId: "a1", text: "dropped" });
	assert.equal(window.sent.length, 0);

	window.destroyed = false;
	sink.publish({ kind: "log", agentId: "a1", text: "delivered" });
	assert.equal(window.sent.length, 1);
	assert.equal(errors.length, 2); // 两次 publish 各触发一次消费者异常，均被隔离
});
