import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";

import type { ChatMessage } from "../../shared/types";
import { SessionJsonl } from "./sessionJsonl";

/** 构造一个 identity 路径解析的 SessionJsonl（无 WSL），用于文件 IO 测试。 */
function makeSessionJsonl() {
	return new SessionJsonl({ resolveHostPath: (p) => p });
}

/** 构造一个最小 ChatMessage。 */
function makeMessage(overrides: Partial<ChatMessage> & { id: string; agentId: string; role: ChatMessage["role"]; text: string }): ChatMessage {
	return {
		timestamp: 0,
		meta: {},
		...overrides,
	} as ChatMessage;
}

/** 把一组 entry 对象序列化为 JSONL 文本（每行一个 JSON）。 */
function toJsonl(entries: unknown[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n");
}

let tmpRoot: string;

beforeAll(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "sessionJsonl-"));
});
afterAll(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

// ── findLineByEntryId ───────────────────────────────────

test("findLineByEntryId returns 0-based index of matching id", () => {
	const sj = makeSessionJsonl();
	const lines = [
		JSON.stringify({ id: "a", type: "message", message: { role: "user" } }),
		JSON.stringify({ id: "b", type: "message", message: { role: "assistant" } }),
		JSON.stringify({ id: "c", type: "message", message: { role: "user" } }),
	];
	assert.equal(sj.findLineByEntryId(lines, "b"), 1);
	assert.equal(sj.findLineByEntryId(lines, "c"), 2);
});

test("findLineByEntryId also matches entryId field", () => {
	const sj = makeSessionJsonl();
	const lines = [JSON.stringify({ entryId: "x1", type: "message", message: {} })];
	assert.equal(sj.findLineByEntryId(lines, "x1"), 0);
});

test("findLineByEntryId skips deleted entries and returns -1 when not found", () => {
	const sj = makeSessionJsonl();
	const lines = [
		JSON.stringify({ id: "del", type: "deleted", originalEntryId: "del" }),
		JSON.stringify({ id: "keep", type: "message", message: {} }),
	];
	// 旧版本 deleted 行可能仍带 id，不应被命中
	assert.equal(sj.findLineByEntryId(lines, "del"), -1);
	assert.equal(sj.findLineByEntryId(lines, "missing"), -1);
});

test("findLineByEntryId tolerates blank and unparseable lines", () => {
	const sj = makeSessionJsonl();
	const lines = ["", "not-json", JSON.stringify({ id: "ok", type: "message", message: {} })];
	assert.equal(sj.findLineByEntryId(lines, "ok"), 2);
});

// ── locateEntry ─────────────────────────────────────────

test("locateEntry scheme1: locates by meta.entryId", () => {
	const sj = makeSessionJsonl();
	const lines = [
		JSON.stringify({ id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
		JSON.stringify({ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
	];
	const msg = makeMessage({
		id: "agent1-history-e2",
		agentId: "agent1",
		role: "assistant",
		text: "hi",
		meta: { entryId: "e2" },
	});
	const result = sj.locateEntry(lines, [msg], msg);
	assert.equal(result.lineIndex, 1);
	assert.equal(result.entry.id, "e2");
});

test("locateEntry scheme2: falls back to msg.id prefix extraction", () => {
	const sj = makeSessionJsonl();
	const lines = [
		JSON.stringify({ id: "fallback-id", type: "message", message: { role: "user", content: [{ type: "text", text: "q" }] } }),
	];
	const msg = makeMessage({
		id: "agent1-history-fallback-id",
		agentId: "agent1",
		role: "user",
		text: "q",
		// 故意不提供 entryId，强制走 scheme2
		meta: {},
	});
	const result = sj.locateEntry(lines, [msg], msg);
	assert.equal(result.lineIndex, 0);
	assert.equal(result.entry.id, "fallback-id");
});

test("locateEntry scheme3: falls back to role + text match for assistant", () => {
	const sj = makeSessionJsonl();
	const lines = [
		JSON.stringify({ id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
	];
	const msg = makeMessage({
		id: "agent1-history-unknown",
		agentId: "agent1",
		role: "assistant",
		text: "answer",
		meta: {},
	});
	const result = sj.locateEntry(lines, [msg], msg);
	assert.equal(result.lineIndex, 0);
});

test("locateEntry scheme3: maps tool role to toolResult entry role", () => {
	const sj = makeSessionJsonl();
	const lines = [
		JSON.stringify({ id: "t1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "result" }] } }),
	];
	const msg = makeMessage({
		id: "agent1-history-t1",
		agentId: "agent1",
		role: "tool",
		text: "result",
		meta: {},
	});
	const result = sj.locateEntry(lines, [msg], msg);
	assert.equal(result.lineIndex, 0);
});

test("locateEntry throws when no scheme matches", () => {
	const sj = makeSessionJsonl();
	const lines = [
		JSON.stringify({ id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "other" }] } }),
	];
	const msg = makeMessage({
		id: "agent1-history-missing",
		agentId: "agent1",
		role: "assistant",
		text: "not-present",
		meta: {},
	});
	assert.throws(() => sj.locateEntry(lines, [msg], msg), /Message not found in session file/);
});

// ── readRecentMessages ──────────────────────────────────

test("readRecentMessages returns message entries as RpcResponse and trims by turns", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "recent-"));
	const sessionPath = join(dir, "session.jsonl");
	// 50 轮 user/assistant，maxTurns=5 应保留最后 5 轮 = 10 条 message entry
	const entries: unknown[] = [];
	for (let i = 0; i < 50; i++) {
		entries.push({ id: `u${i}`, type: "message", message: { role: "user", content: [{ type: "text", text: `q${i}` }] } });
		entries.push({ id: `a${i}`, type: "message", message: { role: "assistant", content: [{ type: "text", text: `a${i}` }] } });
	}
	await writeFile(sessionPath, toJsonl(entries), "utf8");

	const response = await sj.readRecentMessages(sessionPath, 5);
	assert.equal(response.success, true);
	assert.equal(response.command, "get_messages");
	const messages = (response.data as { messages?: unknown[] }).messages!;
	assert.equal(messages.length, 10);
	// 第一条应是 q45（最后 5 轮的起点）
	assert.equal((messages[0] as { content: Array<{ text: string }> }).content[0].text, "q45");
});

test("readRecentMessages skips non-message entries", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "recent-skip-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(
		sessionPath,
		toJsonl([
			{ id: "c1", type: "compaction", summary: "s" },
			{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "q" }] } },
		]),
		"utf8",
	);
	const response = await sj.readRecentMessages(sessionPath, 40);
	const messages = (response.data as { messages?: unknown[] }).messages!;
	assert.equal(messages.length, 1);
});

