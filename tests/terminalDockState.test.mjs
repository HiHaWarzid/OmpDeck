import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadTerminalDockStateModule() {
	const source = readFileSync("src/renderer/src/terminalDockState.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	// 单元测试里模拟 localStorage，避免依赖真实 DOM
	const localStore = new Map();
	const sandbox = {
		exports: {},
		localStorage: {
			getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
			setItem: (key, value) => {
				localStore.set(key, String(value));
			},
			removeItem: (key) => {
				localStore.delete(key);
			},
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "terminalDockState.ts",
	});
	return sandbox.exports;
}

test("resolves owner: agent wins over project", () => {
	const { resolveTerminalOwner, terminalOwnerKey } = loadTerminalDockStateModule();
	// resolveTerminalOwner 在 vm 上下文里创建对象字面量，跨 realm 的 deepStrictEqual
	// 会因原型不同报 "same structure but not reference-equal"，这里逐字段断言。
	const agentOwner = resolveTerminalOwner("a1", "p1");
	assert.equal(agentOwner?.kind, "agent");
	assert.equal(agentOwner?.id, "a1");
	const projectOwner = resolveTerminalOwner(undefined, "p1");
	assert.equal(projectOwner?.kind, "project");
	assert.equal(projectOwner?.id, "p1");
	assert.equal(resolveTerminalOwner(undefined, undefined), undefined);
	assert.equal(terminalOwnerKey({ kind: "agent", id: "a1" }), "agent:a1");
	assert.equal(terminalOwnerKey({ kind: "project", id: "p1" }), "project:p1");
});

test("remembers collapsed terminal dock state for each owner key", () => {
	const { setTerminalDockCollapsed, terminalOwnerKey } =
		loadTerminalDockStateModule();
	const agentA = terminalOwnerKey({ kind: "agent", id: "agentA" });
	const agentB = terminalOwnerKey({ kind: "agent", id: "agentB" });
	const current = {
		[agentA]: { open: true, collapsed: false },
		[agentB]: { open: true, collapsed: false },
	};

	const next = setTerminalDockCollapsed(current, agentA, true);

	assert.equal(next[agentA].collapsed, true);
	assert.equal(next[agentA].open, true);
	assert.equal(next[agentB].collapsed, false);
});

test("preserves collapsed state when toggling terminal open state", () => {
	const { setTerminalDockOpen, terminalOwnerKey } = loadTerminalDockStateModule();
	const agentA = terminalOwnerKey({ kind: "agent", id: "agentA" });
	const current = {
		[agentA]: { open: true, collapsed: true },
	};

	const closed = setTerminalDockOpen(current, agentA, false);
	const reopened = setTerminalDockOpen(closed, agentA, true);

	assert.equal(closed[agentA].open, false);
	assert.equal(closed[agentA].collapsed, true);
	assert.equal(reopened[agentA].open, true);
	assert.equal(reopened[agentA].collapsed, true);
});

test("prunes agent and project keys against their own live sets", () => {
	const { pruneTerminalDockState, terminalOwnerKey } =
		loadTerminalDockStateModule();
	const agentA = terminalOwnerKey({ kind: "agent", id: "agentA" });
	const agentB = terminalOwnerKey({ kind: "agent", id: "agentB" });
	const projectP = terminalOwnerKey({ kind: "project", id: "projP" });
	const current = {
		[agentA]: { open: true, collapsed: true },
		[agentB]: { open: true, collapsed: false },
		[projectP]: { open: true, collapsed: false },
	};

	// 关键回归：不能用 agent 集合误删 project 键
	const next = pruneTerminalDockState(
		current,
		new Set(["agentB"]),
		new Set(["projP"]),
	);

	assert.equal(next[agentA], undefined);
	assert.equal(next[agentB].open, true);
	assert.equal(next[projectP].open, true);
});

test("migrates pending agent dock state to replacement id", () => {
	const { migrateTerminalDockAgentState, terminalOwnerKey } =
		loadTerminalDockStateModule();
	const pending = terminalOwnerKey({ kind: "agent", id: "pending-1" });
	const real = terminalOwnerKey({ kind: "agent", id: "real-1" });
	const projectP = terminalOwnerKey({ kind: "project", id: "projP" });
	const current = {
		[pending]: { open: true, collapsed: true },
		[projectP]: { open: true, collapsed: false },
	};

	const next = migrateTerminalDockAgentState(
		current,
		new Map([["pending-1", "real-1"]]),
		new Set(["real-1"]),
	);

	assert.equal(next[pending], undefined);
	assert.deepEqual(next[real], { open: true, collapsed: true });
	assert.deepEqual(next[projectP], { open: true, collapsed: false });
});

test("project terminal session key normalizes cwd", () => {
	const { projectTerminalSessionKey } = loadTerminalDockStateModule();
	assert.equal(
		projectTerminalSessionKey("C:\\Work\\Demo\\"),
		projectTerminalSessionKey("c:/work/demo"),
	);
	assert.match(projectTerminalSessionKey("C:\\Work\\Demo"), /^cwd:/);
});

test("loads and saves global terminal height", () => {
	// W5：高度持久化（TERMINAL_HEIGHT_STORAGE_KEY + 下限钳制）收敛到 App.tsx 的
	// usePersistedState 接线（parse: raw >= TERMINAL_HEIGHT_MIN ? round : undefined），
	// terminalDockState.ts 只保留 key/min 契约常量。此处断言契约常量仍在，
	// 持久化行为由 App.tsx 的 usePersistedState 调用承担。
	const { TERMINAL_HEIGHT_STORAGE_KEY, TERMINAL_HEIGHT_MIN } =
		loadTerminalDockStateModule();
	assert.equal(TERMINAL_HEIGHT_STORAGE_KEY, "pid:terminal-dock-height");
	assert.equal(TERMINAL_HEIGHT_MIN, 120);

	// 迁移后的接线契约：App.tsx 用该 key 调 usePersistedState，且钳制语义保留。
	const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(
		appSource,
		/usePersistedState<number>\(\s*TERMINAL_HEIGHT_STORAGE_KEY,\s*COMPOSER_DEFAULT_TERMINAL_HEIGHT,[\s\S]*?TERMINAL_HEIGHT_MIN/,
	);
});
