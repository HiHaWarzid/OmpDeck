import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "../../shared/types";
import {
	buildActiveBranchEntryIds,
	buildAskCard,
	convertAgentMessages,
	extractAskQuestionDetails,
	extractImages,
	extractThinking,
	extractToolResultText,
	getToolPathFromArgs,
	safeJson,
	stripAnsi,
	truncateForDetail,
	trimHistoryMessages,
	tryParseBatchAskEnvelope,
} from "./messageTimeline";

// ── trimHistoryMessages ─────────────────────────────────

test("trimHistoryMessages returns all when fewer than maxTurns", () => {
	const msgs = [{ role: "user" }, { role: "assistant" }, { role: "user" }];
	const result = trimHistoryMessages(msgs, 40);
	assert.equal(result.length, 3);
});

test("trimHistoryMessages keeps last N user turns", () => {
	const msgs: unknown[] = [];
	for (let i = 0; i < 50; i++) {
		msgs.push({ role: "user", content: [{ type: "text", text: `q${i}` }] });
		msgs.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
	}
	const result = trimHistoryMessages(msgs, 5);
	// 5 user turns = 10 messages (5 user + 5 assistant)
	assert.equal(result.length, 10);
	// First user should be q45
	const first = result[0] as { content: Array<{ text: string }> };
	assert.equal(first.content[0].text, "q45");
});

test("trimHistoryMessages falls back to last 50 when no user messages", () => {
	const msgs = Array.from({ length: 100 }, (_, i) => ({ role: "assistant", content: [] }));
	const result = trimHistoryMessages(msgs, 40);
	assert.equal(result.length, 50);
});

test("trimHistoryMessages handles empty array", () => {
	assert.equal(trimHistoryMessages([], 40).length, 0);
});

// ── buildActiveBranchEntryIds ───────────────────────────

test("buildActiveBranchEntryIds walks parent chain from leaf", () => {
	const entries = [
		{ id: "root", parentId: null, type: "session" },
		{ id: "m1", parentId: "root", type: "message" },
		{ id: "m2", parentId: "m1", type: "message" },
		{ id: "m3", parentId: "m2", type: "message" },
	];
	const result = buildActiveBranchEntryIds(entries, "m3");
	assert.deepEqual(result, ["m1", "m2", "m3"]);
});

test("buildActiveBranchEntryIds filters non-message types", () => {
	const entries = [
		{ id: "root", parentId: null, type: "session" },
		{ id: "mc", parentId: "root", type: "model_change" },
		{ id: "m1", parentId: "mc", type: "message" },
	];
	const result = buildActiveBranchEntryIds(entries, "m1");
	assert.deepEqual(result, ["m1"]);
});

// ── convertAgentMessages ────────────────────────────────

test("convertAgentMessages converts user and assistant messages", () => {
	const raw = [
		{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
		{ role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: 2000 },
	];
	const result = convertAgentMessages("agent-1", raw, undefined, false);
	assert.equal(result.length, 2);
	assert.equal(result[0].role, "user");
	assert.equal(result[0].text, "hello");
	assert.equal(result[1].role, "assistant");
	assert.equal(result[1].text, "hi there");
});

test("convertAgentMessages skips empty user messages", () => {
	const raw = [
		{ role: "user", content: [{ type: "text", text: "  " }], timestamp: 1000 },
		{ role: "assistant", content: [{ type: "text", text: "response" }], timestamp: 2000 },
	];
	const result = convertAgentMessages("agent-1", raw, undefined, false);
	assert.equal(result.length, 1);
	assert.equal(result[0].role, "assistant");
});

test("convertAgentMessages preserves thinking on empty-text assistant", () => {
	const raw = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "deep thought" }], timestamp: 1000 },
	];
	const result = convertAgentMessages("agent-1", raw, undefined, false);
	assert.equal(result.length, 1);
	assert.ok(result[0].thinking);
});

