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
	// 会话文件内容：默认桩（header + 一条 user 消息），压缩相关用例整份替换。
	// 尾窗读取会丢弃窗口内第一个换行之前的片段（那可能是被窗口切开的残行），
	// 所以桩文件不能只有一行，否则消息行会被当成残行丢掉。
	const sessionLines = [
		JSON.stringify({ type: "session", id: "session", timestamp: "2026-01-01T00:00:00.000Z" }),
		JSON.stringify({
			id: "entry-user",
			type: "message",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "hello" },
		}),
		"",
	];
	const setSessionLines = (lines) => {
		sessionLines.length = 0;
		sessionLines.push(...lines);
	};
	const fsPromises = {
		copyFile: async (...args) => { calls.copyFile.push(args); },
		readFile: async (...args) => {
			calls.readFile.push(args);
			// 与生产同形：首行 header + 消息行。
			return sessionLines.join("\n");
		},
		// sessionEntries 的读取管线先 stat 取指纹再决定读多少；桩文件内容固定，
		// size 用与 fsPromises.open 同一份内容的字节数，保证指纹/尾窗计算一致。
		stat: async (filePath) => {
			const content = await fsPromises.readFile(filePath);
			return { mtimeMs: 1_700_000_000_000, size: Buffer.byteLength(content, "utf8") };
		},
		readdir: async (...args) => {
			calls.readdir.push(args);
			return [];
		},
		unlink: async (...args) => { calls.unlink.push(args); },
		writeFile: async (...args) => { calls.writeFile.push(args); },
	};
	const fsSync = {
		// 会话文件视为存在（loadMessages 的「RPC 失败/为空 → 文件直读兜底」要先过存在性判断），
		// 其余路径维持 false，保持既有用例对「不存在即不读」的隐含假设。
		existsSync: (filePath) => {
			calls.existsSync.push(filePath);
			return typeof filePath === "string" && filePath.endsWith(".jsonl");
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
	// AgentManager 引入 ./agentProcessSlot（子进程租约与工厂；仅值导入 ./PiProcess，
	// 由 sharedRequire 的 PiProcess 桩承接），测试文件的 require 会把它解析到 tests/ 而失败。
	registry["./agentProcessSlot"] = loadModule("src/main/pi/agentProcessSlot.ts", "agentProcessSlot.ts");
	// sessionJsonl 的归档缓存现由 ./boundedLruCache（纯 LRU，无内部依赖）提供；
	// 测试文件自身的 require 会把 "./boundedLruCache" 解析到 tests/ 目录而失败，
	// 必须按依赖顺序先转译注入真模块。
	registry["./boundedLruCache"] = loadModule("src/main/pi/boundedLruCache.ts", "boundedLruCache.ts");
	// sessionJsonl 的读取管线收敛到 ../sessions/sessionEntries（唯一实现：编码守卫/逐行解析/
	// 指纹/预算，仅依赖 node:fs/promises）；测试文件自身的 require 会把它解析到 tests/ 而失败。
	registry["../sessions/sessionEntries"] = loadModule("src/main/sessions/sessionEntries.ts", "sessionEntries.ts");
	registry["./sessionJsonl"] = loadModule("src/main/pi/sessionJsonl.ts", "sessionJsonl.ts");
	// W4：AgentManager 的 settle 判定收敛到纯函数模块 settleReducer（无运行时依赖）。
	registry["./settleReducer"] = loadModule("src/main/pi/settleReducer.ts", "settleReducer.ts");
	// 转录与运行态已抽为纯状态模块（agentTranscript / agentRunState），
	// AgentManager 只做编排；测试用它们的工厂构造 runtime，不再手写字段清单。
	registry["../feishu/docActions"] = loadModule("src/main/feishu/docActions.ts", "docActions.ts");
	const messageContent = loadModule("src/main/pi/messageContent.ts", "messageContent.ts");
	registry["./messageContent"] = messageContent;
	const agentTranscript = loadModule("src/main/pi/agentTranscript.ts", "agentTranscript.ts");
	registry["./agentTranscript"] = agentTranscript;
	const agentRunState = loadModule("src/main/pi/agentRunState.ts", "agentRunState.ts");
	registry["./agentRunState"] = agentRunState;
	// AgentManager 引入 ../perf（src/main/perf.ts，纯诊断模块，无内部依赖）；
	// 测试文件自身的 require 会把 "../perf" 解析到仓库根目录，必须显式注入。
	registry["../perf"] = loadModule("src/main/perf.ts", "perf.ts");
	// 跨 pi 版本的 RPC 命令名兼容层（新名优先 / 旧名兜底，仅类型导入无运行时依赖）。
	registry["./piRpcCompat"] = loadModule("src/main/pi/piRpcCompat.ts", "piRpcCompat.ts");

	const agentManagerExports = loadModule("src/main/pi/AgentManager.ts", "AgentManager.ts");
	return {
		...agentManagerExports,
		agentProcessSlot: registry["./agentProcessSlot"],
		agentRunState,
		agentTranscript,
		calls,
		setSessionLines,
		wslPaths,
	};
}

function createManager(AgentManager, configManager = {}) {
	return new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({}) },
		configManager,
	);
}

