import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

// ConfigManager 顶部从 ./baseUrlPath 解构导入（src/main/config/baseUrlPath.ts）。
// 该模块无内部依赖，直接转译注入；测试文件自身的 require 会把 "./baseUrlPath"
// 解析到 tests/ 目录，必须显式提供。
function loadBaseUrlPath() {
	const source = readFileSync("src/main/config/baseUrlPath.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, { filename: "baseUrlPath.ts" });
	return sandbox.exports;
}

function loadConfigManager() {
	let content;
	const writes = [];
	const source = readFileSync("src/main/config/ConfigManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	// ConfigManager 值导入 ./OmpRolesStore 与 ./TrustStore（各自再导入 shared/
	// 或 node 内建）；均以真实源码转译注入 + 共享的 fs/promises 假实现（EIO 语义：
	// 首次读抛 ENOENT = 空存储，写操作收进 writes 供断言），避免测试文件自身的
	// require 把相对路径解析到 tests/ 目录。
	const sharedRoles = loadTranspiledModule("src/shared/types/ompRoles.ts");
	const fsPromisesFake = {
		mkdir: async () => {},
		readFile: async () => {
			if (content == null) {
				const err = new Error("ENOENT");
				err.code = "ENOENT";
				throw err;
			}
			return content;
		},
		writeFile: async (filePath, nextContent) => {
			content = nextContent;
			writes.push({ filePath, content: nextContent });
		},
	};
	const rolesStore = loadTranspiledModule("src/main/config/OmpRolesStore.ts", (id) => {
		if (id === "../../shared/types/ompRoles") return sharedRoles;
		return undefined;
	}, { fsPromises: fsPromisesFake });
	const trustStore = loadTranspiledModule("src/main/config/TrustStore.ts", (id) => {
		return undefined;
	}, { fsPromises: fsPromisesFake });
	const probe = loadTranspiledModule("src/main/config/providerProbe.ts", (id) => {
		if (id === "./baseUrlPath") return loadBaseUrlPath();
		if (id === "../../shared/types/ompRoles") return sharedRoles;
		return undefined;
	});
	const sandbox = {
		AbortController,
		clearTimeout,
		exports: {},
		process: { ...process, platform: "win32" },
		setTimeout,
		require: (id) => {
			if (id === "./baseUrlPath") return loadBaseUrlPath();
			if (id === "./OmpRolesStore") return rolesStore;
			if (id === "./TrustStore") return trustStore;
			if (id === "./providerProbe") return probe;
			if (id === "node:path") return path.win32;
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			if (id === "electron") return { net: {} };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "ConfigManager.ts" });
	return { ...sandbox.exports, getContent: () => content, writes };
}

/** 把源码 TS 转译为 CommonJS 后在 vm 沙箱执行；extraRequire 返回 undefined 时走真实 require。 */
function loadTranspiledModule(sourcePath, extraRequire = () => undefined, options = {}) {
	const { outputText } = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		process: { ...process, platform: "win32" },
		setTimeout,
		require: (id) => {
			const mapped = extraRequire(id);
			if (mapped) return mapped;
			if (id === "node:fs/promises") return options.fsPromises ?? require(id);
			if (id === "node:fs") return require(id);
			if (id === "node:path") return path.win32;
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: sourcePath });
	return sandbox.exports;
}
/** 复用与 loadConfigManager 相同的转译映射，拿到 providerProbe 的公开函数。 */
function loadProbeExportsForTest() {
	return loadTranspiledModule("src/main/config/providerProbe.ts", (id) => {
		if (id === "./baseUrlPath") return loadBaseUrlPath();
		return undefined;
	});
}

test("preserves POSIX WSL trust keys under Windows path semantics", async () => {
	const { ConfigManager, getContent, writes } = loadConfigManager();
	const manager = new ConfigManager("C:\\OmpDeck\\config");

	await manager.trustStore.ensureTrustedDirectory("/root/ba_cli/");
	assert.deepEqual(JSON.parse(getContent()), { "/root/ba_cli": true });
	assert.equal(await manager.trustStore.getDecision("/root/ba_cli/subdir"), true);

	await manager.trustStore.setDecision("/root/ba_cli/subdir/../private", false);
	assert.deepEqual(JSON.parse(getContent()), {
		"/root/ba_cli": true,
		"/root/ba_cli/private": false,
	});
	assert.equal(await manager.trustStore.getDecision("/root/ba_cli/private/nested"), false);
	assert.equal(writes.every((write) => write.filePath === "C:\\OmpDeck\\config\\trust.json"), true);
});

test("retains case-insensitive matching for native Windows trust keys", async () => {
	const { ConfigManager } = loadConfigManager();
	const manager = new ConfigManager("C:\\OmpDeck\\config");

	await manager.trustStore.setDecision("C:\\Repo", true);
	assert.equal(await manager.trustStore.getDecision("c:\\repo\\child"), true);
});

test("buildModelsRequest honors provider User-Agent override for OpenAI gateways", async () => {
	// Q32：探测构造层已抽为 providerProbe 纯模块——测试面即公开函数，
	// ConfigManager 沙箱的 require("./providerProbe") 映射即转译后真模块，
	// 这里复用同一映射拿到它调用公开函数。
	const { buildModelsRequest } = loadProbeExportsForTest();
	// 未配自定义 UA：应注入 SDK 默认 UA（模拟 pi 的 OpenAI JS SDK）
	const defaultReq = buildModelsRequest(
		"https://puppyrouter.com/v1",
		"sk-test",
		"openai-responses",
	);
	assert.equal(
		defaultReq[0].headers["User-Agent"],
		"OpenAI/JS 6.26.0",
		"default: SDK UA injected",
	);

	// 配置了自定义 User-Agent（如拦截 SDK UA 的中转网关）：必须保留覆盖值，
	// 不能退回 SDK UA，否则 PuppyRouter 等网关注册 403 "Your request was blocked."。
	const overrideReq = buildModelsRequest(
		"https://puppyrouter.com/v1",
		"sk-test",
		"openai-responses",
		{ "User-Agent": "curl/8.0.0" },
	);
	assert.equal(
		overrideReq[0].headers["User-Agent"],
		"curl/8.0.0",
		"override UA wins over SDK UA",
	);
	assert.equal(overrideReq[0].url, "https://puppyrouter.com/v1/models");
});

