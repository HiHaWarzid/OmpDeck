import { describe, expect, it } from "vitest";
import {
	groupToolMessages,
	sameChatMessageForRender,
	sameImageListForRender,
} from "./timelineProjection";
import type { ChatMessage, ImageContent } from "../../../../../shared/types";

/**
 * 渲染 memo 比较器的契约。
 *
 * 这些比较器运行在 memo 内层比较函数里，父组件每次渲染都会调用。历史缺陷：
 * 按引用比较 images（TurnRow 每轮重拼数组）→ memo 恒定失效，流式期间每个 delta
 * 都让整轮历史消息重新解析 markdown；以及缺少引用短路导致无条件深比较。
 */

const image = (data: string): ImageContent => ({ type: "image", mimeType: "image/png", data });

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: "m1",
		role: "assistant",
		text: "hello",
		timestamp: 1,
		...overrides,
	} as ChatMessage;
}

describe("sameImageListForRender", () => {
	it("treats rebuilt arrays with equal content as unchanged", () => {
		// 关键契约：TurnRow 每轮渲染重拼 images，内容相同即应跳过重渲染。
		expect(sameImageListForRender([image("a")], [image("a")])).toBe(true);
	});

	it("detects different or added images", () => {
		expect(sameImageListForRender([image("a")], [image("b")])).toBe(false);
		expect(sameImageListForRender([image("a")], [image("a"), image("b")])).toBe(false);
		expect(sameImageListForRender([image("a")], [image("a")])).toBe(true);
	});

	it("treats undefined and empty as equivalent", () => {
		expect(sameImageListForRender(undefined, [])).toBe(true);
		expect(sameImageListForRender(undefined, undefined)).toBe(true);
	});

	it("short-circuits on identical reference", () => {
		const list = [image("a")];
		expect(sameImageListForRender(list, list)).toBe(true);
	});
});

describe("sameChatMessageForRender", () => {
	it("returns true for the same reference", () => {
		const m = message();
		expect(sameChatMessageForRender(m, m)).toBe(true);
	});

	it("returns true for equal content in distinct objects", () => {
		expect(sameChatMessageForRender(message(), message())).toBe(true);
	});

	it("returns false when streamed text differs", () => {
		expect(sameChatMessageForRender(message(), message({ text: "hello!" }))).toBe(false);
	});

	it("compares images by content, not reference", () => {
		const previous = message({ images: [image("a")] } as Partial<ChatMessage>);
		const next = message({ images: [image("a")] } as Partial<ChatMessage>);
		expect(sameChatMessageForRender(previous, next)).toBe(true);
	});

	it("returns false when only meta changed (tool status running -> completed)", () => {
		// 工具卡的状态/参数/详情只住在 meta 里：早前漏比较 meta，工具卡会停留在 running。
		const previous = message({ meta: { toolName: "bash", status: "running" } } as Partial<ChatMessage>);
		const next = message({ meta: { toolName: "bash", status: "completed" } } as Partial<ChatMessage>);
		expect(sameChatMessageForRender(previous, next)).toBe(false);
	});

	it("returns true when meta is the same reference", () => {
		const meta = { toolName: "bash", status: "completed" };
		const previous = message({ meta } as Partial<ChatMessage>);
		const next = message({ meta } as Partial<ChatMessage>);
		expect(sameChatMessageForRender(previous, next)).toBe(true);
	});
});

describe("groupToolMessages", () => {
	const user = (id: string, timestamp: number) =>
		message({ id, role: "user", text: "ask", timestamp });
	const assistant = (id: string, text: string, timestamp: number) =>
		message({ id, role: "assistant", text, timestamp });
	const tool = (id: string, timestamp: number) =>
		message({ id, role: "tool", text: "", timestamp, meta: { toolName: "bash" } });
	const system = (id: string, timestamp: number) =>
		message({ id, role: "system", text: "question", timestamp });

	it("buckets a user turn into one agent-run starting at the user timestamp", () => {
		const runs = groupToolMessages([
			user("u1", 100),
			tool("t1", 110),
			assistant("a1", "done", 120),
		]);
		expect(runs.map((item) => item.kind)).toEqual(["message", "agent-run"]);
		const run = runs[1];
		expect(run.kind === "agent-run" && [run.startedAt, run.endedAt]).toEqual([100, 120]);
		expect(run.kind === "agent-run" && run.items.map((item) => item.kind)).toEqual([
			"tool-group",
			"message",
		]);
	});

	it("merges consecutive assistant texts into one bubble", () => {
		const runs = groupToolMessages([user("u1", 1), assistant("a1", "one", 2), assistant("a2", "two", 3)]);
		const run = runs[1];
		const items = run.kind === "agent-run" ? run.items : [];
		expect(items).toHaveLength(1);
		expect(items[0].kind === "message" && items[0].message.text).toBe("one\n\ntwo");
		expect(items[0].kind === "message" && items[0].message.id).toBe("a1|a2");
	});

	it("does not carry tools into the next turn when the previous turn never answered", () => {
		// 上一轮只有工具、用户又问新问题：必须切段，否则工具会混进下一轮回答块。
		const runs = groupToolMessages([user("u1", 1), tool("t1", 2), user("u2", 3), assistant("a1", "hi", 4)]);
		expect(runs.map((item) => item.kind)).toEqual(["message", "agent-run", "message", "agent-run"]);
		const first = runs[1];
		expect(first.kind === "agent-run" && first.items.map((item) => item.kind)).toEqual(["tool-group"]);
	});

	it("stages tools that precede an ask_question card into the run that follows the answer", () => {
		// ask_question：system 卡片不中断 agent-run，卡片前的工具/思考要与随后的回答同属一轮，
		// 否则会被拆成两个折叠区域。暂存只在本轮尚无 assistant 文本时生效（见「上一轮没有回答」
		// 用例）：普通新提问必须切段，不能借这条路径把上一轮工具混进下一轮。
		const runs = groupToolMessages([
			user("u1", 1),
			message({ id: "th1", role: "assistant", text: "", thinking: "hmm", timestamp: 2 }),
			tool("t1", 3),
			system("s1", 4),
			user("u2", 5),
			assistant("a1", "hi", 6),
		]);
		expect(runs.map((item) => item.kind)).toEqual(["message", "message", "message", "agent-run"]);
		const run = runs[3];
		expect(run.kind === "agent-run" && run.items.map((item) => item.kind)).toEqual([
			"thinking-group",
			"tool-group",
			"message",
		]);
	});

	it("folds thinking-only messages into a thinking-group with timing", () => {
		const runs = groupToolMessages([
			user("u1", 1),
			message({ id: "th1", role: "assistant", text: "", thinking: "hmm", timestamp: 2 }),
			assistant("a1", "done", 3),
		]);
		const run = runs[1];
		const items = run.kind === "agent-run" ? run.items : [];
		expect(items.map((item) => item.kind)).toEqual(["thinking-group", "message"]);
		const group = items[0];
		expect(group.kind === "thinking-group" && group.text).toBe("hmm");
		expect(group.kind === "thinking-group" && group.startedAt).toBeLessThanOrEqual(
			group.kind === "thinking-group" ? group.endedAt : 0,
		);
	});
});