/**
 * TrustStore 的沙箱加载器：TrustStore 现在值导入 ../storage/JsonFileStore（其再导入
 * ../utils/fsRetry）。Node 的 ESM 解析器不接受无扩展名的 .ts 相对导入，故不再用
 * `await import()` 直接加载源码，而是照本文件既有方式转译为 CJS 注入真模块；
 * node 内建仍走真实实现，因此信任文件照常落盘到临时目录。
 */
function loadTrustStore() {
	const cache = {};
	function sandboxRequire(id) {
		if (id === "../utils/fsRetry") {
			return (cache.fsRetry ??= sandboxLoad("src/main/utils/fsRetry.ts", "fsRetry.ts"));
		}
		if (id === "../storage/JsonFileStore") {
			return (cache.jsonFileStore ??= sandboxLoad("src/main/storage/JsonFileStore.ts", "JsonFileStore.ts"));
		}
		return require(id);
	}
	function sandboxLoad(filePath, filename) {
		const sandbox = { exports: {}, process, require: sandboxRequire };
		vm.runInNewContext(transpile(filePath), sandbox, { filename });
		return sandbox.exports;
	}
	return sandboxLoad("src/main/config/TrustStore.ts", "TrustStore.ts");
}

test("maps WSL session file operations to host paths while deduping by Linux identity", async () => {
	const { AgentManager, calls, wslPaths, agentProcessSlot, agentTranscript, agentRunState } = loadAgentManager();
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
		// 运行时形状已收敛为 slot（AgentProcessSlot 持有当前 child 与租约），
		// 不再是裸 process 字段；用真模块构造，保持与生产 createAgentRuntime 同形。
		slot: new agentProcessSlot.AgentProcessSlot({ client: {} }),
		tab: {
			id: "agent",
			projectId: "project",
			title: "Agent",
			status: "idle",
			createdAt: 1,
			sessionPath,
		},
		transcript: {
			...agentTranscript.createTranscriptState(),
			messages: [
				{ id: "message", agentId: "agent", role: "user", text: "hello", meta: { entryId: "entry-user" } },
			],
		},
		run: agentRunState.createRunState(),
		toolStateSequence: 0,
		activeToolCalls: new Map(),
		toolExecuting: null,
		pendingUIRequests: new Map(),
		rpcLogging: false,
		compacting: false,
		rpcCompacting: false,
		modelRefreshing: false,
		userInitiatedStop: false,
		autoRestartAttempted: false,
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
	const { AgentManager, agentProcessSlot, wslPaths } = loadAgentManager();
	const manager = createManager(AgentManager);
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));
	const requests = [];
	manager.agents.set("agent", {
		slot: new agentProcessSlot.AgentProcessSlot({
			client: { request: async (request) => { requests.push(request); return { success: true }; } },
		}),
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
	// 信任决策已收敛到 TrustStore：AgentManager 只注入弹窗适配器，这里给真 store +
	// 临时 trust 目录，断言 Linux cwd 键落盘、资源探测全走宿主（UNC）路径。
	const { TrustStore } = loadTrustStore();
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const trustDir = mkdtempSync(join(tmpdir(), "agentmgr-trust-"));
	try {
		const store = new TrustStore({ resolveConfigDir: () => trustDir });
		const manager = createManager(AgentManager, { trustStore: store });
		manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));

		await manager.ensureProjectTrust({
			id: "project",
			name: "ba_cli",
			path: "//wsl.localhost/Ubuntu-24.04/root/ba_cli",
			lastOpenedAt: 1,
		});

		const trust = JSON.parse(readFileSync(join(trustDir, "trust.json"), "utf8"));
		assert.equal(trust["/root/ba_cli"], true);
		assert.equal(
			calls.existsSync.every((filePath) => filePath.startsWith("\\\\wsl.localhost\\Ubuntu-24.04\\")),
			true,
		);
	} finally {
		rmSync(trustDir, { recursive: true, force: true });
	}
});

