import assert from "node:assert/strict";
import { test } from "vitest";

import type { ChatMessage } from "../../shared/types";
import { SessionJsonl } from "./sessionJsonl";
import {
	deleteEntry,
	editEntryText,
	truncateForResend,
} from "./sessionRewriteMutations";

/** 最小可用的 ChatMessage（改写只需要 id / agentId / role / text / meta.entryId）。 */
function message(overrides: {
	id: string;
	role: ChatMessage["role"];
	text: string;
	entryId?: string;
}): ChatMessage {
	return {
		id: overrides.id,
		agentId: "agent-1",
		role: overrides.role,
		text: overrides.text,
		timestamp: 0,
		meta: overrides.entryId ? { entryId: overrides.entryId } : {},
	} as ChatMessage;
}

function linesOf(entries: unknown[]): string[] {
	return entries.map((entry) => JSON.stringify(entry));
}

function parse(lines: string[], index: number): Record<string, unknown> {
	return JSON.parse(lines[index]) as Record<string, unknown>;
}

/** 用真实 SessionJsonl 的定位实现，避免测试复制一份定位规则。 */
const locate = (lines: string[], messages: ChatMessage[], msg: ChatMessage) =>
	new SessionJsonl({ resolveHostPath: (p) => p }).locateEntry(lines, messages, msg);

const userEntry = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	message: { role: "user", content: [{ type: "text", text }] },
});

const assistantEntry = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	message: { role: "assistant", content: [{ type: "text", text }] },
});

test("editEntryText rewrites the text block in place", () => {
	const lines = linesOf([userEntry("e1", null, "old prompt")]);
	const messages = [message({ id: "m1", role: "user", text: "old prompt", entryId: "e1" })];

	editEntryText({ lines, messages, messageId: "m1", newText: "new prompt", locate });

	const entry = parse(lines, 0) as { message: { content: Array<{ text: string }> } };
	assert.equal(entry.message.content[0].text, "new prompt");
	assert.equal(lines.length, 1, "编辑不该改变行数：行号是 entryId 对齐的锚点");
});

test("editEntryText appends a text block when the message has none", () => {
	const lines = linesOf([
		{ type: "message", id: "e1", parentId: null, message: { role: "assistant", content: [] } },
	]);
	const messages = [message({ id: "m1", role: "assistant", text: "", entryId: "e1" })];

	editEntryText({ lines, messages, messageId: "m1", newText: "filled in", locate });

	const entry = parse(lines, 0) as { message: { content: Array<{ type: string; text: string }> } };
	assert.deepEqual(entry.message.content, [{ type: "text", text: "filled in" }]);
});

test("editEntryText refuses tool-result entries", () => {
	const lines = linesOf([
		{ type: "message", id: "e1", parentId: null, message: { role: "toolResult", content: "ok" } },
	]);
	const messages = [message({ id: "m1", role: "tool" as ChatMessage["role"], text: "ok", entryId: "e1" })];

	assert.throws(
		() => editEntryText({ lines, messages, messageId: "m1", newText: "x", locate }),
		/Only user and assistant messages can be edited/,
	);
	// 拒绝时必须保持文件内容不变，否则半改写的行会被 modifyLines 备份写回。
	assert.equal(parse(lines, 0).id, "e1");
});

test("deleteEntry tombstones the line and re-parents direct children", () => {
	const lines = linesOf([
		userEntry("e1", null, "keep"),
		assistantEntry("e2", "e1", "doomed"),
		{ type: "message", id: "e3", parentId: "e2", message: { role: "user", content: [{ type: "text", text: "child" }] } },
	]);
	const messages = [message({ id: "m2", role: "assistant", text: "doomed", entryId: "e2" })];

	deleteEntry({ lines, messages, messageId: "m2", locate });

	const tombstone = parse(lines, 1);
	assert.equal(tombstone.type, "deleted");
	assert.equal(tombstone.originalEntryId, "e2");
	assert.equal("id" in tombstone, false, "占位行不能带 id，否则 get_entries 会把它当活跃 entry");
	// 子节点重挂到被删节点的父节点，否则 pi 重载时会丢弃整个分支。
	assert.equal(parse(lines, 2).parentId, "e1");
	assert.equal(lines.length, 3, "删除保留行号");
});

