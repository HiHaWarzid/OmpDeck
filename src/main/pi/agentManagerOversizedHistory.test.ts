import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

import { AgentManager, type AgentConfigDeps } from "./AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";

vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
	BrowserWindow: class {},
	Notification: class {},
	shell: {},
	net: {},
}));

/**
 * 大会话历史加载的入口分派：超过 MAX_AUTO_HISTORY_LOAD_BYTES 的会话必须直接从 JSONL
 * 尾部读取，而不是先发 get_messages/get_entries 再撞 pi 的 RPC 传输上限后回退。
 * 回归点：线上 27MB 会话每次打开都白跑一次整文件序列化 + 留下失败日志。
 */
type RuntimeStub = {
	tab: { id: string; sessionPath?: string; historyHasOlder?: boolean; status: string };
	slot: { process: { client: { request: (payload: { type: string }) => Promise<unknown> } } };
	transcript: { messages: Array<{ text?: string }> };
	run: Record<string, unknown>;
};

function makeManager(): AgentManager {
	const manager = new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({ rpcTimeout: 1_000 }) } as unknown as SettingsStore,
		{
			readOmpDefaultThinkingLevel: async () => undefined,
			trustStore: { decide: async () => undefined },
		} as unknown as AgentConfigDeps,
		undefined,
		{
			warn: () => {},
			info: () => {},
			error: () => {},
			debug: () => {},
		} as never,
		undefined,
	);
	const internals = manager as unknown as {
		agents: Map<string, unknown>;
		emitState: () => void;
		emitRuntimeState: (id: string) => Promise<void>;
		emitThinking: (id: string, text: string) => void;
	};
	// 这些广播依赖完整运行时表（tab 字段齐全）；本测试只关心历史加载的取数来源。
	internals.emitState = () => undefined;
	internals.emitRuntimeState = async () => undefined;
	internals.emitThinking = () => undefined;
	const setRuntime = (runtime: RuntimeStub) => internals.agents.set("a1", runtime);
	return Object.assign(manager, { __setRuntime: setRuntime });
}

function writeSession(dir: string, bigTextBytes: number): string {
	const sessionPath = join(dir, "session.jsonl");
	const lines = [
		JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z" }),
		JSON.stringify({
			type: "message",
			id: "m-big",
			message: { role: "assistant", content: [{ type: "text", text: "x".repeat(bigTextBytes) }] },
		}),
		JSON.stringify({
			type: "message",
			id: "m-user",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		}),
		JSON.stringify({
			type: "message",
			id: "m-assistant",
			message: { role: "assistant", content: [{ type: "text", text: "world" }] },
		}),
	];
	writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
	return sessionPath;
}

test("超大会话跳过 get_messages/get_entries，直接从文件尾部取历史", async () => {
	const calls: string[] = [];
	const manager = makeManager() as AgentManager & {
		__setRuntime: (runtime: RuntimeStub) => void;
	};
	const sessionPath = writeSession(mkdtempSync(join(tmpdir(), "ompdeck-oversized-")), 6 * 1024 * 1024);
	manager.__setRuntime({
		tab: { id: "a1", sessionPath, status: "idle" },
		slot: {
			process: {
				client: {
					request: async (payload) => {
						calls.push(payload.type);
						return { success: true, data: { messages: [] } };
					},
				},
			},
		},
		transcript: { messages: [] },
		run: {},
	});

	await manager.loadMessages("a1");

	const runtime = (manager as unknown as { agents: Map<string, RuntimeStub> }).agents.get("a1");
	assert.deepEqual(calls, []);
	assert.ok(runtime?.transcript.messages.some((message) => message.text === "world"));
});

test("普通会话仍走 RPC 基线", async () => {
	const calls: string[] = [];
	const manager = makeManager() as AgentManager & {
		__setRuntime: (runtime: RuntimeStub) => void;
	};
	const sessionPath = writeSession(mkdtempSync(join(tmpdir(), "ompdeck-normal-")), 64);
	manager.__setRuntime({
		tab: { id: "a1", sessionPath, status: "idle" },
		slot: {
			process: {
				client: {
					request: async (payload) => {
						calls.push(payload.type);
						return {
							success: true,
							data: { messages: [{ role: "assistant", content: [{ type: "text", text: "rpc" }] }] },
						};
					},
				},
			},
		},
		transcript: { messages: [] },
		run: {},
	});

	await manager.loadMessages("a1", true);

	assert.deepEqual(calls, ["get_messages"]);
});