/**
 * 构造 AgentManager 期望的运行时形状（与生产 createAgentRuntime 同形）：
 * loadMessages / fork / clone 只碰 slot.client、tab 与 transcript/run 状态，其余字段照
 * 既有 WSL 用例补齐即可。
 */
function createRuntimeFixture({ agentProcessSlot, agentTranscript, agentRunState, client, tab }) {
	return {
		slot: new agentProcessSlot.AgentProcessSlot({ client }),
		tab: { id: "agent", projectId: "project", title: "Agent", status: "idle", createdAt: 1, ...tab },
		transcript: agentTranscript.createTranscriptState(),
		run: agentRunState.createRunState(),
		toolStateSequence: 0,
		activeToolCalls: new Map(),
		toolExecuting: null,
		pendingUIRequests: new Map(),
		rpcLogging: false,
		compacting: false,
		rpcCompacting: false,
		modelRefreshing: false,
		userInitiatedStop: false,
		autoRestartAttempted: false,
	};
}

test("loadMessages falls back to the session file when get_messages fails", async () => {
	const { AgentManager, agentProcessSlot, agentTranscript, agentRunState } = loadAgentManager();
	const manager = createManager(AgentManager);
	const requests = [];
	manager.agents.set(
		"agent",
		createRuntimeFixture({
			agentProcessSlot,
			agentTranscript,
			agentRunState,
			// 大会话撞 RPC 传输上限的典型形状：命令本身被识别，但返回 success=false。
			client: {
				request: async (request) => {
					requests.push(request);
					if (request.type === "get_messages" || request.type === "get_entries") {
						return {
							type: "response",
							command: request.type,
							success: false,
							error: "Response exceeds transport limit (max 8388608 bytes)",
						};
					}
					return { type: "response", command: request.type, success: true, data: {} };
				},
			},
			tab: { sessionPath: "C:\\sessions\\session.jsonl" },
		}),
	);

	const messages = await manager.loadMessages("agent");

	assert.equal(requests.some((request) => request.type === "get_messages"), true);
	// 文件桩里有一条 user 消息：RPC 失败后必须回退读文件，而不是渲染成空会话。
	assert.equal(messages.length > 0, true);
	assert.equal(messages.some((message) => String(message.text ?? "").includes("hello")), true);
});

