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
	const sandbox = {
		AbortController,
		clearTimeout,
		exports: {},
		process: { ...process, platform: "win32" },
		setTimeout,
		require: (id) => {
			if (id === "./baseUrlPath") return loadBaseUrlPath();
			if (id === "node:fs/promises") {
				return {
					mkdir: async () => {},
					readFile: async () => {
						if (content == null) throw new Error("ENOENT");
						return content;
					},
					writeFile: async (filePath, nextContent) => {
						content = nextContent;
						writes.push({ filePath, content: nextContent });
					},
				};
			}
			if (id === "node:path") return path.win32;
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			if (id === "electron") return { net: {} };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "ConfigManager.ts" });
	return { ...sandbox.exports, getContent: () => content, writes };
}

test("preserves POSIX WSL trust keys under Windows path semantics", async () => {
	const { ConfigManager, getContent, writes } = loadConfigManager();
	const manager = new ConfigManager("C:\\OmpDeck\\config");

	await manager.ensureTrustedDirectory("/root/ba_cli/");
	assert.deepEqual(JSON.parse(getContent()), { "/root/ba_cli": true });
	assert.equal(await manager.getProjectTrustDecision("/root/ba_cli/subdir"), true);

	await manager.setProjectTrustDecision("/root/ba_cli/subdir/../private", false);
	assert.deepEqual(JSON.parse(getContent()), {
		"/root/ba_cli": true,
		"/root/ba_cli/private": false,
	});
	assert.equal(await manager.getProjectTrustDecision("/root/ba_cli/private/nested"), false);
	assert.equal(writes.every((write) => write.filePath === "C:\\OmpDeck\\config\\trust.json"), true);
});

test("retains case-insensitive matching for native Windows trust keys", async () => {
	const { ConfigManager } = loadConfigManager();
	const manager = new ConfigManager("C:\\OmpDeck\\config");

	await manager.setProjectTrustDecision("C:\\Repo", true);
	assert.equal(await manager.getProjectTrustDecision("c:\\repo\\child"), true);
});

test("buildModelsRequest honors provider User-Agent override for OpenAI gateways", () => {
	const { ConfigManager } = loadConfigManager();
	const manager = new ConfigManager("C:\\OmpDeck\\config");

	// 未配自定义 UA：应注入 SDK 默认 UA（模拟 pi 的 OpenAI JS SDK）
	const defaultReq = manager.buildModelsRequest(
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
	const overrideReq = manager.buildModelsRequest(
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

