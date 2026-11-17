import assert from "node:assert/strict";
import { test } from "vitest";
import type { ChatMessage } from "../../../shared/types";
import { buildDiffTargetIndex, getToolDiffTarget } from "./toolArgs";

/**
 * ToolArgs 是「工具调用参数 → diff 目标」的唯一实现，顺带提供按会话快照重建
 * 「路径 → 前/后文本」索引（供 diff 打开路径在调用方没带内容时兜底）。
 *
 * 这两件事此前各写一遍：卡片自己按 content|text 取写入内容，索引侧按
 * content|text|data|body 取，于是 `data` 形式的写入会出现「卡片有 chip、索引里却没有内容」。
 * 现在两侧都只走这两个导出，写入内容键的兼容面钉在这里。
 */

function toolMessage(toolName: string, args: unknown, timestamp = 1): ChatMessage {
	return {
		id: `${toolName}-${timestamp}`,
		role: "tool",
		agentId: "agent-1",
		text: "",
		timestamp,
		meta: { toolName, args, status: "done" },
	};
}

test("diff 目标与兜底索引接受同一组写入内容键", () => {
	for (const key of ["content", "text", "data", "body"]) {
		const args = { path: "src/a.ts", [key]: "line1\nline2" };
		const target = getToolDiffTarget("write", args);
		assert.deepEqual(target, { path: "src/a.ts", originalContent: "", content: "line1\nline2" });

		const index = buildDiffTargetIndex([toolMessage("write", args)]);
		assert.equal(index.get("src/a.ts")?.content, "line1\nline2", `write 用 ${key} 时应当进索引`);
	}
});

test("非写文件工具不产生 diff 目标", () => {
	assert.equal(getToolDiffTarget("read", { path: "src/a.ts" }), undefined);
	assert.equal(getToolDiffTarget("bash", { command: "ls" }), undefined);
});

test("缺少路径或内容时不出 diff 目标", () => {
	assert.equal(getToolDiffTarget("write", { content: "x" }), undefined);
	assert.equal(getToolDiffTarget("write", { path: "src/a.ts" }), undefined);
});

test("edit 的 diff 目标取变动区域，新建时 originalContent 为空串", () => {
	const target = getToolDiffTarget("edit", { path: "src/a.ts", oldText: "a", newText: "b" });
	assert.deepEqual(target, { path: "src/a.ts", originalContent: "a", content: "b" });
});

test("同一路径多次修改后索引只留最新一条", () => {
	const index = buildDiffTargetIndex([
		toolMessage("write", { path: "a.ts", content: "1" }, 1),
		toolMessage("write", { path: "b.ts", content: "2" }, 2),
		toolMessage("edit", { path: "a.ts", oldText: "1", newText: "3" }, 3),
	]);
	assert.deepEqual([...index.keys()], ["b.ts", "a.ts"]);
	assert.deepEqual(index.get("a.ts"), { path: "a.ts", originalContent: "1", content: "3" });
	assert.deepEqual(index.get("b.ts"), { path: "b.ts", originalContent: "", content: "2" });
});

test("后一条读不出内容时沿用前一条，不把已有内容冲空", () => {
	// edit/patch 的 old/new 可能被截断；沿用上一条比丢掉完整内容更有用。
	const index = buildDiffTargetIndex([
		toolMessage("write", { path: "a.ts", content: "full" }, 1),
		toolMessage("write", { path: "a.ts" }, 2),
	]);
	assert.deepEqual(index.get("a.ts"), { path: "a.ts", originalContent: "", content: "full" });
});

test("只有路径、没有内容键的写入仍然进索引", () => {
	const index = buildDiffTargetIndex([toolMessage("write", { path: "c.ts" })]);
	assert.deepEqual([...index.keys()], ["c.ts"]);
	assert.equal(index.get("c.ts")?.content, undefined);
});