test("readRecentMessages rethrows on unreadable file", async () => {
	const sj = makeSessionJsonl();
	await assert.rejects(() => sj.readRecentMessages(join(tmpRoot, "does-not-exist.jsonl"), 40));
});

// ── getLatestCacheMessageHitRate ─────────────────────────

test("getLatestCacheMessageHitRate computes percentage from last assistant usage", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "cache-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(
		sessionPath,
		toJsonl([
			{ id: "a1", type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 0, cacheWrite: 50 } } },
			{ id: "a2", type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 300, cacheWrite: 100 } } },
		]),
		"utf8",
	);
	// 最后一条: cacheRead/(input+cacheRead+cacheWrite) = 300/500 = 60
	assert.equal(await sj.getLatestCacheMessageHitRate(sessionPath), 60);
});

test("getLatestCacheMessageHitRate returns undefined when promptTokens is 0", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "cache-zero-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(
		sessionPath,
		toJsonl([{ id: "a1", type: "message", message: { role: "assistant", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } } }]),
		"utf8",
	);
	assert.equal(await sj.getLatestCacheMessageHitRate(sessionPath), undefined);
});

test("getLatestCacheMessageHitRate returns undefined for missing file", async () => {
	const sj = makeSessionJsonl();
	assert.equal(await sj.getLatestCacheMessageHitRate(join(tmpRoot, "nope.jsonl")), undefined);
});

// ── parseArchives ───────────────────────────────────────

test("parseArchives collects compactions and their archived messages", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "archives-"));
	const sessionPath = join(dir, "session.jsonl");
	// 构造一条链：u1 -> a1 -> compaction(firstKeptEntryId=u1, parentId=a1)
	// 归档范围从 compaction.parentId=a1 回溯到 firstKeptEntryId=u1（不包含），即收集 a1
	await writeFile(
		sessionPath,
		toJsonl([
			{ id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "q1" }] } },
			{ id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "r1" }] } },
			{ id: "comp1", parentId: "a1", type: "compaction", summary: "摘要", firstKeptEntryId: "u1", tokensBefore: 1000, timestamp: "2026-01-01T00:00:00Z" },
		]),
		"utf8",
	);
	const result = await sj.parseArchives(sessionPath, "agent1");
	assert.equal(result.compactions.length, 1);
	assert.equal(result.compactions[0].id, "comp1");
	assert.equal(result.compactions[0].summary, "摘要");
	// a1 应被归档到 comp1
	const archived = result.archivedMessagesByCompactionId.get("comp1");
	assert.ok(archived);
	assert.equal(archived!.length, 1);
	assert.equal(archived![0].role, "assistant");
});

test("parseArchives returns empty result for missing file", async () => {
	const sj = makeSessionJsonl();
	const result = await sj.parseArchives(join(tmpRoot, "missing.jsonl"), "agent1");
	assert.equal(result.compactions.length, 0);
	assert.equal(result.archivedMessagesByCompactionId.size, 0);
});