test("convertAgentMessages handles toolResult with historical toolCall", () => {
	const raw = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/foo.txt" } }],
			timestamp: 1000,
		},
		{
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			timestamp: 2000,
		},
	];
	const result = convertAgentMessages("agent-1", raw, undefined, false);
	// assistant with toolCall has no text/thinking -> skipped; toolResult kept
	assert.equal(result.length, 1);
	assert.equal(result[0].role, "tool");
	assert.ok(result[0]!.meta!.toolName);
});

test("convertAgentMessages handles compactionSummary", () => {
	const raw = [
		{ role: "compactionSummary", summary: "Compacted session", timestamp: 1000 },
	];
	const result = convertAgentMessages("agent-1", raw, undefined, false);
	assert.equal(result.length, 1);
	assert.equal(result[0].role, "system");
	assert.equal(result[0]!.meta!.type, "compaction");
});

test("convertAgentMessages aborted flag nullifies askCard answer", () => {
	const raw = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "ask_question", arguments: { question: "q?", type: "input" } }],
			timestamp: 1000,
		},
		{
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "ask_question",
			content: [{ type: "text", text: "my answer" }],
			details: { question: "q?", type: "input", answer: "my answer", answered: true },
			timestamp: 2000,
		},
	];
	const notAborted = convertAgentMessages("a", raw, undefined, false);
	const aborted = convertAgentMessages("a", raw, undefined, true);
	const askCardNormal = notAborted.find((m) => m.meta?._askCard)?.meta?._askCard as Record<string, unknown> | undefined;
	const askCardAborted = aborted.find((m) => m.meta?._askCard)?.meta?._askCard as Record<string, unknown> | undefined;
	assert.ok(askCardNormal);
	assert.ok(askCardAborted);
	assert.equal(askCardNormal.answered, true);
	assert.equal(askCardAborted.answered, false);
});

// ── buildAskCard ────────────────────────────────────────

test("buildAskCard returns undefined for no details", () => {
	assert.equal(buildAskCard(undefined, false), undefined);
});

test("buildAskCard single question not aborted shows answer", () => {
	const details = { question: "What?", type: "input", answer: "42", answered: true };
	const card = buildAskCard(details, false) as Record<string, unknown>;
	assert.equal(card.question, "What?");
	assert.equal(card.answered, true);
	assert.equal(card.answer, "42");
});

test("buildAskCard single question aborted hides answer", () => {
	const details = { question: "What?", type: "input", answer: "42", answered: true };
	const card = buildAskCard(details, true) as Record<string, unknown>;
	assert.equal(card.answered, false);
	assert.equal(card.answer, null);
});

test("buildAskCard batch questions returns items", () => {
	const details = {
		questions: [
			{ id: "q1", question: "Name?", type: "input" },
			{ id: "q2", question: "Age?", type: "input" },
		],
		answers: [
			{ id: "q1", value: "Alice", label: "Alice" },
			{ id: "q2", value: "30", label: "30" },
		],
		cancelled: false,
	};
	const card = buildAskCard(details, false) as Record<string, unknown>;
	assert.equal(card.type, "batch");
	const items = card.items as Array<Record<string, unknown>>;
	assert.equal(items.length, 2);
	assert.equal(items[0].answered, true);
});

// ── extractAskQuestionDetails ───────────────────────────

test("extractAskQuestionDetails returns undefined for non-ask tool", () => {
	assert.equal(extractAskQuestionDetails("read", {}, {}), undefined);
});

test("extractAskQuestionDetails extracts from result.details", () => {
	const result = { details: { question: "q?", answer: "a", answered: true } };
	const details = extractAskQuestionDetails("ask_question", result, {});
	assert.ok(details);
	assert.equal(details?.question, "q?");
});

// ── extractToolResultText ───────────────────────────────

