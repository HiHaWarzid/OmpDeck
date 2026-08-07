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

	// 依赖顺序：sessionEntryIds <- messageTimeline <- sessionJsonl；streamGate 独立。
	registry["./sessionEntryIds"] = loadModule("src/main/pi/sessionEntryIds.ts", "sessionEntryIds.ts");
	registry["./messageTimeline"] = loadModule("src/main/pi/messageTimeline.ts", "messageTimeline.ts");
	registry["./streamGate"] = loadModule("src/main/pi/streamGate.ts", "streamGate.ts");
	registry["./sessionJsonl"] = loadModule("src/main/pi/sessionJsonl.ts", "sessionJsonl.ts");

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
	});
	manager.messages.set("agent", [
		{ id: "message", agentId: "agent", role: "user", text: "hello", meta: { entryId: "entry-user" } },
	]);
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
