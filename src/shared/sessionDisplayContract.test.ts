import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./types";
import {
	COMPACT_THINKING_LIMIT,
	COMPACT_TOOL_TEXT_LIMIT,
	TOOL_SUMMARY_MAX_CHARS,
	attachDisplayMeta,
	compactChatMessage,
	deliveryKind,
	displayPath,
	formatTimestamp,
	isTopLevelSessionSummary,
	sessionStatusKind,
	shortText,
	stripAnsi,
	toolArgPath,
	toolArgSummary,
	toolStatusKind,
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

	it("已派生的语义值可重复解析（compact 幂等）", () => {
		expect(deliveryKind("follow-up")).toBe("follow-up");
	});
});

describe("formatTimestamp", () => {
	it("short 与 full 是同一实现的两种呈现形式", () => {
		const at = Date.UTC(2026, 0, 2, 3, 4, 5);
		expect(formatTimestamp(at)).toBe(formatTimestamp(at, "short"));
		expect(formatTimestamp(at)).not.toBe(formatTimestamp(at, "full"));
		expect(formatTimestamp(at, "full")).toBe(new Date(at).toLocaleString());
	});
});

describe("stripAnsi", () => {
	it("去掉转义码，无转义码时返回同一字符串对象", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
		const clean = "clean text";
		expect(stripAnsi(clean)).toBe(clean);
	});
});

describe("displayPath", () => {
	const home = "C:/Users/me";

	it("tail：折叠 home 前缀，超长时保留尾部", () => {
		expect(displayPath("C:\\Users\\me\\proj\\a.ts", { home })).toBe("~/proj/a.ts");
		const long = `C:/Users/me/${"segment/".repeat(6)}file.ts`;
		const shown = displayPath(long, { home });
		expect(shown.startsWith("...")).toBe(true);
		expect(shown.endsWith("file.ts")).toBe(true);
	});

	it("head：保留末两段，段数不足时原样返回", () => {
		expect(displayPath("C:\\sessions\\parent\\child.jsonl", { style: "head" })).toBe(
			".../parent/child.jsonl",
		);
		expect(displayPath("C:/only", { style: "head" })).toBe("C:/only");
		expect(displayPath(undefined)).toBe("");
	});
});

describe("toolArgPath", () => {
	it("只认路径类键，不拿命令/搜索词冒充文件路径", () => {
		expect(toolArgPath({ path: "a.ts", command: "ls" })).toBe("a.ts");
		expect(toolArgPath({ targetPath: "b.ts" })).toBe("b.ts");
		expect(toolArgPath({ command: "ls" })).toBeUndefined();
		expect(toolArgPath(undefined)).toBeUndefined();
	});
});

describe("toolStatusKind", () => {
	it("显式 status 优先，其次正文首字符标记", () => {
		expect(toolStatusKind({ status: "running" })).toBe("running");
		expect(toolStatusKind({ status: "error" })).toBe("error");
		expect(toolStatusKind({ isError: true })).toBe("error");
		expect(toolStatusKind({}, "▶ bash")).toBe("running");
		expect(toolStatusKind({}, "✗ bash")).toBe("error");
		expect(toolStatusKind({}, "✓ bash")).toBe("done");
	});
});

describe("sessionStatusKind", () => {
	it("五个契约状态，未知值归一到 idle", () => {
		expect(sessionStatusKind("running")).toBe("running");
		expect(sessionStatusKind("starting")).toBe("starting");
		expect(sessionStatusKind("error")).toBe("error");
		expect(sessionStatusKind("closed")).toBe("closed");
		expect(sessionStatusKind(undefined)).toBe("idle");
		expect(sessionStatusKind("weird")).toBe("idle");
	});
});

describe("attachDisplayMeta", () => {
	it("不截断文本，只补派生字段（详情端点复用）", () => {
		const text = "x".repeat(COMPACT_TOOL_TEXT_LIMIT + 5);
		const attached = attachDisplayMeta(toolMessage({ text }));
		expect(attached.text).toBe(text);
		expect(attached.meta).toMatchObject({ statusText: "完成", statusGlyph: "✓" });
		expect(attached.meta?.hasMore).toBeUndefined();
	});

	it("重复调用返回同一对象", () => {
		const attached = attachDisplayMeta(toolMessage({ text: "✓ bash" }));
		expect(attachDisplayMeta(attached)).toBe(attached);
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

	it("无附加内容时不产生新对象（非 tool 且无投递语义）", () => {
		const message = toolMessage({ role: "assistant", text: "answer" });
		expect(compactChatMessage(message)).toBe(message);
	});

	it("tool 消息始终附加状态三件套，供手机端直接渲染", () => {
		const compacted = compactChatMessage(toolMessage({ meta: { status: "running" } }));
		expect(compacted.meta).toMatchObject({
			statusKind: "running",
			statusText: "运行中",
			statusGlyph: "▶",
		});
	});

	it("投递语义同时产出语义值与文案，且重复 compact 幂等", () => {
		const once = compactChatMessage(
			toolMessage({ role: "user", text: "继续", meta: { streamingBehavior: "followUp" } }),
		);
		expect(once.meta).toMatchObject({ delivery: "follow-up", deliveryText: "结束后排队" });
		expect(compactChatMessage(once)).toBe(once);
	});
});
