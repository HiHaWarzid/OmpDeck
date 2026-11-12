import assert from "node:assert/strict";
import { test } from "vitest";

import type { ChatMessage } from "../../shared/types";
import { AgentHistory, type AgentHistoryHost, type HistoryJsonl, type HistoryRuntime } from "./agentHistory";

function chat(id: string, text = id): ChatMessage {
	return { id, agentId: "a1", role: "user", text, timestamp: 1 };
}

type JsonlStub = HistoryJsonl & {
	calls: Array<{ method: string; args: unknown[] }>;
};

function makeJsonl(overrides: Partial<HistoryJsonl> = {}): JsonlStub {
	const calls: JsonlStub["calls"] = [];
	const base: HistoryJsonl = {
		findEntryOffset: async (...args) => {
			calls.push({ method: "findEntryOffset", args });
			return 128;
		},
		readOlderMessages: async (...args) => {
			calls.push({ method: "readOlderMessages", args });
			return {
				messages: [{ role: "user", content: [{ type: "text", text: "old" }] }],
				entryIds: ["e1"],
				cursor: 64,
				hasMore: true,
			};
		},
		readDisplayMessages: async (...args) => {
			calls.push({ method: "readDisplayMessages", args });
			return [chat("a1-m0"), chat("a1-m1"), chat("a1-m2")];
		},
		readEntryTextById: async (...args) => {
			calls.push({ method: "readEntryTextById", args });
			return "full";
		},
		...overrides,
	};
	return Object.assign(base, { calls });
}

function makeHistory(runtime: HistoryRuntime | undefined, jsonl: HistoryJsonl) {
	const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
	const host: AgentHistoryHost = {
		runtime: () => {
			if (!runtime) throw new Error("Agent runtime not found");
			return runtime;
		},
		jsonl,
		log: {
			info: (_scope, message, detail) => {
				logs.push({ message, detail });
			},
		},
	};
	return { history: new AgentHistory(host), logs };
}

function runtimeWith(overrides: Partial<HistoryRuntime> = {}): HistoryRuntime {
	return {
		tab: { sessionPath: "C:/session.jsonl" },
		transcript: { messages: [], fullTextByMessageId: new Map() } as unknown as HistoryRuntime["transcript"],
		...overrides,
	};
}

test("page：首屏优先用文件基线游标，不读 entryId 定位", async () => {
	const jsonl = makeJsonl();
	const { history } = makeHistory(runtimeWith({ historyCursor: 4096 }), jsonl);

	const page = await history.page("a1");

	assert.deepEqual(
		jsonl.calls.map((call) => call.method),
		["readOlderMessages"],
	);
	assert.equal(jsonl.calls[0]?.args[1], 4096);
	assert.equal(page.cursor, 64);
	assert.equal(page.hasMore, true);
	assert.equal(page.messages[0]?.meta?.historyPage, true);
});

test("page：没有基线时用时间线最旧 entryId 定位上界，定位不到就返回空页", async () => {
	const transcript = { messages: [chat("m1"), chat("m2")] } as unknown as HistoryRuntime["transcript"];
	transcript.messages[0]!.meta = { entryId: "oldest-entry" };
	const jsonl = makeJsonl();
	const { history } = makeHistory(runtimeWith({ transcript }), jsonl);

	await history.page("a1");
	assert.equal(jsonl.calls[0]?.method, "findEntryOffset");
	assert.equal(jsonl.calls[0]?.args[1], "oldest-entry");

	const missing = makeJsonl({ findEntryOffset: async () => undefined });
	const second = makeHistory(runtimeWith({ transcript }), missing);
	assert.deepEqual(await second.history.page("a1"), { messages: [], cursor: 0, hasMore: false });
});

test("page：没有会话文件时不落盘也不抛错（只读会话未持久化）", async () => {
	const jsonl = makeJsonl();
	const { history } = makeHistory(runtimeWith({ tab: {} }), jsonl);
	assert.deepEqual(await history.page("a1"), { messages: [], cursor: 0, hasMore: false });
	assert.equal(jsonl.calls.length, 0);
});

test("webPage：下标越界必须报错，避免手机端把坏游标当成「历史已读完」", async () => {
	const { history } = makeHistory(runtimeWith(), makeJsonl());
	await assert.rejects(() => history.webPage("a1", "9"), /历史分页游标无效/);
	await assert.rejects(() => history.webPage("a1", "abc"), /历史分页游标无效/);
});

test("webPage：从尾部倒序翻页，游标用字符串下标暴露", async () => {
	const { history } = makeHistory(runtimeWith(), makeJsonl());

	const latest = await history.webPage("a1", undefined, 2);
	assert.deepEqual(latest.messages.map((message) => message.id), ["a1-m1", "a1-m2"]);
	assert.equal(latest.nextCursor, "1");
	assert.equal(latest.hasMore, true);

	const older = await history.webPage("a1", latest.nextCursor ?? undefined, 2);
	assert.deepEqual(older.messages.map((message) => message.id), ["a1-m0"]);
	assert.equal(older.nextCursor, null);
	assert.equal(older.hasMore, false);
});

test("fullText：优先命中运行时缓存，缺缓存才按 entryId 读文件，都失败则抛错", async () => {
	const transcript = {
		messages: [],
		fullTextByMessageId: new Map([["m1", "cached full"]]),
	} as unknown as HistoryRuntime["transcript"];
	const jsonl = makeJsonl();
	const { history } = makeHistory(runtimeWith({ transcript }), jsonl);

	assert.deepEqual(await history.fullText("a1", "m1"), { text: "cached full" });
	assert.equal(jsonl.calls.length, 0);

	assert.deepEqual(await history.fullText("a1", "m2", "e2"), { text: "full" });
	assert.equal(jsonl.calls[0]?.method, "readEntryTextById");

	const missingEntry = makeJsonl({ readEntryTextById: async () => null });
	const second = makeHistory(runtimeWith(), missingEntry);
	await assert.rejects(() => second.history.fullText("a1", "m3", "e3"), /full text unavailable/);
});
