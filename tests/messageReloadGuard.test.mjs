import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 全量拉取的 seq 守卫（纯语义，不读 App 源码）：
 * 拉取期间有新 delta 到达（currentSeq 前进）→ 旧基线丢弃，避免覆盖新消息；
 * 序号相等才接受并整体替换。
 * App.ensureAgentMessagesLoaded 实现此语义（src/renderer/src/App.tsx）。
 *
 * 直接 `import` 走不通：messageDeltaResolver 以无扩展名的相对路径引用 composerModule，
 * Node 的 ESM 解析器不接受。这里沿用仓库其它源码审查套件的做法，转译成 CJS 后用 vm 注入。
 */

function loadResolver() {
	const transpile = (filePath) =>
		ts.transpileModule(readFileSync(filePath, "utf8"), {
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		}).outputText;
	const composerSandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(transpile("src/renderer/src/composer/composerModule.ts"), composerSandbox, {
		filename: "composerModule.ts",
	});
	const resolverSandbox = {
		exports: {},
		require: (id) => {
			if (id === "../composer/composerModule") return composerSandbox.exports;
			throw new Error(`unexpected import in messageDeltaResolver: ${id}`);
		},
	};
	vm.runInNewContext(transpile("src/renderer/src/utils/messageDeltaResolver.ts"), resolverSandbox, {
		filename: "messageDeltaResolver.ts",
	});
	return resolverSandbox.exports;
}

const { resolveFullPullResult } = loadResolver();

test("stale full pull is dropped when a delta arrived during fetch", () => {
	assert.equal(resolveFullPullResult(1, 2, []), null);
});

test("fresh full pull replaces the baseline", () => {
	const messages = [{ id: "a" }, { id: "b" }];
	const res = resolveFullPullResult(3, 3, messages);
	assert.deepEqual(res.messages, messages);
});
