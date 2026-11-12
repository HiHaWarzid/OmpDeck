import assert from "node:assert/strict";
import { test, vi } from "vitest";

import type { AgentUiRequest, ChatMessage } from "../../shared/types";
import {
	AgentInteractions,
	normalizeAskQuestions,
	TRUST_REQUEST_TIMEOUT_MS,
	type AgentInteractionsHost,
	type InteractionRuntime,
} from "./agentInteractions";

function makeRuntime(): { runtime: InteractionRuntime; sent: Record<string, unknown>[] } {
	const sent: Record<string, unknown>[] = [];
	const runtime = {
		tab: { id: "a1" },
		transcript: { messages: [] as ChatMessage[] },
		pendingUIRequests: new Map<string, { method: string; title: string }>(),
		slot: { process: { client: { sendRaw: (payload: Record<string, unknown>) => sent.push(payload) } } },
		run: {},
	} as unknown as InteractionRuntime;
	return { runtime, sent };
}

function makeInteractions(runtime: InteractionRuntime, options: { responders?: boolean } = {}) {
	const events: AgentUiRequest[] = [];
	const trust: Array<{ requestId: string; cwd: string; projectName: string }> = [];
	const host: AgentInteractionsHost = {
		runtime: (agentId) => (agentId === runtime.tab.id ? runtime : undefined),
		publishUiRequest: (request) => events.push(request),
		publishTrustRequest: (request) => trust.push(request),
		addCard: (agentId, title, uiRequest) => {
			runtime.transcript.messages.push({
				id: `card-${uiRequest.requestId}`,
				agentId,
				role: "system",
				text: title,
				timestamp: 0,
				meta: { type: "askQuestion", status: "pending", uiRequest },
			});
		},
		markDirty: () => {},
		markMessageDirty: () => {},
		scheduleEmit: () => {},
		hasUiResponders: () => options.responders ?? true,
	};
	return { interactions: new AgentInteractions(host), events, trust };
}

test("select 无选项时立即取消，不插卡片", () => {
	const { runtime, sent } = makeRuntime();
	const { interactions, events } = makeInteractions(runtime);

	interactions.open("a1", { type: "extension_ui_request", id: "r1", method: "select", title: "pick", options: [] });

	assert.deepEqual(sent, [{ type: "extension_ui_response", id: "r1", cancelled: true }]);
	assert.equal(runtime.transcript.messages.length, 0);
	// 取消事件也要通知渲染层，避免弹出空选择器
	assert.equal(events.at(-1)?.cancelled, true);
});

test("批量问卷 envelope 落成 batch_ask 卡片并登记 pending", () => {
	const { runtime } = makeRuntime();
	const { interactions, events } = makeInteractions(runtime);
	const envelope = JSON.stringify({
		__piDeckBatchAsk: 1,
		review: true,
		questions: [{ id: "q1", type: "input", question: "名字" }],
	});

	interactions.open("a1", { type: "extension_ui_request", id: "r1", method: "input", title: envelope });

	const card = runtime.transcript.messages.at(-1);
	assert.equal(card?.meta?.type, "askQuestion");
	assert.equal((card?.meta as Record<string, unknown>).status, "pending");
	assert.equal(events.at(-1)?.method, "batch_ask");
	assert.equal(events.at(-1)?.batchReview, true);
	assert.equal(runtime.pendingUIRequests.get("r1")?.method, "input");
});

test("respond 写出 value:null 取消并把卡片标为 answered", () => {
	const { runtime, sent } = makeRuntime();
	const { interactions, events } = makeInteractions(runtime);
	interactions.open("a1", { type: "extension_ui_request", id: "r1", method: "select", title: "pick", options: ["a", "b"] });

	interactions.respond("a1", "r1", { value: null });

	assert.deepEqual(sent, [{ type: "extension_ui_response", id: "r1", value: null }]);
	assert.equal(runtime.pendingUIRequests.size, 0);
	const meta = runtime.transcript.messages[0].meta as Record<string, unknown>;
	assert.equal(meta.status, "answered");
	assert.deepEqual(meta.response, { value: null });
	assert.equal(events.at(-1)?.completed, true);
});