test("compacted session ships an archive index, not the archived messages", async () => {
	const { AgentManager, agentProcessSlot, agentTranscript, agentRunState, setSessionLines } = loadAgentManager();
	// 会话链：u1 <- a1 <- comp1(firstKeptEntryId=u1)；a1 属于 comp1 的归档段。
	setSessionLines([
		JSON.stringify({ type: "session", id: "session", timestamp: "2026-01-01T00:00:00.000Z" }),
		JSON.stringify({ id: "u1", parentId: null, type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "q1" } }),
		JSON.stringify({ id: "a1", parentId: "u1", type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "r1" }] } }),
		JSON.stringify({ id: "comp1", parentId: "a1", type: "compaction", summary: "摘要", firstKeptEntryId: "u1", tokensBefore: 1000, timestamp: "2026-01-01T00:00:03.000Z" }),
		"",
	]);
	const manager = createManager(AgentManager);
	manager.agents.set(
		"agent",
		createRuntimeFixture({
			agentProcessSlot,
			agentTranscript,
			agentRunState,
			client: {
				request: async (request) => ({
					type: "response",
					command: request.type,
					success: false,
					error: "Response exceeds transport limit (max 8388608 bytes)",
				}),
			},
			tab: { sessionPath: "C:\\sessions\\session.jsonl" },
		}),
	);

	const messages = await manager.loadMessages("agent");
	const summaryCard = messages.find((message) => message.meta?.type === "compaction");
	assert.ok(summaryCard, "压缩会话必须补出压缩摘要卡片");
	// 关键契约：归档正文不随基线下发（MB 级结构化克隆会顶爆渲染进程），只给索引。
	assert.equal(summaryCard.meta.compactionId, "comp1");
	assert.equal(summaryCard.meta.archivedMessageCount, 1);
	assert.equal("archivedMessages" in summaryCard.meta, false);
	// 保留的消息仍在时间线上
	assert.equal(messages.some((message) => String(message.text ?? "").includes("q1")), true);

	// 展开时按需取回归档正文
	const { messages: archived } = await manager.readArchivedMessages("agent", "comp1");
	assert.equal(archived.length, 1);
	// 归档段是 a1（assistant），保留段是 u1（user）：长度 + 角色足以区分「取回归档」
	// 与「把整条分支又返回一遍」。（该用例的 messageContent 是桩，文本提取不可断言）
	assert.equal(archived[0].role, "assistant");
	// 取不到必须抛错，不能静默返回空数组（否则 UI 显示「0 条归档」，用户以为历史丢了）
	await assert.rejects(() => manager.readArchivedMessages("agent", "missing-compaction"));
});

test("cloneSession prefers the new fork command and falls back to the legacy clone", async () => {
	const { AgentManager, agentProcessSlot, agentTranscript, agentRunState } = loadAgentManager();
	const requests = [];
	const manager = createManager(AgentManager);
	manager.agents.set(
		"agent",
		createRuntimeFixture({
			agentProcessSlot,
			agentTranscript,
			agentRunState,
			client: {
				request: async (request) => {
					requests.push(request);
					if (request.type === "fork") {
						return {
							type: "response",
							command: "fork",
							success: true,
							data: { cancelled: false, sessionPath: "C:\\sessions\\copy.jsonl" },
						};
					}
					return { type: "response", command: request.type, success: false, error: `Unknown command: ${request.type}` };
				},
			},
			tab: {},
		}),
	);
	manager.refreshRuntimeAfterSessionReplacement = async () => {};

	const result = await manager.cloneSession("agent");

	assert.deepEqual(requests.map((request) => request.type), ["fork"]);
	assert.equal(result.sessionPath, "C:\\sessions\\copy.jsonl");

	// 旧版 pi：fork 回 "Unknown command: fork" → 才退到 clone，且报错只能是 clone 的。
	const legacyManager = createManager(AgentManager);
	const legacyRequests = [];
	legacyManager.agents.set(
		"agent",
		createRuntimeFixture({
			agentProcessSlot,
			agentTranscript,
			agentRunState,
			client: {
				request: async (request) => {
					legacyRequests.push(request);
					if (request.type === "clone") {
						return { type: "response", command: "clone", success: true, data: { cancelled: false } };
					}
					return { type: "response", command: request.type, success: false, error: `Unknown command: ${request.type}` };
				},
			},
			tab: {},
		}),
	);
	legacyManager.refreshRuntimeAfterSessionReplacement = async () => {};

	const legacyResult = await legacyManager.cloneSession("agent");

	assert.deepEqual(legacyRequests.map((request) => request.type), ["fork", "clone"]);
	assert.equal(legacyResult.cancelled, false);
});
