import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { ChatMessage } from "../../shared/types";
import { SessionJsonl } from "./sessionJsonl";
import { SessionRewrite } from "./sessionRewrite";
import {
	deleteEntry,
	editEntryText,
	truncateForResend,
} from "./sessionRewriteMutations";

const entries = [
	{ id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
	{ id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer 1" }] } },
	{ id: "u2", parentId: "a1", type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } },
	{ id: "a2", parentId: "u2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer 2" }] } },
];
const seed = () => entries.map((e) => JSON.stringify(e)).join("\n");

const msgs = [
	{ id: "m-u1", agentId: "a", role: "user", text: "first", timestamp: 0, meta: { entryId: "u1" } },
	{ id: "m-u2", agentId: "a", role: "user", text: "second", timestamp: 0, meta: { entryId: "u2" } },
] as ChatMessage[];

test("end-to-end rewrite: edit / delete / resend / rollback against a real session file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rewrite-smoke-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, seed(), "utf8");

	const jsonl = new SessionJsonl({ resolveHostPath: (p) => p });
	const locate = (lines: string[], messages: ChatMessage[], msg: ChatMessage) =>
		jsonl.locateEntry(lines, messages, msg);
	const read = () => readFile(sessionPath, "utf8");

	let reloadShouldFail = false;
	let transcript = "";
	const rewrite = new SessionRewrite({
		runtime: () => ({ sessionPath, messages: msgs }),
		jsonl,
		withLock: (_id, fn) => fn(),
		ensureIdle: async () => {},
		reload: async () => {
			if (reloadShouldFail) throw new Error("switch_session failed");
			transcript = "reloaded";
		},
		refreshTranscript: async () => {
			transcript = "refreshed";
		},
		log: { info: () => {}, warn: () => {}, error: () => {} },
	});

	// 1. 编辑
	await rewrite.apply("a", {
		operation: "Edit message",
		mutate: ({ lines, messages }) =>
			editEntryText({ lines, messages, messageId: "m-u2", newText: "second (edited)", locate }),
	});
	assert.ok((await read()).includes("second (edited)"), "edit 应落盘");
	assert.equal(transcript, "reloaded");

	// 2. 删除 assistant a1：子节点 u2 应重挂到 u1
	await writeFile(sessionPath, seed(), "utf8");
	await rewrite.apply("a", {
		operation: "Delete message",
		mutate: ({ lines, messages }) =>
			deleteEntry({ lines, messages, messageId: "m-u2", locate }),
	});
	const afterDelete = (await read()).split("\n").map((l) => JSON.parse(l));
	assert.equal(afterDelete[2].type, "deleted", "被删行变成 tombstone");
	assert.equal(afterDelete[2].originalEntryId, "u2");
	assert.equal(afterDelete[3].parentId, "a1", "子节点应重挂到被删节点的父节点");

	// 3. 重发截断 u2
	await writeFile(sessionPath, seed(), "utf8");
	const resend = await rewrite.apply("a", {
		operation: "Prepare resend",
		prepare: ({ messages }) => {
			const msg = messages.find((m) => m.id === "m-u2");
			assert.ok(msg);
			return msg;
		},
		mutate: ({ lines, messages }, msg) => {
			const { removed } = truncateForResend({ lines, messages, msg, locate });
			return { removed, text: msg.text };
		},
	});
	assert.equal(resend.removed, 2, "u2 及其后代应被 tombstone");
	assert.equal(resend.text, "second");
	const afterResend = (await read()).split("\n").map((l) => JSON.parse(l));
	assert.equal(afterResend[0].type, "message");
	assert.equal(afterResend[1].type, "message");
	assert.equal(afterResend[2].type, "deleted");
	assert.equal(afterResend[3].type, "deleted");

	// 4. reload 失败 → 回滚到改写前
	await writeFile(sessionPath, seed(), "utf8");
	const beforeFailure = await read();
	reloadShouldFail = true;
	await assert.rejects(
		rewrite.apply("a", {
			operation: "Edit message",
			mutate: ({ lines, messages }) =>
				editEntryText({ lines, messages, messageId: "m-u1", newText: "should roll back", locate }),
		}),
		/switch_session failed/,
	);
	assert.equal(await read(), beforeFailure, "reload 失败必须回滚");
	assert.equal(transcript, "refreshed", "回滚后应刷新转录");
});
