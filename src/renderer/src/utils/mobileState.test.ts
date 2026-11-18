import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

type Message = {
	id: string;
	role?: string;
	text?: string;
	timestamp?: number;
	optimistic?: boolean;
	meta?: { toolName?: string; result?: string };
};

type MobileState = {
	mergeMessageLists: (...lists: Message[][]) => Message[];
	mergeTimeline: (older: Message[], chat: Message[]) => Message[];
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
	toolNameLabel: (name: string) => string;
	toolLabel: (text: string) => string;
	durationText: (value: unknown) => string;
	shortText: (value: unknown, max?: number) => string;
	splitThinking: (text: string, thinking: string) => { body: string; thinking: string };
	displayItem: (message: DisplayMessage) => DisplayItem;
	groupDisplayItems: (items: DisplayItem[]) => RenderPlanEntry[];
};

type DisplayMessage = Message & {
	role?: string;
	thinking?: string;
	images?: { mimeType: string; data: string }[];
	meta?: Record<string, unknown>;
};

type DisplayItem = {
	id: string;
	role: string;
	label: string;
	images: { mimeType: string; data: string }[];
	body: string;
	thinking: string;
	thinkingOnly: boolean;
	thinkingPreview: string;
	text: string;
	expand: { label: string; remaining: number } | null;
	duration: string;
	toolName: string;
	toolDetail: string;
	toolError: boolean;
	toolStatus: string;
	toolState: string;
};

