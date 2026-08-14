import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadAgentManager() {
	const wslPaths = loadWslPaths();
	const calls = {
		copyFile: [],
		existsSync: [],
		readFile: [],
		readdir: [],
		readdirSync: [],
		statSync: [],
		unlink: [],
		writeFile: [],
	};
	const fsPromises = {
		copyFile: async (...args) => { calls.copyFile.push(args); },
		readFile: async (...args) => {
			calls.readFile.push(args);
			return `${JSON.stringify({ id: "entry-user", type: "message", message: { role: "user", content: "hello" } })}\n`;
		},
		readdir: async (...args) => {
			calls.readdir.push(args);
			return [];
		},
		unlink: async (...args) => { calls.unlink.push(args); },
		writeFile: async (...args) => { calls.writeFile.push(args); },
	};
	const fsSync = {
		existsSync: (filePath) => {
			calls.existsSync.push(filePath);
			return false;
		},
		readdirSync: (dir) => {
			calls.readdirSync.push(dir);
			return ["session.jsonl.100.edit-backup", "session.jsonl.200.edit-backup"];
		},
		statSync: (filePath) => {
			calls.statSync.push(filePath);
			return { size: 128 };
		},
	};
	// SessionJsonl.readTailLines 走 open→stat→read→close 的文件句柄路径；
	// 用 readFile 的同款桩内容构造内存句柄，保持 calls.readFile 记录语义不变。
	fsPromises.open = async (filePath, mode) => {
		const content = await fsPromises.readFile(filePath, mode);
		const buf = Buffer.from(content, "utf8");
		return {
			stat: async () => ({ size: buf.length }),
			read: async (target, offset, length, position) => {
				const chunk = buf.subarray(position, Math.min(position + length, buf.length));
				chunk.copy(target, offset);
				return { bytesRead: chunk.length };
			},
			close: async () => {},
		};
	};
	class LatestByKeyEmitter {
		push() {}
		flush() {}
		cancel() {}
	}

	// 共享 require：被 AgentManager 及其依赖（messageTimeline / streamGate / sessionJsonl）
	// 在各自 vm 沙箱中统一使用。registry 保存已转译的 TS 模块，按依赖顺序填充。
	const registry = {};
	function sharedRequire(id) {
		if (id in registry) return registry[id];
		if (id === "electron") return { app: {}, Notification: class {} };
		if (id === "node:fs/promises") return fsPromises;
		if (id === "node:fs") return fsSync;
		if (id === "node:path") return path.win32;
		if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
		if (id === "../../shared/ipc") return { ipcChannels: {} };
		if (id === "./PiProcess") return { PiProcess: class {} };
		if (id === "./bashResult") return { formatBashToolMessage: () => ({}) };
		if (id === "./messageContent") return { extractMessageText: (value) => String(value ?? "") };
		if (id === "./historyMessages") return { mergeHistoryWithPreservedMessages: (value) => value };
		if (id === "./LatestByKeyEmitter") return { LatestByKeyEmitter };
		if (id === "../../shared/toolRuntimeState") return { updateActiveToolCalls: () => new Map() };
		if (id === "../wsl/WslPaths") return wslPaths;
		if (id === "../vision/VisionBridge") return loadModule("src/main/vision/VisionBridge.ts", "VisionBridge.ts");
		return require(id);
	}

	function loadModule(filePath, filename) {
		const sandbox = {
			Buffer,
			clearTimeout,
			console: { log() {}, warn() {}, error() {} },
			exports: {},
			process: { ...process, platform: "win32" },
			setTimeout,
			require: sharedRequire,
		};
		vm.runInNewContext(transpile(filePath), sandbox, { filename });
		return sandbox.exports;
	}

	// 依赖顺序：todo（共享解析，无运行时依赖）<- sessionEntryIds <- messageTextUtils <- askQuestionCard <- messageTimeline <- sessionJsonl；streamGate 独立。
	registry["../../shared/todo"] = loadModule("src/shared/todo.ts", "todo.ts");
	registry["./sessionEntryIds"] = loadModule("src/main/pi/sessionEntryIds.ts", "sessionEntryIds.ts");
	registry["./messageTextUtils"] = loadModule("src/main/pi/messageTextUtils.ts", "messageTextUtils.ts");
	registry["./askQuestionCard"] = loadModule("src/main/pi/askQuestionCard.ts", "askQuestionCard.ts");
	registry["./messageTimeline"] = loadModule("src/main/pi/messageTimeline.ts", "messageTimeline.ts");
	registry["./streamGate"] = loadModule("src/main/pi/streamGate.ts", "streamGate.ts");
	registry["./sessionJsonl"] = loadModule("src/main/pi/sessionJsonl.ts", "sessionJsonl.ts");
	// AgentManager 引入 ../perf（src/main/perf.ts，纯诊断模块，无内部依赖）；
	// 测试文件自身的 require 会把 "../perf" 解析到仓库根目录，必须显式注入。
	registry["../perf"] = loadModule("src/main/perf.ts", "perf.ts");

	const agentManagerExports = loadModule("src/main/pi/AgentManager.ts", "AgentManager.ts");
	return { ...agentManagerExports, calls, wslPaths };
}

