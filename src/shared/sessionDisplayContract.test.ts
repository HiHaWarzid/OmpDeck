import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./types";
import {
	COMPACT_THINKING_LIMIT,
	COMPACT_TOOL_TEXT_LIMIT,
	TOOL_SUMMARY_MAX_CHARS,
	compactChatMessage,
	deliveryKind,
	isTopLevelSessionSummary,
	shortText,
	toolArgSummary,
	toolSummaryFromMeta,
} from "./sessionDisplayContract";

function toolMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: "m1",
		agentId: "a1",
		role: "tool",
		text: "✓ bash",
		timestamp: 1,
		...overrides,
	};
}

describe("isTopLevelSessionSummary", () => {
	it("仅 parentSessionPath / codex 子会话算子会话", () => {
		expect(isTopLevelSessionSummary({})).toBe(true);
		expect(isTopLevelSessionSummary({ parentSessionPath: "C:\\x.jsonl" })).toBe(false);
		expect(isTopLevelSessionSummary({ codexParentThreadId: "t1" })).toBe(false);
		expect(isTopLevelSessionSummary({ codexThreadSource: "subagent" })).toBe(false);
		expect(isTopLevelSessionSummary({ codexThreadSource: "root" })).toBe(true);
	});
});

describe("toolArgSummary", () => {
	it("按统一优先级取第一个非空字符串（路径优先于命令）", () => {
		expect(toolArgSummary({ command: "ls", path: "src/a.ts" })).toBe("src/a.ts");
		expect(toolArgSummary({ command: "npm test" })).toBe("npm test");
		expect(toolArgSummary({ cmd: "npm test" })).toBe("npm test");
	});

	it("兼容 JSON 字符串参数与数组首项", () => {
		expect(toolArgSummary(JSON.stringify({ filePath: "a.ts" }))).toBe("a.ts");
		expect(toolArgSummary({ queries: ["one", "two"] })).toBe("one");
		expect(toolArgSummary("{not json")).toBeUndefined();
	});

	it("参数缺失时回退历史平铺 meta 字段", () => {
		expect(toolArgSummary(undefined, { command: "pwd" })).toBe("pwd");
		expect(toolArgSummary({}, { file: "b.ts" })).toBe("b.ts");
	});

	it("全部缺失时取参数对象里第一个字符串值", () => {
		expect(toolArgSummary({ unknownKey: "fallback" })).toBe("fallback");
	});
});

describe("toolSummaryFromMeta", () => {
	it("优先摘要，其次 detailText 正文行，最后 result", () => {
		expect(toolSummaryFromMeta({ summary: "npm run build" })).toBe("npm run build");
		expect(
			toolSummaryFromMeta({ detailText: "状态：running\nnpm run test" }),
		).toBe("npm run test");
		expect(toolSummaryFromMeta({ result: "  done\n" })).toBe("done");
	});

	it("无任何信息时返回空串", () => {
		expect(toolSummaryFromMeta(undefined)).toBe("");
		expect(toolSummaryFromMeta({})).toBe("");
	});
});

describe("shortText", () => {
	it("折叠空白并按上限截断（含省略号）", () => {
		expect(shortText("a\n\n  b ")).toBe("a b");
		const clipped = shortText("x".repeat(TOOL_SUMMARY_MAX_CHARS + 10));
		expect(clipped.length).toBe(TOOL_SUMMARY_MAX_CHARS);
		expect(clipped.endsWith("…")).toBe(true);
	});
});

describe("deliveryKind", () => {
	it("把 RPC 原始值映射成语义值", () => {
		expect(deliveryKind("followUp")).toBe("follow-up");
		expect(deliveryKind("steer")).toBe("steer");
		expect(deliveryKind(undefined)).toBeNull();
		expect(deliveryKind("other")).toBeNull();
	});
});

describe("compactChatMessage", () => {
	it("超长工具输出截断并标记 hasMore/fullLength", () => {
		const text = "x".repeat(COMPACT_TOOL_TEXT_LIMIT + 5);
		const compacted = compactChatMessage(toolMessage({ text }));
		expect(compacted.text.length).toBe(COMPACT_TOOL_TEXT_LIMIT);
		expect(compacted.meta).toMatchObject({ hasMore: true, fullLength: text.length });
	});

	it("超长 thinking 截断并标记，原文对象不被修改", () => {
		const thinking = "t".repeat(COMPACT_THINKING_LIMIT + 5);
		const original = toolMessage({ text: "answer", role: "assistant", thinking });
		const compacted = compactChatMessage(original);
		expect(compacted.thinking?.length).toBe(COMPACT_THINKING_LIMIT);
		expect(compacted.meta).toMatchObject({
			thinkingHasMore: true,
			fullThinkingLength: thinking.length,
		});
		expect(original.thinking).toBe(thinking);
		expect(original.meta).toBeUndefined();
	});

	it("工具消息附加参数摘要，供手机端直接渲染", () => {
		const compacted = compactChatMessage(
			toolMessage({ meta: { toolName: "bash", args: '{"command":"npm test"}' } }),
		);
		expect(compacted.meta?.summary).toBe("npm test");
	});

	it("投递策略写成语义值 delivery", () => {
		const compacted = compactChatMessage(
			toolMessage({ role: "user", text: "继续", meta: { streamingBehavior: "followUp" } }),
		);
		expect(compacted.meta?.delivery).toBe("follow-up");
	});

	it("无附加内容时原样返回（不产生新对象）", () => {
		const message = toolMessage();
		expect(compactChatMessage(message)).toBe(message);
	});
});
