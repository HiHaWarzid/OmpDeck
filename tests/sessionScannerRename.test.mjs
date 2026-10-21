import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadTranspiledModule(filePath, overrides = new Map()) {
	const source = readFileSync(filePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		require: (id) => overrides.has(id) ? overrides.get(id) : require(id),
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function loadCodexMetaModule() {
	const source = readFileSync("src/shared/codexSessionMeta.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, { filename: "codexSessionMeta.ts" });
	return sandbox.exports;
}

function loadSessionScanner(homePath) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const codexMeta = loadCodexMetaModule();
	const messageContent = loadTranspiledModule(
		"src/main/pi/messageContent.ts",
		new Map([["../feishu/docActions", { stripFeishuDocActionHint: (text) => text }]]),
	);
	const sessionSummaryCache = loadTranspiledModule(
		"src/main/sessions/sessionSummaryCache.ts",
		new Map([
			["electron", { app: { getPath: () => homePath } }],
			["../utils/fsRetry", loadTranspiledModule("src/main/utils/fsRetry.ts")],
		]),
	);
	const wslPaths = loadTranspiledModule("src/main/wsl/WslPaths.ts");
	const localFileAdapter = loadTranspiledModule("src/main/fs/adapters/localFileAdapter.ts");
	const wslFileAdapter = loadTranspiledModule("src/main/fs/adapters/wslFileAdapter.ts");
	const subagentParentInference = loadTranspiledModule("src/main/sessions/subagentParentInference.ts");
	// W4：文件操作拆分到 SessionFileOps（rename/copy/delete/read 族），SessionScanner 委托给注入实例。
	// 读取半部分（解码/逐行解析/字节预算）收敛到 sessionEntries，两个模块都依赖它：
	// vm 沙箱不解析 .ts 扩展引入，需显式注入同一份加载结果。
	const sessionEntries = loadTranspiledModule("src/main/sessions/sessionEntries.ts");
	const sessionText = loadTranspiledModule("src/main/sessions/sessionText.ts");
	const sessionSummaryFacts = loadTranspiledModule(
		"src/main/sessions/sessionSummaryFacts.ts",
		new Map([
			["./sessionEntries", sessionEntries],
			["./sessionText", sessionText],
		]),
	);
	const sessionParsePool = loadTranspiledModule("src/main/sessions/sessionParsePool.ts");
	const sessionFileOps = loadTranspiledModule(
		"src/main/sessions/SessionFileOps.ts",
		new Map([
			["./sessionEntries", sessionEntries],
			["./sessionText", sessionText],
		]),
	);
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		setTimeout,
		require: (id) => {
			if (id === "electron") {
				return {
					app: {
						getPath: (key) => (key === "home" ? homePath : join(homePath, String(key))),
					},
					shell: { trashItem: async () => {} },
				};
			}
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../pi/messageContent") return messageContent;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "../fs/adapters/localFileAdapter") return localFileAdapter;
			if (id === "../fs/adapters/wslFileAdapter") return wslFileAdapter;
			if (id === "./subagentParentInference") return subagentParentInference;
			if (id === "./SessionFileOps") return sessionFileOps;
			if (id === "./sessionEntries") return sessionEntries;
			if (id === "./sessionSummaryFacts") return sessionSummaryFacts;
			if (id === "./sessionParsePool") return sessionParsePool;
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports;
}

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function readLines(filePath) {
	return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
}

function parseEntry(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function entriesOfType(lines, type) {
	return lines.map(parseEntry).filter((entry) => entry?.type === type);
}

/** omp 的权威标题在首行定长 title 槽；重命名必须原地覆盖而不是追加旧格式。 */
function readTitleSlot(lines) {
	const slot = parseEntry(lines[0]);
	assert.equal(slot?.type, "title");
	return slot;
}

function readTitleChange(lines) {
	const changes = entriesOfType(lines, "title_change");
	return changes[changes.length - 1];
}

function titleName(lines) {
	return readTitleChange(lines)?.title ?? readTitleSlot(lines).title;
}

const healthySession = [
	{ type: "session", id: "aaaa0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
	{ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
	{ type: "message", id: "aaaa0003", parentId: "aaaa0002", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "hi" } },
];

test("rename writes the native fixed-size title slot first and appends title_change", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-native-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-a.jsonl");
		writeSession(file, healthySession);

		await scanner.fileOps.rename(file, "新会话名");

		const lines = readLines(file);
		// omp 只读首行 title 槽；槽必须定长，避免后续写入破坏行偏移。
		const slot = readTitleSlot(lines);
		assert.equal(slot.title, "新会话名");
		assert.equal(slot.source, "user");
		assert.equal(Buffer.byteLength(`${lines[0]}\n`, "utf8"), 256);
		assert.equal(lines.length, healthySession.length + 2);

		// 会话头仍在，且同步了标题字段，兼容只读头部的旧查看器。
		const [header] = entriesOfType(lines, "session");
		assert.equal(header.id, "aaaa0001");
		assert.equal(header.title, "新会话名");
		assert.equal(header.titleSource, "user");

		const change = readTitleChange(lines);
		assert.equal(change.title, "新会话名");
		assert.equal(change.source, "user");
		assert.match(change.id, /^[0-9a-f]{8}$/);
		// parentId 指向追加前最后一条带 id 的记录，保持会话树链条完整
		assert.equal(change.parentId, "aaaa0003");
		assert.equal(typeof change.timestamp, "string");
		assert.equal(titleName(lines), "新会话名");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("rename heals legacy sessionName head lines and stale session_info records", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-heal-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-b.jsonl");
		// 旧版应用的破坏产物：头部前置无 type 的 sessionName 私有行 + 旧 session_info。
		writeSession(file, [
			{ sessionName: "Old app name", ts: 1700000000000 },
			...healthySession,
			{ type: "session_info", id: "bbbb0001", parentId: "aaaa0003", name: "stale" },
		]);
		assert.equal(parseEntry(readLines(file)[0])?.type, undefined);

		await scanner.fileOps.rename(file, "Healed");

		const lines = readLines(file);
		assert.equal(readTitleSlot(lines).title, "Healed");
		assert.ok(!lines.some((line) => line.includes("sessionName")));
		assert.equal(entriesOfType(lines, "session_info").length, 0);
		assert.equal(entriesOfType(lines, "session").length, 1);
		assert.equal(titleName(lines), "Healed");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("repeated rename keeps a single title slot and the latest name authoritative", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-twice-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-c.jsonl");
		writeSession(file, healthySession);

		await scanner.fileOps.rename(file, "first");
		await scanner.fileOps.rename(file, "second");

		const lines = readLines(file);
		assert.equal(entriesOfType(lines, "title").length, 1);
		assert.equal(readTitleSlot(lines).title, "second");
		assert.equal(entriesOfType(lines, "title_change").length, 2);
		assert.equal(titleName(lines), "second");
		// OmpDeck 摘要同样读取原生标题槽
		const summary = await scanner["readSummary"](file);
		assert.equal(summary?.name, "second");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("rename sanitizes newlines without breaking the fixed-size title slot", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-sanitize-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-d.jsonl");
		writeSession(file, healthySession);

		await scanner.fileOps.rename(file, "line1\nline2\r\nline3");

		const lines = readLines(file);
		assert.equal(lines.length, healthySession.length + 2);
		assert.equal(readTitleSlot(lines).title, "line1 line2 line3");
		assert.equal(titleName(lines), "line1 line2 line3");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("rename delegates to the SessionFileOps module (no scanner forwarding)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-delegate-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-f.jsonl");
		writeSession(file, healthySession);

		await scanner.fileOps.rename(file, "Via file ops");

		assert.equal(titleName(readLines(file)), "Via file ops");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