function createManager(AgentManager, configManager = {}) {
	return new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({}) },
		configManager,
	);
}

test("maps WSL session file operations to host paths while deduping by Linux identity", async () => {
	const { AgentManager, calls, wslPaths } = loadAgentManager();
	const manager = createManager(AgentManager);
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));
	const sessionPath = "/root/.pi/agent/sessions/session.jsonl";

	assert.equal(
		manager.normalizeSessionPathForCompare("//wsl$/Ubuntu-24.04/root/.pi/agent/sessions/session.jsonl"),
		sessionPath,
	);
	assert.notEqual(
		manager.normalizeSessionPathForCompare("/root/.pi/agent/sessions/Session.jsonl"),
		manager.normalizeSessionPathForCompare("/root/.pi/agent/sessions/session.jsonl"),
	);
	assert.equal(
		manager.normalizeSessionPathForCompare("/mnt/c/Users/Test/Session.jsonl"),
		manager.normalizeSessionPathForCompare("/mnt/c/users/test/session.jsonl"),
	);
	const loadDecision = manager.getHistoryAutoLoadDecision(sessionPath);
	assert.equal(loadDecision.shouldLoad, true);
	assert.equal(loadDecision.sizeBytes, 128);
	// JSONL 文件 IO 已抽取到 SessionJsonl 模块；AgentManager 在构造时注入 resolveHostPath
	// 闭包（this.toSessionHostPath），因此 sessionJsonl 的所有磁盘操作都经过 WSL 路径解析。
	await manager.sessionJsonl.readRecentMessages(sessionPath, 1);
	await manager.sessionJsonl.backup(sessionPath);
	const latestBackup = manager.sessionJsonl.findLatestBackup(sessionPath);
	manager.agents.set("agent", {
		process: { client: {} },
		tab: {
			id: "agent",
			projectId: "project",
			title: "Agent",
			status: "idle",
			createdAt: 1,
			sessionPath,
		},
		messages: [
			{ id: "message", agentId: "agent", role: "user", text: "hello", meta: { entryId: "entry-user" } },
		],
		toolMessageIds: new Map(),
		streamingThinking: "",
		toolStateSequence: 0,
		activeToolCalls: new Map(),
		toolExecuting: null,
		streamGate: { sealed: false, waitingForAbortSettled: false },
		pendingMessage: false,
		pendingUIRequests: new Map(),
		rpcLogging: false,
		compacting: false,
		rpcCompacting: false,
		modelRefreshing: false,
		userInitiatedStop: false,
		autoRestartAttempted: false,
		recentlyAborted: false,
		abortedDuringAsk: false,
	});
	manager.reloadSession = async () => {};
	await manager.prepareResendFromMessage("agent", "message");

	const expectedHostPath = "\\\\wsl.localhost\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl";
	assert.equal(calls.statSync[0], expectedHostPath);
	assert.equal(calls.readFile[0][0], expectedHostPath);
	assert.equal(calls.copyFile[0][0], expectedHostPath);
	assert.equal(calls.readFile[1][0], expectedHostPath);
	assert.equal(calls.writeFile[0][0], expectedHostPath);
	assert.equal(calls.readdir[0][0], path.win32.dirname(expectedHostPath));
	assert.equal(calls.readdirSync[0], path.win32.dirname(expectedHostPath));
	assert.equal(latestBackup.endsWith("session.jsonl.200.edit-backup"), true);
});

test("keeps switch_session RPC paths in Linux form", async () => {
	const { AgentManager, wslPaths } = loadAgentManager();
	const manager = createManager(AgentManager);
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));
	const requests = [];
	manager.agents.set("agent", {
		process: { client: { request: async (request) => { requests.push(request); return { success: true }; } } },
		tab: { id: "agent", projectId: "project", title: "Agent", status: "idle", createdAt: 1 },
	});
	manager.refreshRuntimeAfterSessionReplacement = async () => {};

	await manager.switchSession(
		"agent",
		"\\\\wsl.localhost\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl",
	);

	assert.equal(requests[0].sessionPath, "/root/.pi/agent/sessions/session.jsonl");
});

test("uses host paths for trust resource checks and Linux paths for trust keys", async () => {
	const { AgentManager, calls, wslPaths } = loadAgentManager();
	const trustedDirectories = [];
	const manager = createManager(AgentManager, {
		ensureTrustedDirectory: async (cwd) => { trustedDirectories.push(cwd); },
	});
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));

	await manager.ensureProjectTrust({
		id: "project",
		name: "ba_cli",
		path: "//wsl.localhost/Ubuntu-24.04/root/ba_cli",
		lastOpenedAt: 1,
	});

	assert.equal(trustedDirectories[0], "/root/ba_cli");
	assert.equal(
		calls.existsSync.every((filePath) => filePath.startsWith("\\\\wsl.localhost\\Ubuntu-24.04\\")),
		true,
	);
});
