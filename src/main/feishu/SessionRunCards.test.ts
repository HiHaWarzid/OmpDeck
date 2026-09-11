import { describe, expect, it } from "vitest";
import { createInitialState, type RunState } from "./CardRunState";
import { SessionRunCards, type CardSink } from "./SessionRunCards";

/** 记录每一次 update/flush/close 的假卡片流，用来断言事件序列与交付时序。 */
class FakeCardStream implements CardSink {
	updates: object[] = [];
	flushes: Array<object | undefined> = [];
	closeCount = 0;
	lastPatchFailed = false;
	lastPatchError = "";

	update(card: object): void { this.updates.push(card); }
	async flush(card?: object): Promise<void> { this.flushes.push(card); }
	async close(): Promise<void> { this.closeCount += 1; }
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

/**
 * 用真实 reducer 驱动状态，render 直接把 RunState 当卡片，
 * 这样断言到的就是“同一 session 的事件序列会被渲染成什么”，不碰内部字段。
 */
function harness(opts: { opening?: Promise<CardSink> } = {}) {
	const stream = new FakeCardStream();
	const opened: Array<{ chatId: string; initialCard: object; replyToMessageId?: string }> = [];
	const cards = new SessionRunCards({
		openStream: (chatId, initialCard, o) => {
			opened.push({ chatId, initialCard, replyToMessageId: o.replyToMessageId });
			return opts.opening ?? Promise.resolve(stream);
		},
		render: (state: RunState) => state,
	});
	return { cards, stream, opened };
}

describe("SessionRunCards：卡片就绪前的事件缓冲", () => {
	it("就绪前只缓冲不渲染，就绪后按序回放一次", async () => {
		const stream = new FakeCardStream();
		const gate = deferred<CardSink>();
		const { cards } = harness({ opening: gate.promise });
		const handle = cards.begin("s1", { chatId: "c1", state: createInitialState(), initialCard: { v: "initial" } });

		cards.feed("s1", { type: "message_start", message: { role: "assistant" } });
		cards.feed("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } });
		expect(stream.updates).toHaveLength(0);

		gate.resolve(stream);
		await expect(handle.opened).resolves.toBe(true);

		const updates = stream.updates as RunState[];
		expect(updates).toHaveLength(2);
		expect(updates[0].blocks).toHaveLength(1);
		expect(updates[1].outputText).toBe("你好");
	});

	it("begin 把 chatId / 初始卡片 / replyToMessageId 原样交给 openStream", async () => {
		const { cards, opened } = harness();
		const initialCard = { kind: "initial" };
		const handle = cards.begin("s1", { chatId: "c1", state: createInitialState(), initialCard, replyToMessageId: "m1" });
		await handle.opened;
		expect(opened).toEqual([{ chatId: "c1", initialCard, replyToMessageId: "m1" }]);
	});

	it("就绪后的事件逐条更新，不与缓冲事件重复处理", async () => {
		const { cards, stream } = harness();
		const handle = cards.begin("s1", { chatId: "c1", state: createInitialState(), initialCard: {} });
		await handle.opened;

		cards.feed("s1", { type: "message_start", message: { role: "assistant" } });
		cards.feed("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "A" } });

		expect((stream.updates as RunState[]).map((s) => s.outputText)).toEqual(["", "A"]);
	});
});

describe("SessionRunCards：终态交付", () => {
	it("agent_end 只 flush + close 一次，之后不再接受事件", async () => {
		const { cards, stream } = harness();
		const handle = cards.begin("s1", { chatId: "c1", state: createInitialState(), initialCard: {} });
		await handle.opened;

		cards.feed("s1", { type: "agent_start" });
		expect(cards.feed("s1", { type: "agent_end" })).toBe(true);
		await handle.settled;

		expect(stream.flushes).toHaveLength(1);
		expect((stream.flushes[0] as RunState).terminal).toBe("done");
		expect(stream.closeCount).toBe(1);
		expect(cards.has("s1")).toBe(false);
		expect(cards.feed("s1", { type: "agent_start" })).toBe(false);
		expect(stream.updates).toHaveLength(1);
	});

	it("终态 patch 失败时只回调一次降级", async () => {
		const { cards, stream } = harness();
		let failed = 0;
		const handle = cards.begin("s1", {
			chatId: "c1", state: createInitialState(), initialCard: {},
			onDeliveryFailed: () => { failed += 1; },
		});
		await handle.opened;
		stream.lastPatchFailed = true;
		stream.lastPatchError = "patch rejected";

		cards.feed("s1", { type: "agent_end" });
		await handle.settled;

		expect(failed).toBe(1);
		expect(stream.closeCount).toBe(1);
	});

	it("flake: 终态 flush 抛错时同样回调降级并 close", async () => {
		const { cards, stream } = harness();
		let failed = 0;
		const handle = cards.begin("s1", {
			chatId: "c1", state: createInitialState(), initialCard: {},
			onDeliveryFailed: () => { failed += 1; },
		});
		await handle.opened;
		stream.flush = async () => { throw new Error("network down"); };

		cards.feed("s1", { type: "agent_end" });
		await handle.settled;

		expect(failed).toBe(1);
		expect(stream.closeCount).toBe(1);
	});
});

describe("SessionRunCards：创建失败与清理", () => {
	it("openStream 失败时丢弃运行：opened=false、不降级、后续事件不接管", async () => {
		const failed: string[] = [];
		const cards = new SessionRunCards({
			openStream: () => Promise.reject(new Error("nope")),
			render: (state: RunState) => state,
		});
		const handle = cards.begin("s1", {
			chatId: "c1", state: createInitialState(), initialCard: {},
			onDeliveryFailed: () => failed.push("s1"),
		});

		await expect(handle.opened).resolves.toBe(false);
		expect(cards.has("s1")).toBe(false);
		expect(cards.feed("s1", { type: "agent_end" })).toBe(false);
		expect(failed).toHaveLength(0);
	});

	it("卡片创建期间被 drop：就绪后立即关闭，不渲染也不回放，但 opened=true（卡片已存在）", async () => {
		const stream = new FakeCardStream();
		const gate = deferred<CardSink>();
		const { cards } = harness({ opening: gate.promise });
		const handle = cards.begin("s1", { chatId: "c1", state: createInitialState(), initialCard: {} });
		cards.feed("s1", { type: "agent_start" });

		cards.drop("s1");
		gate.resolve(stream);
		// 卡片消息已发出，不能被调用方误判为“创建失败”而补发纯文本。
		await expect(handle.opened).resolves.toBe(true);

		expect(stream.updates).toHaveLength(0);
		expect(stream.closeCount).toBe(1);
		// drop 是即时的：不等卡片创建返回就已结束该运行。
		await handle.settled;
	});

	it("abort 以 interrupted 终态收尾并清空运行", async () => {
		const { cards, stream } = harness();
		const handle = cards.begin("s1", { chatId: "c1", state: createInitialState(), initialCard: {} });
		await handle.opened;
		cards.feed("s1", { type: "agent_start" });

		await cards.abort("s1");

		expect((stream.flushes[0] as RunState).terminal).toBe("interrupted");
		expect(stream.closeCount).toBe(1);
		expect(cards.has("s1")).toBe(false);
	});

	it("fail 以携带错误信息的终态收尾，并收尾流式思考态", async () => {
		const { cards, stream } = harness();
		const handle = cards.begin("s1", { chatId: "c1", state: createInitialState(), initialCard: {} });
		await handle.opened;
		cards.feed("s1", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "嗯…" } });

		cards.fail("s1", "boom");
		await handle.settled;

		const finalCard = stream.flushes[0] as RunState;
		expect(finalCard.terminal).toBe("error");
		expect(finalCard.errorMsg).toBe("boom");
		// 错误卡片不能还停留在“思考中/正在调用”的进行态。
		expect(finalCard.reasoning.active).toBe(false);
		expect(finalCard.blocks.every((b) => b.kind !== "text" || !b.streaming)).toBe(true);
		expect(cards.has("s1")).toBe(false);
	});
});
