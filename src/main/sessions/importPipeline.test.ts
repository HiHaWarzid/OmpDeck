import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { ImportPipeline } from "./importPipeline";
import type { ConvertedSession, ParsedSession, SourceAdapter } from "./importPipeline";
import { buildTargetPath, cleanTitle, computeImportStatus, makeId, safePathToken } from "./importShared";
import { ClaudeImportAdapter } from "./adapters/claudeImportAdapter";
import { CodexImportAdapter } from "./adapters/codexImportAdapter";
import { OpenCodeImportAdapter } from "./adapters/opencodeImportAdapter";

// ── Fake adapter：验证 pipeline 编排，不验证格式转换 ────

class FakeAdapter implements SourceAdapter {
	readonly source = "opencode" as const;
	readonly filePrefix = "fake_";

	sessions: ParsedSession[];
	convertCalls: ParsedSession[] = [];

	constructor(sessions: ParsedSession[]) {
		this.sessions = sessions;
	}

	async discover(): Promise<ParsedSession[]> {
		return this.sessions;
	}

	convert(_projectPath: string, session: ParsedSession): ConvertedSession {
		this.convertCalls.push(session);
		return {
			raw: JSON.stringify({ type: "opencode_import", sourceMtime: session.sourceMtime, sourceSize: session.sourceSize }) + "\n",
			title: `Fake ${session.id}`,
			preview: "preview",
			messageCount: 1,
		};
	}
}

function makeFakeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
	return {
		id: "session-1",
		sourcePath: "/fake/source.jsonl",
		sourceSize: 100,
		sourceMtime: 1000,
		meta: {},
		entries: [],
		cwd: "/project",
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

// ── Pipeline 编排测试 ───────────────────────────────────

test("scan returns summaries sorted by updatedAt desc", async () => {
	const sessions = [
		makeFakeSession({ id: "old", updatedAt: 1000 }),
		makeFakeSession({ id: "new", updatedAt: 3000 }),
		makeFakeSession({ id: "mid", updatedAt: 2000 }),
	];
	const pipeline = new ImportPipeline("/tmp/fake-piroot");
	pipeline.registerAdapter(new FakeAdapter(sessions));

	const summaries = await pipeline.scan("opencode", "/project");
	assert.equal(summaries.length, 3);
	assert.equal(summaries[0].id, "new");
	assert.equal(summaries[1].id, "mid");
	assert.equal(summaries[2].id, "old");
});

test("scan reports status new when no prior import", async () => {
	const pipeline = new ImportPipeline("/nonexistent-piroot");
	pipeline.registerAdapter(new FakeAdapter([makeFakeSession()]));

	const summaries = await pipeline.scan("opencode", "/project");
	assert.equal(summaries[0].status, "new");
	assert.equal(summaries[0].importedSourceMtime, undefined);
});

test("scan reports current when mtime+size match existing import", async () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-current-"));
	try {
		const session = makeFakeSession({ sourceMtime: 5000, sourceSize: 200 });
		const pipeline = new ImportPipeline(tmpRoot);
		pipeline.registerAdapter(new FakeAdapter([session]));

		// 先导入一次
		await pipeline.import("opencode", "/project", [session.sourcePath]);

		// 再 scan：应为 current
		const summaries = await pipeline.scan("opencode", "/project");
		assert.equal(summaries[0].status, "current");
		assert.equal(summaries[0].importedSourceMtime, 5000);
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("scan reports outdated when source changed after import", async () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-outdated-"));
	try {
		const session = makeFakeSession({ sourceMtime: 5000, sourceSize: 200 });
		const adapter = new FakeAdapter([session]);
		const pipeline = new ImportPipeline(tmpRoot);
		pipeline.registerAdapter(adapter);

		// 先导入
		await pipeline.import("opencode", "/project", [session.sourcePath]);

		// 模拟源文件更新
		adapter.sessions = [makeFakeSession({ sourceMtime: 6000, sourceSize: 250 })];

		const summaries = await pipeline.scan("opencode", "/project");
		assert.equal(summaries[0].status, "outdated");
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("import writes JSONL file to target path", async () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-write-"));
	try {
		const session = makeFakeSession({ id: "abc" });
		const pipeline = new ImportPipeline(tmpRoot);
		pipeline.registerAdapter(new FakeAdapter([session]));

		const report = await pipeline.import("opencode", "/project", [session.sourcePath]);
		assert.equal(report.imported, 1);
		assert.equal(report.failed, 0);
		assert.equal(report.results[0].success, true);
		assert.equal(report.results[0].overwritten, false);

		const targetPath = buildTargetPath(tmpRoot, "/project", "fake_", "abc");
		assert.ok(existsSync(targetPath), "target file should exist");
		const content = readFileSync(targetPath, "utf8");
		assert.ok(content.includes("opencode_import"));
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("import reports overwritten when re-importing same session", async () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-overwrite-"));
	try {
		const session = makeFakeSession();
		const pipeline = new ImportPipeline(tmpRoot);
		pipeline.registerAdapter(new FakeAdapter([session]));

		await pipeline.import("opencode", "/project", [session.sourcePath]);
		const report = await pipeline.import("opencode", "/project", [session.sourcePath]);
		assert.equal(report.results[0].overwritten, true);
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("import reports failure when session not found in discover results", async () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-fail-"));
	try {
		const pipeline = new ImportPipeline(tmpRoot);
		pipeline.registerAdapter(new FakeAdapter([])); // 空列表

		const report = await pipeline.import("opencode", "/project", ["/nonexistent"]);
		assert.equal(report.imported, 0);
		assert.equal(report.failed, 1);
		assert.equal(report.results[0].success, false);
		assert.ok(report.results[0].error);
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("import handles multiple sourcePaths in one call", async () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-multi-"));
	try {
		const sessions = [
			makeFakeSession({ id: "s1", sourcePath: "/src1" }),
			makeFakeSession({ id: "s2", sourcePath: "/src2" }),
		];
		const pipeline = new ImportPipeline(tmpRoot);
		pipeline.registerAdapter(new FakeAdapter(sessions));

		const report = await pipeline.import("opencode", "/project", ["/src1", "/src2"]);
		assert.equal(report.imported, 2);
		assert.equal(report.failed, 0);
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("scan throws when no adapter registered for source", async () => {
	const pipeline = new ImportPipeline("/tmp");
	await assert.rejects(() => pipeline.scan("codex", "/project"), /No adapter registered/);
});

test("scan preserves thread metadata from parsed session", async () => {
	const session = makeFakeSession({
		threadSource: "subagent",
		parentThreadId: "parent-1",
		agentRole: "coder",
		agentNickname: "Alice",
	});
	const pipeline = new ImportPipeline("/nonexistent");
	pipeline.registerAdapter(new FakeAdapter([session]));

	const summaries = await pipeline.scan("opencode", "/project");
	assert.equal(summaries[0].threadSource, "subagent");
	assert.equal(summaries[0].parentThreadId, "parent-1");
	assert.equal(summaries[0].agentRole, "coder");
	assert.equal(summaries[0].agentNickname, "Alice");
});

// ── importShared 纯函数测试 ─────────────────────────────

test("safePathToken converts Windows path", () => {
	assert.equal(safePathToken("C:\\Users\\foo"), "--C--Users-foo--");
});

test("safePathToken converts POSIX path", () => {
	assert.equal(safePathToken("/home/foo"), "--home-foo--");
});

test("cleanTitle trims whitespace and truncates", () => {
	assert.equal(cleanTitle("  hello  "), "hello");
	assert.equal(cleanTitle("untitled"), "");
	assert.equal(cleanTitle("UNTITLED"), "");
	assert.equal(cleanTitle("a".repeat(50)), `${"a".repeat(40)}...`);
});

test("makeId produces stable 8-char hash", () => {
	const id1 = makeId("session-1", 0);
	const id2 = makeId("session-1", 0);
	const id3 = makeId("session-1", 1);
	assert.equal(id1, id2);
	assert.notEqual(id1, id3);
	assert.equal(id1.length, 8);
});

test("computeImportStatus returns correct state", () => {
	assert.equal(computeImportStatus(undefined, 1000, 200), "new");
	assert.equal(computeImportStatus({ sourceMtime: 1000, sourceSize: 200 }, 1000, 200), "current");
	assert.equal(computeImportStatus({ sourceMtime: 1000, sourceSize: 200 }, 2000, 200), "outdated");
	assert.equal(computeImportStatus({ sourceMtime: 1000, sourceSize: 200 }, 1000, 300), "outdated");
});

// ── 适配器 summarize 与 convert 一致性 ─────────────────

function makeParsedSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
	return {
		id: "session-1",
		sourcePath: "/fake/source.jsonl",
		sourceSize: 100,
		sourceMtime: 1000,
		meta: {},
		entries: [],
		cwd: "/project",
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

test("Claude summarize matches convert for mixed entries", () => {
	const adapter = new ClaudeImportAdapter("/tmp/fake-claude-root");
	const session = makeParsedSession({
		meta: { sessionId: "s1", cwd: "/project", firstTimestamp: 1000, lastTimestamp: 2000 },
		entries: [
			{ type: "user", sessionId: "s1", cwd: "/project", message: { content: "first question" } },
			{ type: "assistant", message: { content: [{ type: "text", text: "hello answer" }], model: "claude-3" } },
			{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_result", content: "output" }] },
			{ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] } },
			{ type: "system", subtype: "turn_duration" }, // 跳过
			{ type: "user", message: { content: "" } }, // 空文本不计数
		],
	});
	const converted = adapter.convert("/project", session);
	const summarized = adapter.summarize("/project", session);
	assert.equal(summarized.title, converted.title);
	assert.equal(summarized.preview, converted.preview);
	assert.equal(summarized.messageCount, converted.messageCount);
});

test("Codex summarize matches convert for mixed entries", () => {
	const adapter = new CodexImportAdapter("/tmp/fake-codex-root");
	const session = makeParsedSession({
		meta: { id: "cx1", cwd: "/project", model: "gpt-5", model_provider: "openai" },
		entries: [
			{ type: "event_msg", payload: { type: "user_message", message: "build it" } },
			{ type: "response_item", payload: { type: "reasoning", summary: "thinking hard" } },
			{ type: "response_item", payload: { type: "message", role: "assistant", content: "done" } },
			{ type: "response_item", payload: { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" } },
			{ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ok" } },
			{ type: "event_msg", payload: { type: "user_message", message: "" } }, // 空不计数
		],
	});
	const converted = adapter.convert("/project", session);
	const summarized = adapter.summarize("/project", session);
	assert.equal(summarized.title, converted.title);
	assert.equal(summarized.preview, converted.preview);
	assert.equal(summarized.messageCount, converted.messageCount);
});

test("OpenCode summarize matches convert for mixed messages", () => {
	const adapter = new OpenCodeImportAdapter("/tmp/fake-opencode.db");
	const session = makeParsedSession({
		meta: { id: "oc1", time_created: 1000, model: "gpt-5" },
		entries: [
			{
				id: "m1", time_created: 1000, time_updated: 1000,
				data: { role: "user" },
				parts: [{ id: "p1", message_id: "m1", time_created: 1000, time_updated: 1000, data: { type: "text", text: "hi" } }],
			},
			{
				id: "m2", time_created: 2000, time_updated: 2000,
				data: { role: "assistant" },
				parts: [
					{ id: "p2", message_id: "m2", time_created: 2000, time_updated: 2000, data: { type: "reasoning", text: "let me think" } },
					{ id: "p3", message_id: "m2", time_created: 2000, time_updated: 2000, data: { type: "text", text: "answer" } },
				],
			},
			{
				id: "m3", time_created: 3000, time_updated: 3000,
				data: { role: "user" },
				parts: [
					{ id: "p4", message_id: "m3", time_created: 3000, time_updated: 3000, data: { type: "tool", tool: "bash", callID: "c1", state: { input: {}, status: "completed" } } },
				],
			},
		],
	});
	const converted = adapter.convert("/project", session);
	const summarized = adapter.summarize("/project", session);
	assert.equal(summarized.title, converted.title);
	assert.equal(summarized.preview, converted.preview);
	assert.equal(summarized.messageCount, converted.messageCount);
});
