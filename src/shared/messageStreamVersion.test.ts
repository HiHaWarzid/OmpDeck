import { describe, expect, it } from "vitest";
import { messageStreamVersion } from "./messageStreamVersion";
import type { ChatMessage } from "./types";

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: "m1",
		agentId: "a1",
		role: "assistant",
		text: "hello",
		timestamp: 100,
		...overrides,
	};
}

describe("messageStreamVersion（W6-18 消息流版本）", () => {
	it("空数组稳定为空版本", () => {
		expect(messageStreamVersion([])).toBe("0::0:0");
	});

	it("相同内容版本稳定（轮询缓存可复用）", () => {
		const a = messageStreamVersion([msg({ text: "" }), msg({ id: "m2", text: "" })]);
		const b = messageStreamVersion([msg({ text: "" }), msg({ id: "m2", text: "" })]);
		expect(a).toBe(b);
	});

	it("流式追加改变版本（长度 + 末条变化）", () => {
		const v1 = messageStreamVersion([msg()]);
		const v2 = messageStreamVersion([msg(), msg({ id: "m2", timestamp: 200, text: "world" })]);
		expect(v2).not.toBe(v1);
	});

	it("末条就地更新改变版本（text/timestamp 变化）", () => {
		const v1 = messageStreamVersion([msg()]);
		expect(messageStreamVersion([msg({ text: "edited" })])).not.toBe(v1);
		expect(messageStreamVersion([msg({ timestamp: 101 })])).not.toBe(v1);
	});

	it("消息增删改变版本", () => {
		const one = messageStreamVersion([msg()]);
		expect(messageStreamVersion([msg(), msg({ id: "m2" })])).not.toBe(one);
		expect(messageStreamVersion([])).not.toBe(one);
	});

	it("中部消息就地更新不改变版本（与历史指纹语义一致：只盯尾部）", () => {
		const v1 = messageStreamVersion([msg({ id: "first" }), msg({ id: "last", text: "tail" })]);
		const changed = messageStreamVersion([
			msg({ id: "first", text: "EDITED MIDDLE" }),
			msg({ id: "last", text: "tail" }),
		]);
		expect(changed).toBe(v1);
	});

	it("末条 id 或文本长度相同但内容不同的消息不被区分（已知限制，锁定语义）", () => {
		const v1 = messageStreamVersion([msg({ id: "x", text: "aaaa" })]);
		const v2 = messageStreamVersion([msg({ id: "x", text: "bbbb" })]);
		expect(v1).toBe(v2);
	});
});