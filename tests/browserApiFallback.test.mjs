import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 共享 ipc.ts 只有 type-only import，转译后无运行时依赖；浏览器适配层现在从它取
 * webRoutes 描述符，沙箱必须提供同一份模块，否则 require 直接抛错。
 */
function loadSharedIpcModule() {
	const source = readFileSync("src/shared/ipc.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (specifier) => {
			throw new Error(`Unexpected require in shared/ipc: ${specifier}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "ipc.ts" });
	return sandbox.exports;
}

function loadBrowserApiModule() {
	const sharedIpc = loadSharedIpcModule();
	const source = readFileSync("src/renderer/src/browserApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const previewProjects = [{ id: "preview-project", name: "Preview" }];
	const previewAgents = [{ id: "preview-agent", title: "Preview Agent" }];
	const sandbox = {
		exports: {},
		require: (specifier) => {
			if (specifier === "./i18n") {
				return {
					t: (key, params) => `${key}:${params?.status ?? ""}:${params?.statusText ?? ""}`,
				};
			}
			// browserApi 只用版本号判断是否需要丢弃过期全量结果；这些用例不涉及流合并。
			if (specifier === "../../shared/messageStreamVersion") {
				return { messageStreamVersion: () => 0 };
			}
			if (specifier === "../../shared/ipc") {
				return sharedIpc;
			}
			if (specifier === "./previewApi") {
				return {
					createPreviewApi: () => ({
						projects: {
							list: async () => previewProjects,
						},
						agents: {
							list: async () => previewAgents,
							onState: () => () => undefined,
							onMessages: () => () => undefined,
						},
						sessions: {
							list: async () => [],
						},
						settings: {
							get: async () => ({ webServiceEnabled: false }),
						},
					}),
				};
			}
			throw new Error(`Unexpected require: ${specifier}`);
		},
		window: {
			setInterval: () => 1,
			clearInterval: () => undefined,
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "browserApi.ts",
	});
	return sandbox.exports;
}

test("falls back to preview lists when Vite returns HTML for web state", async () => {
	const { createBrowserApi } = loadBrowserApiModule();
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => {
			throw new Error("Unexpected token <");
		},
	});

	const api = createBrowserApi();

	try {
		const projects = await api.projects.list();
		const agents = await api.agents.list();

		assert.deepEqual(projects, [{ id: "preview-project", name: "Preview" }]);
		assert.deepEqual(agents, [{ id: "preview-agent", title: "Preview Agent" }]);
	} finally {
		globalThis.fetch = previousFetch;
	}
});
