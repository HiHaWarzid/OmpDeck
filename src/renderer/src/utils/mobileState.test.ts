import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

type Message = {
	id: string;
	role?: string;
	text?: string;
	timestamp?: number;
	optimistic?: boolean;
};

type MobileState = {
	mergeMessageLists: (...lists: Message[][]) => Message[];
	appendTail: (current: Message[], incoming: Message[], options?: { reset?: boolean; limit?: number }) => Message[];
	mergeOlder: (older: Message[], incoming: Message[]) => Message[];
	countNewMessages: (current: Message[], incoming: Message[]) => number;
	shouldAcceptResponse: (request: Record<string, unknown>) => boolean;
	pollDelay: (options: { hidden?: boolean; running?: boolean }) => number | null;
	isNearBottom: (options: Record<string, number>) => boolean;
	scrollPlan: (options: Record<string, unknown>) => { scrollTop: number; showNewMessages: boolean };
	tailLength: (messages: Message[]) => number;
	lastRealMessageId: (messages: Message[]) => string;
	removeAcknowledgedOptimistic: (current: Message[], incoming: Message[]) => Message[];
};

const require = createRequire(import.meta.url);
const state = require("../../public/mobile-state.js") as MobileState;

function message(id: string, patch: Partial<Message> = {}): Message {
	return { id, role: "assistant", text: id, timestamp: 1, ...patch };
}

describe("mobile-state 消息合并", () => {
	test("按 id 去重且保留首次出现顺序，后到的对象覆盖旧值", () => {
		const merged = state.mergeMessageLists(
			[message("a", { text: "old" }), message("b")],
			[message("b", { text: "new" }), message("c")],
		);
		expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
		expect(merged[1].text).toBe("new");
	});

	test("appendTail 支持重置和 tail 上限", () => {
		expect(state.appendTail([message("a")], [message("b")], { limit: 1 })).toEqual([
			message("b"),
		]);
		expect(state.appendTail([message("a")], [message("b")], { reset: true })).toEqual([
			message("b"),
		]);
	});

	test("tail 上限不挤掉乐观消息，客户端 length 与服务端窗口一致", () => {
		const current = Array.from({ length: 40 }, (_, index) => message(`m${index}`));
		const optimistic = message("local", { role: "user", text: "hi", optimistic: true });
		const next = state.appendTail(current, [optimistic], { limit: 40 });
		expect(next).toHaveLength(41);
		expect(next[0]?.id).toBe("m0");
		expect(next.at(-1)?.id).toBe("local");
		expect(state.tailLength(next)).toBe(40);
	});

	test("历史分页合并把更早一页放在前面", () => {
		expect(
			state.mergeOlder([message("b"), message("c")], [message("a"), message("b")]).map(
				(item) => item.id,
			),
		).toEqual(["a", "b", "c"]);
	});

	test("只统计客户端尚未见过的消息", () => {
		expect(state.countNewMessages([message("a")], [message("a"), message("b")])).toBe(1);
	});

	test("tailLength 与 lastRealMessageId 忽略乐观消息", () => {
		const list = [message("a"), message("local", { optimistic: true })];
		expect(state.tailLength(list)).toBe(1);
		expect(state.lastRealMessageId(list)).toBe("a");
	});

	test("收到服务端确认后移除同文本的乐观用户消息", () => {
		const current = [
			message("a"),
			message("local", { role: "user", text: "hi", timestamp: 1000, optimistic: true }),
		];
		const next = state.removeAcknowledgedOptimistic(current, [
			message("real", { role: "user", text: "hi", timestamp: 1200 }),
		]);
		expect(next.map((item) => item.id)).toEqual(["a"]);
	});
});

describe("mobile-state 请求与滚动决策", () => {
	test("epoch 或 agent 变化时拒绝旧响应", () => {
		const request = {
			requestEpoch: 2,
			currentEpoch: 2,
			requestAgentId: "a",
			currentAgentId: "a",
		};
		expect(state.shouldAcceptResponse(request)).toBe(true);
		expect(state.shouldAcceptResponse({ ...request, currentEpoch: 3 })).toBe(false);
		expect(state.shouldAcceptResponse({ ...request, currentAgentId: "b" })).toBe(false);
	});

	test("运行中 500ms、空闲 5s、隐藏时暂停", () => {
		expect(state.pollDelay({ running: true })).toBe(500);
		expect(state.pollDelay({ running: false })).toBe(5000);
		expect(state.pollDelay({ hidden: true, running: true })).toBeNull();
	});

	test("靠近底部判定使用 80px 阈值", () => {
		expect(state.isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 })).toBe(
			false,
		);
		expect(state.isNearBottom({ scrollHeight: 1000, scrollTop: 750, clientHeight: 200 })).toBe(
			true,
		);
	});

	test("初始滚动到底，加载更早消息保持相对位置", () => {
		expect(
			state.scrollPlan({ mode: "initial", previousTop: 0, previousHeight: 100, scrollHeight: 200 }),
		).toEqual({ scrollTop: 200, showNewMessages: false });
		expect(
			state.scrollPlan({ mode: "preserve", previousTop: 100, previousHeight: 200, scrollHeight: 300 }),
		).toEqual({ scrollTop: 200, showNewMessages: false });
	});

	test("不在底部时保持位置并提示新消息", () => {
		expect(
			state.scrollPlan({
				mode: "auto",
				nearBottom: false,
				previousTop: 40,
				previousHeight: 100,
				scrollHeight: 200,
				newCount: 2,
			}),
		).toEqual({ scrollTop: 40, showNewMessages: true });
		expect(
			state.scrollPlan({
				mode: "auto",
				nearBottom: true,
				previousTop: 40,
				previousHeight: 100,
				scrollHeight: 200,
				newCount: 2,
			}),
		).toEqual({ scrollTop: 200, showNewMessages: false });
	});
});
