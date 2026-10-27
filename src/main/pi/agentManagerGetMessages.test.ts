import assert from "node:assert/strict";
import { test, vi } from "vitest";

import type { AgentTab, ChatMessage } from "../../shared/types";
import { AgentManager, type AgentConfigDeps } from "./AgentManager";
import { MAX_TRANSCRIPT_BYTES } from "./agentTranscript";
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

/**
 * 直接向私有运行时表注入一条 transcript：getMessages 只读该表，而这里要测的正是
 * 「表里已超预算时快照怎么裁」——走真实 append 路径需要构造几十 MB 文本，得不偿失。
 */
function injectRuntime(manager: AgentManager, messages: ChatMessage[]): void {
	const agents = (manager as unknown as { agents: Map<string, TestRuntime> }).agents;
	agents.set("a1", { tab: { id: "a1" } as AgentTab, transcript: { messages } });
}

test("getMessages 超过预算时只保留尾部并记日志", () => {
	const warnings: string[] = [];
	const manager = makeManager(warnings);
	const messages = [
		message("m1", (MAX_TRANSCRIPT_BYTES * 3) / 4),
		message("m2", MAX_TRANSCRIPT_BYTES / 4),
		message("m3", MAX_TRANSCRIPT_BYTES / 4),
	];
	injectRuntime(manager, messages);

	const capped = manager.getMessages("a1");
	assert.deepEqual(capped.map((m) => m.id), ["m2", "m3"]);
	assert.equal(warnings.length, 1);
});

test("预算计入 meta 详情：文本装得下但工具卡详情巨量的会话同样被裁剪", () => {
	const warnings: string[] = [];
	const manager = makeManager(warnings);
	// 10 条消息正文都很小，但每条带 0.5M 字符的 detailText：旧口径（只算 text/thinking）
	// 会认为整份快照才几百字节，超预算的工具卡会话照样整份过 IPC。
	const messages: ChatMessage[] = Array.from({ length: 10 }, (_, index) => ({
		id: `m${index}`,
		agentId: "a1",
		role: "tool",
		text: "✓ bash",
		timestamp: 0,
		meta: { detailText: "d".repeat(500_000) },
	}));
	injectRuntime(manager, messages);

	const capped = manager.getMessages("a1");
	assert.ok(capped.length < messages.length);
	assert.equal(capped.at(-1)?.id, "m9");
	assert.equal(warnings.length, 1);
});

test("getMessages 未超预算时原样返回同一数组", () => {
	const warnings: string[] = [];
	const manager = makeManager(warnings);
	const messages = [message("m1", 1024), message("m2", 1024)];
	injectRuntime(manager, messages);

	assert.equal(manager.getMessages("a1"), messages);
	assert.deepEqual(manager.getMessages("missing"), []);
	assert.equal(warnings.length, 0);
});

test("单条即超预算时至少保留最后一条，基线不会为空", () => {
	const manager = makeManager([]);
	injectRuntime(manager, [
		message("m1", MAX_TRANSCRIPT_BYTES / 2),
		message("m2", MAX_TRANSCRIPT_BYTES * 2),
	]);

	assert.deepEqual(manager.getMessages("a1").map((m) => m.id), ["m2"]);
});