type RenderPlanEntry = {
	type: "single" | "toolGroup";
	item?: DisplayItem;
	key?: string;
	entries?: DisplayItem[];
	running?: boolean;
	failed?: boolean;
	state?: string;
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

	test("历史页与实时 tail 重叠时按内容去掉历史副本", () => {
		const older = [
			message("h1", { role: "user", text: "a" }),
			message("h2", { role: "assistant", text: "b" }),
			message("h3", { role: "tool", text: "c", meta: { toolName: "bash", result: "ok" } }),
		];
		const live = [
			message("l2", { role: "assistant", text: "b" }),
			message("l3", { role: "tool", text: "c", meta: { toolName: "bash", result: "ok" } }),
			message("l4", { role: "assistant", text: "d" }),
		];
		expect(state.mergeTimeline(older, live).map((item) => item.id)).toEqual([
			"h1",
			"l2",
			"l3",
			"l4",
		]);
	});

	test("历史页与实时 tail 无重叠时保留全部消息", () => {
		const older = [message("h1", { text: "a" })];
		const live = [message("l1", { text: "b" })];
		expect(state.mergeTimeline(older, live).map((item) => item.id)).toEqual(["h1", "l1"]);
	});

	test("内容重复时按出现次数去重，不吞掉历史里多出的同文消息", () => {
		const older = [
			message("h1", { role: "user", text: "继续" }),
			message("h2", { role: "user", text: "继续" }),
		];
		const live = [message("l1", { role: "user", text: "继续" })];
		expect(state.mergeTimeline(older, live).map((item) => item.id)).toEqual(["h2", "l1"]);
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

describe("mobile-state 展示项", () => {
	test("工具名映射成中文,未知名字原样返回", () => {
		expect(state.toolNameLabel("bash")).toBe("命令");
		expect(state.toolNameLabel("read_file")).toBe("读取");
		expect(state.toolNameLabel("some_new_tool")).toBe("some_new_tool");
		expect(state.toolNameLabel("")).toBe("工具");
	});

	test("工具行前缀标记被换成中文标签,普通正文不动", () => {
		expect(state.toolLabel("✓ bash ls -la")).toBe("✓ 命令 ls -la");
		expect(state.toolLabel("▶ grep foo")).toBe("▶ 搜索 foo");
		expect(state.toolLabel("普通一行中文")).toBe("普通一行中文");
	});

	test("耗时只在正数时格式化", () => {
		expect(state.durationText(0)).toBe("");
		expect(state.durationText(-5)).toBe("");
		expect(state.durationText(undefined)).toBe("");
		expect(state.durationText(320)).toBe("320ms");
		expect(state.durationText(1500)).toBe("1.5s");
	});

	test("短文本折叠空白并截断", () => {
		expect(state.shortText("  a\n\n b  ")).toBe("a b");
		expect(state.shortText("abcdef", 3)).toBe("ab…");
	});

	test("splitThinking 从最外层 thinking 块里取正文,思考里的字面标签不算边界", () => {
		const parsed = state.splitThinking("<thinking>inner <thinking> nested </thinking> tail</thinking>正文", "");
		expect(parsed.body).toBe("正文");
		expect(parsed.thinking).toContain("nested");
		expect(state.splitThinking("没有思考", "")).toEqual({ body: "没有思考", thinking: "" });
	});

	test("displayItem: 工具消息带上服务端状态文案与摘要", () => {
		const item = state.displayItem({
			id: "m1",
			role: "tool",
			text: "✓ bash echo hi",
			meta: { statusGlyph: "✓", statusText: "完成", summary: "echo hi", durationMs: 1200 },
		});
		expect(item).toMatchObject({
			id: "m1",
			role: "tool",
			toolName: "命令",
			toolStatus: "✓",
			toolState: "完成",
			toolDetail: "echo hi",
			duration: "1.2s",
			toolError: false,
			text: "✓ 命令 echo hi",
		});
	});

	test("displayItem: 展开按钮只在服务端标了 hasMore 时出现,并取两处剩余字数的较大者", () => {
		const noFlag = state.displayItem({ id: "m2", role: "assistant", text: "x".repeat(50), meta: { fullLength: 900 } });
		expect(noFlag.expand).toBeNull();

		const both = state.displayItem({
			id: "m3",
			role: "assistant",
			text: "abc",
			thinking: "xy",
			meta: { hasMore: true, thinkingHasMore: true, fullLength: 10, fullThinkingLength: 20 },
		});
		expect(both.expand).toEqual({ label: "展开全文", remaining: 18 });
	});

	test("displayItem: 纯思考消息保留,空白助手消息由分组丢弃", () => {
		const thinkingOnly = state.displayItem({ id: "m4", role: "assistant", text: "<thinking>想一想</thinking>" });
		expect(thinkingOnly.thinkingOnly).toBe(true);
		const empty = state.displayItem({ id: "m5", role: "assistant", text: "" });
		expect(state.groupDisplayItems([empty]).length).toBe(0);
	});

	test("groupDisplayItems: 连续工具合成一组,状态取运行中优先", () => {
		const tool = (id: string, statusGlyph: string, statusText: string, statusKind?: string) =>
			state.displayItem({ id, role: "tool", text: `${statusGlyph} bash x`, meta: { statusGlyph, statusText, statusKind } });
		const plan = state.groupDisplayItems([
			tool("a", "✓", "完成"),
			tool("b", "▶", "运行中"),
			tool("c", "✗", "失败", "error"),
		]);
		expect(plan.length).toBe(1);
		expect(plan[0]).toMatchObject({ type: "toolGroup", key: "group:a", running: true, failed: true, state: "运行中" });
		expect(plan[0].entries?.length).toBe(3);
	});

	test("groupDisplayItems: 单条工具不折叠,非工具消息各占一条", () => {
		const tool = (id: string) => state.displayItem({ id, role: "tool", text: "✓ bash x", meta: { statusGlyph: "✓" } });
		const user = state.displayItem({ id: "u", role: "user", text: "你好" });
		const plan = state.groupDisplayItems([user, tool("t1"), user]);
		expect(plan.map((entry) => entry.type)).toEqual(["single", "single", "single"]);
		expect(plan.map((entry) => entry.item?.id)).toEqual(["u", "t1", "u"]);
	});
});
