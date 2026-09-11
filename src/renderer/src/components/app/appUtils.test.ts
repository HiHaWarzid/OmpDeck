import { describe, expect, it } from "vitest";
import { sameChatMessageForRender, sameImageListForRender } from "./AppUtils";
import type { ChatMessage, ImageContent } from "../../../../shared/types";

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
});
