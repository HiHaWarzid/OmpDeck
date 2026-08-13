import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadTodoModule() {
	const source = readFileSync("src/shared/todo.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "todo.ts",
	});
	return sandbox.exports;
}

test("isTodoWriteToolName 匹配 omp 原生 todo 与命名变体，不匹配只读查询", () => {
	const { isTodoWriteToolName } = loadTodoModule();
	assert.equal(isTodoWriteToolName("todo"), true);
	assert.equal(isTodoWriteToolName("TodoWrite"), true);
	assert.equal(isTodoWriteToolName("todo_write"), true);
	assert.equal(isTodoWriteToolName("Todo"), true);
	assert.equal(isTodoWriteToolName("todo_list"), false);
	assert.equal(isTodoWriteToolName("todo_get"), false);
	assert.equal(isTodoWriteToolName("read"), false);
});

test("normalizeTodoItems 过滤畸形项并归一化状态", () => {
	const { normalizeTodoItems } = loadTodoModule();
	const items = normalizeTodoItems([
		{ content: "任务 A", status: "in_progress", activeForm: "正在做 A" },
		{ content: "任务 B", status: "completed" },
		{ content: "任务 C", status: "unknown-status" },
		{ content: "" },
		null,
		{ status: "pending" },
	]);
	assert.equal(items.length, 3);
	assert.equal(items[0].status, "in_progress");
	assert.equal(items[0].activeForm, "正在做 A");
	assert.equal(items[1].status, "completed");
	// 未知状态回落 pending
	assert.equal(items[2].status, "pending");
	assert.equal(normalizeTodoItems("nope").length, 0);
});

test("normalizeTodoSnapshot 解析 omp phases 快照并保留分组", () => {
	const { normalizeTodoSnapshot } = loadTodoModule();
	const items = normalizeTodoSnapshot({
		op: "done",
		phases: [
			{ name: "Recon", tasks: [{ content: "确认根因", status: "completed" }] },
			{ name: "P0", tasks: [{ content: "修复", status: "in_progress" }, { content: "验证", status: "pending" }] },
		],
		storage: "session",
	});
	assert.equal(items.length, 3);
	assert.equal(items[0].phase, "Recon");
	assert.equal(items[0].status, "completed");
	assert.equal(items[1].phase, "P0");
	assert.equal(items[1].status, "in_progress");
	assert.equal(items[2].phase, "P0");
});

test("extractTodoItems 优先 meta.details.phases，回退 meta.args.todos", () => {
	const { extractTodoItems } = loadTodoModule();
	// omp：details 为对象快照
	const fromDetails = extractTodoItems({
		details: { phases: [{ name: "A", tasks: [{ content: "x", status: "pending" }] }] },
	});
	assert.equal(fromDetails.length, 1);
	assert.equal(fromDetails[0].phase, "A");
	// TodoWrite：args 为 JSON 字符串
	const fromArgs = extractTodoItems({
		args: JSON.stringify({ todos: [{ content: "y", status: "completed" }] }),
	});
	assert.equal(fromArgs.length, 1);
	assert.equal(fromArgs[0].status, "completed");
	// details 存在但无 phases（如错误快照）时回退 args
	const fallback = extractTodoItems({
		details: { error: "boom" },
		args: JSON.stringify({ todos: [{ content: "z", status: "in_progress" }] }),
	});
	assert.equal(fallback.length, 1);
	assert.equal(fallback[0].content, "z");
	// 无法解析时返回空
	assert.equal(extractTodoItems({ args: "not-json" }).length, 0);
	assert.equal(extractTodoItems({}).length, 0);
	assert.equal(extractTodoItems(undefined).length, 0);
});

test("extractResultDetails 提取结果对象中的 details", () => {
	const { extractResultDetails } = loadTodoModule();
	assert.deepEqual(
		extractResultDetails({ content: [], details: { phases: [] } }),
		{ phases: [] },
	);
	assert.equal(extractResultDetails({ content: [] }), undefined);
	assert.equal(extractResultDetails(null), undefined);
	assert.equal(extractResultDetails("text"), undefined);
});
