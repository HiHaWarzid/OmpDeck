import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	vm.runInNewContext(outputText, sandbox, {
		filename: "codexSessionMeta.ts",
	});
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
	const sessionEntries = loadTranspiledModule("src/main/sessions/sessionEntries.ts");
	const sessionFileOps = loadTranspiledModule(
		"src/main/sessions/SessionFileOps.ts",
		new Map([["./sessionEntries", sessionEntries]]),
	);
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		setTimeout,
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: () => homePath } };
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
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "SessionScanner.ts",
	});
	return sandbox.exports;
}

/**
 * 父目录会话（cwd = /ws）里提到子项目路径时才会被列到子项目下。
 * 该判定要整读文件内容，因此 SessionScanner 缓存「文件 + 项目 → 是否命中」的结果；
 * 这组用例锁定缓存的三个对外可观察行为：命中、跨项目不串味、文件变化后失效。
 */
test("parent-session project match cache: hit, per-project key, invalidated on file change", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-project-match-"));
	try {
		const parentPath = "/ws";
		const projectPath = "/ws/app";
		const siblingPath = "/ws/other";
		const sessionsDir = join(home, ".omp", "agent", "sessions", "--ws--");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, "2026-07-01T00-00-00-000Z_parent.jsonl");

		const writeSession = (mention) => {
			// 每次写入字节长度都不同：确保 mtime/size 指纹变化，触发重新读取。
			const entries = [
				{ type: "session", id: "parent-session", cwd: parentPath },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: `在 ${mention} 里改一下 ${"x".repeat(mention.length)}` }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
			];
			writeFileSync(sessionPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
		};

		writeSession(projectPath);
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		// 会话对象创建在 vm realm 里，其数组原型与测试 realm 不同，deepEqual 会因原型差异误判；
		// 这里统一折叠成字符串再比较。
		const paths = (list) => list.map((s) => s.filePath).join("\n");

		const first = await scanner.list(projectPath);
		assert.equal(paths(first), sessionPath, "内容提到子项目 -> 归属该子项目");

		// 同一个扫描器实例：第二次查询命中缓存，结果必须一致（缓存键含项目，不能把 true 串给兄弟项目）。
		const sibling = await scanner.list(siblingPath);
		assert.equal(paths(sibling), "", "同一文件不含兄弟项目路径 -> 不归属兄弟项目");

		const again = await scanner.list(projectPath);
		assert.equal(paths(again), sessionPath, "缓存命中后结果不变");

		// 文件内容变化（不再提到该子项目）后，指纹变化必须让缓存失效。
		writeSession(siblingPath);
		const afterChange = await scanner.list(projectPath);
		assert.equal(paths(afterChange), "", "内容不再命中 -> 缓存失效并重新判定");

		// 再次命中：之前缓存的 false 不能粘住。
		writeSession(projectPath);
		const restored = await scanner.list(projectPath);
		assert.equal(paths(restored), sessionPath, "内容恢复命中 -> 重新列入");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
