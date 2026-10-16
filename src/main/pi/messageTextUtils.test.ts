import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/types";
import { MAX_TOOL_RESULT_CHARS, compactJsonLength, estimateMessageBytes } from "./messageTextUtils";

/**
 * 容量预算的度量口径。旧实现只算 text/thinking/images，于是每条最多 8K 字符的
 * 工具卡详情（meta.detailText/result/args）与未截断的 details/archivedMessages
 * 对预算完全不可见——预算检查恒为「没超」，保护形同虚设。
 */
describe("estimateMessageBytes", () => {
	it("文本与思考按 UTF-16 计，图片按 base64 串长计", () => {
		const message: ChatMessage = {
			id: "m",
			agentId: "a",
			role: "assistant",
			text: "x".repeat(1_000),
			thinking: "y".repeat(500),
			images: [{ type: "image", data: "z".repeat(2_048), mimeType: "image/png" }],
			timestamp: 0,
		};

		expect(estimateMessageBytes(message)).toBeGreaterThanOrEqual(1_000 * 2 + 500 * 2 + 2_048);
	});

	it("计入 meta 中已被截断的文本字段（detailText/result/args）", () => {
		const message: ChatMessage = {
			id: "m",
			agentId: "a",
			role: "tool",
			text: "✓ read",
			timestamp: 0,
			meta: {
				result: "r".repeat(MAX_TOOL_RESULT_CHARS),
				detailText: "d".repeat(MAX_TOOL_RESULT_CHARS),
				args: "a".repeat(MAX_TOOL_RESULT_CHARS),
			},
		};

		expect(estimateMessageBytes(message)).toBeGreaterThan(MAX_TOOL_RESULT_CHARS * 2 * 3);
	});

	it("计入 meta 中未截断的结构化详情（details/archivedMessages）", () => {
		const plain: ChatMessage = {
			id: "m",
			agentId: "a",
			role: "tool",
			text: "✓ read",
			timestamp: 0,
			meta: { result: "r" },
		};
		const withDetails: ChatMessage = {
			...plain,
			meta: { result: "r", details: { phases: [{ todos: [{ content: "x".repeat(100_000) }] }] } },
		};

		expect(estimateMessageBytes(withDetails)).toBeGreaterThan(estimateMessageBytes(plain) + 100_000);
	});

	it("嵌套详情按紧凑序列化计价，不被 pretty 缩进虚增", () => {
		const details = { phases: Array.from({ length: 500 }, (_, index) => ({ index, content: "x".repeat(50) })) };
		const message: ChatMessage = {
			id: "m",
			agentId: "a",
			role: "tool",
			text: "✓ read",
			timestamp: 0,
			meta: { details },
		};

		const bytes = estimateMessageBytes(message);
		// 口径不得低于紧凑体积（否则预算漏计），也不得按 2 空格缩进的 pretty 体积虚增
		expect(bytes).toBeGreaterThanOrEqual(compactJsonLength(details) * 2);
		expect(bytes).toBeLessThan(JSON.stringify(details, null, 2).length * 2);
	});
});
