import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizePiCommands } from "./piCommands";

test("摊平 omp 的 input.hint 并保留 subcommands", () => {
	const commands = normalizePiCommands([
		{
			name: "security",
			description: "Plan, run, inspect security scans",
			source: "builtin",
			// 线上仍会带 aliases，桌面契约不消费，归一化时不透传
			aliases: ["sec"],
			input: { hint: "<plan|scan|status>" },
			subcommands: [
				{ name: "plan", description: "Create a plan" },
				{ name: "" },
			],
		},
	]);

	assert.deepEqual(commands, [
		{
			name: "security",
			description: "Plan, run, inspect security scans",
			source: "builtin",
			inputHint: "<plan|scan|status>",
			subcommands: [{ name: "plan", description: "Create a plan" }],
		},
	]);
});

test("丢弃非法条目、原样保序（去重交给渲染层）", () => {
	const commands = normalizePiCommands([
		{ name: "dup", description: "builtin" },
		{ name: "  spaced  ", source: 42, input: { hint: 7 } },
		{ name: "dup", description: "extension" },
		{ name: "   " },
		{ description: "no name" },
		null,
		"not-an-object",
	]);

	assert.deepEqual(commands, [
		{ name: "dup", description: "builtin" },
		// 非字符串字段直接省略：渲染层不会拿到半截对象
		{ name: "spaced" },
		{ name: "dup", description: "extension" },
	]);
});

test("非数组输入返回空列表", () => {
	assert.deepEqual(normalizePiCommands(undefined), []);
	assert.deepEqual(normalizePiCommands({ commands: [] }), []);
});