test("cancelForAbort 按 method 选择协议形状并收掉卡片", () => {
	const { runtime, sent } = makeRuntime();
	const { interactions } = makeInteractions(runtime);
	interactions.open("a1", { type: "extension_ui_request", id: "r1", method: "select", title: "pick", options: ["a"] });
	interactions.open("a1", {
		type: "extension_ui_request",
		id: "r2",
		method: "ask",
		questions: [{ id: "q1", question: "选一个", options: ["x"] }],
	});

	const count = interactions.cancelForAbort("a1");

	assert.equal(count, 2);
	// 原生 ask 只认 cancelled；旧 select 必须 value:null，否则 pi 会选中第一项
	assert.deepEqual(sent, [
		{ type: "extension_ui_response", id: "r1", value: null },
		{ type: "extension_ui_response", id: "r2", cancelled: true },
	]);
	assert.equal(runtime.pendingUIRequests.size, 0);
	assert.equal(runtime.transcript.messages.length, 0);
});

test("pi 主动 cancel 只按 targetId 清理，不误删其他卡片", () => {
	const { runtime } = makeRuntime();
	const { interactions, events } = makeInteractions(runtime);
	interactions.open("a1", { type: "extension_ui_request", id: "r1", method: "confirm", title: "first" });
	interactions.open("a1", { type: "extension_ui_request", id: "r2", method: "confirm", title: "second" });

	interactions.open("a1", { type: "extension_ui_request", id: "r3", method: "cancel", targetId: "r1" });

	assert.deepEqual(
		runtime.transcript.messages.map((message) => message.id),
		["card-r2"],
	);
	assert.deepEqual([...runtime.pendingUIRequests.keys()], ["r2"]);
	assert.deepEqual(events.at(-1), {
		agentId: "a1",
		requestId: "r1",
		method: "",
		title: "",
		completed: true,
		cancelled: true,
	});
});

test("本地超时到期后删卡并通知完成", () => {
	vi.useFakeTimers();
	try {
		const { runtime } = makeRuntime();
		const { interactions, events } = makeInteractions(runtime);
		interactions.open("a1", { type: "extension_ui_request", id: "r1", method: "input", title: "name", timeout: 20 });

		assert.equal(runtime.transcript.messages.length, 1);
		vi.advanceTimersByTime(20);

		assert.equal(runtime.transcript.messages.length, 0);
		assert.equal(runtime.pendingUIRequests.has("r1"), false);
		assert.equal(events.at(-1)?.cancelled, true);
	} finally {
		vi.useRealTimers();
	}
});

test("无 UI 消费者时信任询问直接拒绝，不挂超时", async () => {
	const { runtime } = makeRuntime();
	const { interactions } = makeInteractions(runtime, { responders: false });

	assert.equal(await interactions.requestTrust("C:/repo", "repo"), "deny");
	assert.equal(interactions.listTrust().length, 0);
});

test("信任询问等到用户选择后才放行", async () => {
	const { runtime } = makeRuntime();
	const { interactions, trust } = makeInteractions(runtime);

	const pending = interactions.requestTrust("C:/repo", "repo");
	assert.equal(trust.length, 1);
	assert.equal(trust[0].projectName, "repo");
	assert.equal(interactions.listTrust().length, 1);

	interactions.respondTrust(trust[0].requestId, "trust-session");

	assert.equal(await pending, "trust-session");
	assert.equal(interactions.listTrust().length, 0);
});

test("信任询问超时按拒绝处理", async () => {
	vi.useFakeTimers();
	try {
		const { runtime } = makeRuntime();
		const { interactions } = makeInteractions(runtime);
		const pending = interactions.requestTrust("C:/repo", "repo");

		vi.advanceTimersByTime(TRUST_REQUEST_TIMEOUT_MS);

		assert.equal(await pending, "deny");
		assert.equal(interactions.listTrust().length, 0);
	} finally {
		vi.useRealTimers();
	}
});

test("normalizeAskQuestions 遇到脏题整包丢弃，避免 answers 错位", () => {
	assert.deepEqual(normalizeAskQuestions("nope"), []);
	assert.deepEqual(normalizeAskQuestions([{ question: "" }]), []);

	const ok = normalizeAskQuestions([
		{ id: "q1", question: "选一个", options: [{ label: "a", description: "d" }, "b"], recommended: 5 },
		{ question: "第二题", options: ["x"], multi: true },
	]);
	assert.equal(ok.length, 2);
	assert.equal(ok[0].id, "q1");
	assert.equal(ok[0].options[0].description, "d");
	// 越界推荐下标被丢弃，pi 才不会自动选中不存在的项
	assert.equal(ok[0].recommended, undefined);
	assert.equal(ok[1].id, "q2");
	assert.equal(ok[1].multi, true);
});
