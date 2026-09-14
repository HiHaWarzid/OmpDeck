import assert from "node:assert/strict";
import { test, vi } from "vitest";

import type { AgentTab, AvailableModel, ChatMessage } from "../../shared/types";
import { AgentManager, type AgentConfigDeps } from "./AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";

vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
	BrowserWindow: class {},
	Notification: class {},
	shell: {},
	net: {},
}));

type TestRuntime = { tab: AgentTab; transcript: { messages: ChatMessage[] } };

/**
 * getMessages 是渲染层全量基线的唯一来源，transcript 只增不减：
 * 超预算时必须丢最旧的、保留最新的，且不能把数组裁空（基线为空会让历史重建倒退）。
 */
function makeManager(warnings: string[]): AgentManager {
	return new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({ rpcTimeout: 1_000 }) } as unknown as SettingsStore,
		{
			readOmpDefaultThinkingLevel: async () => undefined,
			filterConfiguredModels: async (models: AvailableModel[]) => models,
			trustStore: { decide: async () => undefined },
		} as unknown as AgentConfigDeps,
		undefined,
		{
			warn: (_scope: string, message: string) => warnings.push(message),
			info: () => {},
			error: () => {},
			debug: () => {},
		} as never,
		undefined,
	);
}

function message(id: string, estimatedBytes: number): ChatMessage {
	return {
		id,
		agentId: "a1",
		role: "assistant",
		// 估算按 UTF-16（2 字节/字符）计，反推字符数即可命中目标体积
		text: "x".repeat(Math.max(0, (estimatedBytes - 256) / 2)),
		timestamp: 0,
	};
}

function runtime(messages: ChatMessage[]): TestRuntime {
	return { tab: { id: "a1" } as AgentTab, transcript: { messages } };
}

test("getMessages 超过 5MB 预算时只保留尾部并记日志", () => {
	const warnings: string[] = [];
	const manager = makeManager(warnings);
	const agents = (manager as unknown as { agents: Map<string, TestRuntime> }).agents;
	const messages = [message("m1", 4 * 1024 * 1024), message("m2", 1024 * 1024), message("m3", 1024 * 1024)];
	agents.set("a1", runtime(messages));

	const capped = manager.getMessages("a1");
	assert.deepEqual(capped.map((m) => m.id), ["m2", "m3"]);
	assert.equal(warnings.length, 1);
});

test("getMessages 未超预算时原样返回同一数组", () => {
	const warnings: string[] = [];
	const manager = makeManager(warnings);
	const agents = (manager as unknown as { agents: Map<string, TestRuntime> }).agents;
	const messages = [message("m1", 1024), message("m2", 1024)];
	agents.set("a1", runtime(messages));

	assert.equal(manager.getMessages("a1"), messages);
	assert.deepEqual(manager.getMessages("missing"), []);
	assert.equal(warnings.length, 0);
});

test("单条即超预算时至少保留最后一条，基线不会为空", () => {
	const manager = makeManager([]);
	const agents = (manager as unknown as { agents: Map<string, TestRuntime> }).agents;
	agents.set("a1", runtime([message("m1", 3 * 1024 * 1024), message("m2", 20 * 1024 * 1024)]));

	assert.deepEqual(manager.getMessages("a1").map((m) => m.id), ["m2"]);
});