test("parseArchives accepts pre-read sessionContent", async () => {
	const sj = makeSessionJsonl();
	const content = toJsonl([
		{ id: "c1", parentId: null, type: "compaction", summary: "s", firstKeptEntryId: null, timestamp: "2026-01-01T00:00:00Z" },
	]);
	const result = await sj.parseArchives(join(tmpRoot, "ignored.jsonl"), "agent1", content);
	assert.equal(result.compactions.length, 1);
});

// ── backup / findLatestBackup / restoreFromBackup ────────

test("backup creates a .edit-backup file and caps at MAX_BACKUPS", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "backup-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, "original", "utf8");

	await sj.backup(sessionPath);
	await sj.backup(sessionPath);
	await sj.backup(sessionPath);
	await sj.backup(sessionPath);

	const { readdir } = await import("node:fs/promises");
	const files = (await readdir(dir)).filter((f) => f.endsWith(".edit-backup"));
	// MAX_BACKUPS = 3，多次 backup 后不应超过 3 个
	assert.equal(files.length, 3);
	// 最新备份内容应是当前文件内容
	const latest = sj.findLatestBackup(sessionPath);
	assert.ok(latest);
	const backupContent = await readFileText(latest!);
	assert.equal(backupContent, "original");
});

test("findLatestBackup returns null when no backup exists", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "nobackup-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, "x", "utf8");
	assert.equal(sj.findLatestBackup(sessionPath), null);
});

test("restoreFromBackup restores content and returns true; false when no backup", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "restore-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, "v1", "utf8");
	await sj.backup(sessionPath);
	await writeFile(sessionPath, "v2-corrupted", "utf8");

	const restored = await sj.restoreFromBackup(sessionPath);
	assert.equal(restored, true);
	assert.equal(await readFileText(sessionPath), "v1");

	// 无备份时返回 false
	const dir2 = await mkdtemp(join(tmpRoot, "restore-none-"));
	const sessionPath2 = join(dir2, "session.jsonl");
	await writeFile(sessionPath2, "x", "utf8");
	assert.equal(await sj.restoreFromBackup(sessionPath2), false);
});

// ── modifyLines ─────────────────────────────────────────

test("modifyLines reads, mutates, backs up, and writes back", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "modify-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(
		sessionPath,
		toJsonl([
			{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "old" }] } },
		]),
		"utf8",
	);

	const ret = await sj.modifyLines(sessionPath, (lines) => {
		const entry = JSON.parse(lines[0]);
		entry.message.content[0].text = "new";
		lines[0] = JSON.stringify(entry);
		return "done";
	});
	assert.equal(ret, "done");
	const after = await readFileText(sessionPath);
	assert.ok(after.includes("new"));
	assert.ok(!after.includes("old"));
	// 应同时产生一个备份
	assert.ok(sj.findLatestBackup(sessionPath) !== null);
});

test("modifyLines does NOT write or back up when mutator throws", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "modify-throw-"));
	const sessionPath = join(dir, "session.jsonl");
	const original = toJsonl([
		{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "keep" }] } },
	]);
	await writeFile(sessionPath, original, "utf8");

	await assert.rejects(
		() => sj.modifyLines(sessionPath, () => { throw new Error("locate failed"); }),
		/locate failed/,
	);
	// 文件内容应保持不变
	assert.equal(await readFileText(sessionPath), original);
	// 不应产生备份
	assert.equal(sj.findLatestBackup(sessionPath), null);
});

test("modifyLines throws 'Session file is empty' for empty/missing file", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "modify-empty-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(sessionPath, "", "utf8");
	await assert.rejects(() => sj.modifyLines(sessionPath, () => undefined), /Session file is empty/);
	await assert.rejects(
		() => sj.modifyLines(join(dir, "nope.jsonl"), () => undefined),
		/Session file is empty/,
	);
});

test("modifyLines passes through complex mutator return value (object)", async () => {
	const sj = makeSessionJsonl();
	const dir = await mkdtemp(join(tmpRoot, "modify-ret-"));
	const sessionPath = join(dir, "session.jsonl");
	await writeFile(
		sessionPath,
		toJsonl([{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "payload" }] } }]),
		"utf8",
	);
	const result = await sj.modifyLines(sessionPath, (lines) => {
		const entry = JSON.parse(lines[0]);
		const text = entry.message.content[0].text;
		return { text, images: ["img1"] };
	});
	assert.deepEqual(result, { text: "payload", images: ["img1"] });
});

// ── 辅助 ────────────────────────────────────────────────

/** 读取文件文本的小封装，避免在每个测试里重复 import。 */
async function readFileText(path: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(path, "utf8");
}

// 防止未使用 import 的静态检查告警（mkdir 在未来嵌套目录测试中会用到，这里保留引用）
void mkdir;