test("truncateForResend tombstones the target user and every descendant", () => {
	const lines = linesOf([
		userEntry("e1", null, "first"),
		assistantEntry("e2", "e1", "answer 1"),
		userEntry("e3", "e2", "second"),
		assistantEntry("e4", "e3", "answer 2"),
	]);
	const messages = [message({ id: "m3", role: "user", text: "second", entryId: "e3" })];

	const result = truncateForResend({ lines, messages, msg: messages[0], locate });

	assert.equal(result.rootEntryId, "e3");
	assert.equal(result.removed, 2);
	assert.equal(parse(lines, 0).type, "message", "root 之前的历史必须保留");
	assert.equal(parse(lines, 1).type, "message");
	assert.equal(parse(lines, 2).type, "deleted");
	assert.equal(parse(lines, 3).type, "deleted");
});

test("truncateForResend blocks when the root is not the last user message", () => {
	// 定位到的 root 之后还有另一条 user：截断它的后代会把中间整段历史一起删掉。
	const lines = linesOf([
		userEntry("e1", null, "first"),
		assistantEntry("e2", "e1", "answer"),
		userEntry("e3", "e2", "later"),
	]);
	const messages = [message({ id: "m1", role: "user", text: "first", entryId: "e1" })];
	let blocked = false;

	assert.throws(
		() =>
			truncateForResend({
				lines,
				messages,
				msg: messages[0],
				locate,
				onBlocked: () => {
					blocked = true;
				},
			}),
		/refusing to truncate earlier history/,
	);
	assert.equal(blocked, true);
	assert.ok(lines.every((line) => !line.includes('"type":"deleted"')), "拒绝时不得改动任何行");
});

test("truncateForResend corrects a stale entryId that points at an earlier duplicate", () => {
	// get_entries 与 get_messages 排列错位：旧 entryId 指向更早的同文案 user。
	// 该行角色与文本都匹配，断言层放行，靠「最后一条同文案」二次校验纠正。
	const lines = linesOf([
		userEntry("e1", null, "repeat"),
		assistantEntry("e2", "e1", "old answer"),
		userEntry("e3", "e2", "repeat"),
		assistantEntry("e4", "e3", "new answer"),
	]);
	const messages = [message({ id: "m-repeat", role: "user", text: "repeat", entryId: "e1" })];
	let corrected: { originalLine: number; correctedLine: number } | undefined;

	const result = truncateForResend({
		lines,
		messages,
		msg: messages[0],
		locate,
		onDuplicateCorrected: (detail) => {
			corrected = detail;
		},
	});

	assert.deepEqual(
		corrected && { originalLine: corrected.originalLine, correctedLine: corrected.correctedLine },
		{ originalLine: 0, correctedLine: 2 },
	);
	assert.equal(result.rootEntryId, "e3", "必须截断真正最后一条 user");
	assert.equal(parse(lines, 0).type, "message");
	assert.equal(parse(lines, 1).type, "message");
	assert.equal(parse(lines, 2).type, "deleted");
	assert.equal(parse(lines, 3).type, "deleted");
});

test("truncateForResend never re-resolves the message after the file was read", () => {
	// 角色校验在 SessionRewrite 的 prepare 阶段完成（读文件之前）。写盘路径必须
	// 沿用那次解析结果：转录若在读取文件期间被替换，二次查找会变成 Message not found，
	// 而文件此时已被改写——用户看到失败提示，内容却已经截断。
	const lines = linesOf([userEntry("e1", null, "q"), assistantEntry("e2", "e1", "a")]);
	const prepared = message({ id: "m1", role: "user", text: "q", entryId: "e1" });

	const result = truncateForResend({ lines, messages: [], msg: prepared, locate });

	assert.equal(result.rootEntryId, "e1");
	assert.equal(parse(lines, 0).type, "deleted");
	assert.equal(parse(lines, 1).type, "deleted");
});