test("extractToolResultText extracts text from content array", () => {
	const result = { content: [{ text: "line1" }, { text: "line2" }] };
	assert.equal(extractToolResultText(result), "line1\nline2");
});

test("extractToolResultText returns empty for non-array content", () => {
	assert.equal(extractToolResultText({ content: "string" }), "");
	assert.equal(extractToolResultText(null), "");
});

// ── getToolPathFromArgs ─────────────────────────────────

test("getToolPathFromArgs extracts path field", () => {
	assert.equal(getToolPathFromArgs({ path: "/foo" }), "/foo");
	assert.equal(getToolPathFromArgs({ filePath: "/bar" }), "/bar");
	assert.equal(getToolPathFromArgs({ target_file: "/baz" }), "/baz");
	assert.equal(getToolPathFromArgs(null), "");
	assert.equal(getToolPathFromArgs({}), "");
});

// ── safeJson ────────────────────────────────────────────

test("safeJson serializes objects", () => {
	assert.equal(safeJson({ a: 1 }), '{\n  "a": 1\n}');
});

test("safeJson handles circular references", () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	const result = safeJson(circular);
	assert.ok(typeof result === "string");
});

// ── truncateForDetail ───────────────────────────────────

test("truncateForDetail returns short strings unchanged", () => {
	assert.equal(truncateForDetail("short"), "short");
});

test("truncateForDetail truncates long strings with head+tail", () => {
	const long = "a".repeat(20000);
	const result = truncateForDetail(long);
	assert.ok(result.length < long.length);
	assert.ok(result.startsWith("a"));
	assert.ok(result.endsWith("a"));
	assert.ok(result.includes("已省略"));
});

test("truncateForDetail handles non-string input", () => {
	assert.equal(truncateForDetail(null), "");
	assert.equal(truncateForDetail(42), "42");
});

// ── stripAnsi ───────────────────────────────────────────

test("stripAnsi removes ANSI escape codes", () => {
	assert.equal(stripAnsi("\x1b[31mred\x1b[0m text"), "red text");
	assert.equal(stripAnsi("clean text"), "clean text");
});

// ── extractImages ───────────────────────────────────────

test("extractImages extracts image content blocks", () => {
	const content = [
		{ type: "image", data: "base64data", mimeType: "image/png" },
		{ type: "text", text: "hello" },
		{ type: "image", data: "moredata", mime_type: "image/jpeg" },
	];
	const images = extractImages(content);
	assert.equal(images.length, 2);
	assert.equal(images[0].data, "base64data");
	assert.equal(images[0].mimeType, "image/png");
	assert.equal(images[1].mimeType, "image/jpeg");
});

test("extractImages returns empty for non-array", () => {
	assert.equal(extractImages(null).length, 0);
	assert.equal(extractImages("string").length, 0);
});

// ── extractThinking ─────────────────────────────────────

test("extractThinking extracts and strips ANSI from thinking blocks", () => {
	const content = [
		{ type: "thinking", thinking: "\x1b[32mdeep thought\x1b[0m" },
		{ type: "text", text: "not thinking" },
	];
	const result = extractThinking(content);
	assert.equal(result, "deep thought");
});

// ── tryParseBatchAskEnvelope ────────────────────────────

test("tryParseBatchAskEnvelope parses valid envelope", () => {
	const title = JSON.stringify({ __piDeckBatchAsk: 1, questions: [{ id: "q1" }] });
	const result = tryParseBatchAskEnvelope(title);
	assert.ok(result);
	assert.equal(result.questions.length, 1);
});

test("tryParseBatchAskEnvelope returns null for non-JSON", () => {
	assert.equal(tryParseBatchAskEnvelope("not json"), null);
	assert.equal(tryParseBatchAskEnvelope(""), null);
});

test("tryParseBatchAskEnvelope returns null for non-batch JSON", () => {
	assert.equal(tryParseBatchAskEnvelope(JSON.stringify({ foo: 1 })), null);
});
