import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	extractResultDetails,
	extractTodoItems,
	normalizeTodoSnapshot,
} from "./todo";

describe("extractResultDetails", () => {
	it("提取 details 包装形态（老协议）", () => {
		const result = { details: { phases: [{ name: "A", tasks: [] }] } };
		assert.deepEqual(extractResultDetails(result), result.details);
	});

	it("识别 omp 无包装快照形态（result 直接是 {op, phases}）", () => {
		const result = {
			op: "init",
			phases: [{ name: "A", tasks: [{ content: "t1", status: "pending" }] }],
			storage: "session",
		};
		assert.equal(extractResultDetails(result), result);
	});

	it("普通工具结果（content 数组）返回 undefined", () => {
		assert.equal(extractResultDetails({ content: [{ type: "text", text: "ok" }] }), undefined);
		assert.equal(extractResultDetails("text"), undefined);
		assert.equal(extractResultDetails(undefined), undefined);
	});
});

describe("normalizeTodoSnapshot", () => {
	it("解析 omp phases 快照并按 phase 分组", () => {
		const items = normalizeTodoSnapshot({
			op: "init",
			phases: [
				{ name: "验证", tasks: [{ content: "typecheck", status: "in_progress" }] },
				{ name: "修复", tasks: [{ content: "修 bug", status: "pending" }] },
			],
		});
		assert.equal(items.length, 2);
		assert.equal(items[0].phase, "验证");
		assert.equal(items[0].status, "in_progress");
		assert.equal(items[1].phase, "修复");
	});

	it("过滤空 content 与非法项", () => {
		const items = normalizeTodoSnapshot({
			phases: [
				{ name: "A", tasks: [{ content: "", status: "pending" }, "bad", { content: "ok" }] },
			],
		});
		assert.equal(items.length, 1);
		assert.equal(items[0].content, "ok");
	});
});

describe("extractTodoItems", () => {
	it("优先 meta.details（omp 快照）", () => {
		const items = extractTodoItems({
			details: { op: "init", phases: [{ name: "A", tasks: [{ content: "t1", status: "completed" }] }] },
			args: '{"op":"init","list":[]}',
		});
		assert.equal(items.length, 1);
		assert.equal(items[0].content, "t1");
		assert.equal(items[0].status, "completed");
	});

	it("回退 meta.args.todos（TodoWrite 风格）", () => {
		const items = extractTodoItems({
			args: JSON.stringify({ todos: [{ content: "a", status: "pending" }] }),
		});
		assert.equal(items.length, 1);
		assert.equal(items[0].content, "a");
	});

	it("无可用数据返回空数组", () => {
		assert.equal(extractTodoItems(undefined).length, 0);
		assert.equal(extractTodoItems({ args: "{}" }).length, 0);
		assert.equal(extractTodoItems({ details: { content: [] } }).length, 0);
	});
});
