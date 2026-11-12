import { describe, expect, it } from "vitest";
import { buildSuggestionItems, detectTrigger, filterVisibleCommands } from "./AppUtils";
import type { PiCommand } from "../../../../shared/types";

const fast: PiCommand = {
	name: "fast",
	description: "Toggle priority service tier",
	source: "builtin",
	inputHint: "[on|off|status]",
	subcommands: [
		{ name: "on", description: "Enable fast tier" },
		{ name: "off", description: "Disable fast tier" },
	],
};

describe("filterVisibleCommands", () => {
	it("隐藏桌面已有等价入口的内置命令，但保留同名扩展命令", () => {
		const visible = filterVisibleCommands([
			{ name: "model", source: "builtin" },
			{ name: "model", source: "extension" },
			{ name: "fast", source: "builtin" },
		]);
		expect(visible).toEqual([
			{ name: "model", source: "extension" },
			{ name: "fast", source: "builtin" },
		]);
	});

	it("按名字去重（不区分大小写），保留先出现的可见项", () => {
		const visible = filterVisibleCommands([
			{ name: "Fast", source: "extension", description: "first" },
			{ name: "fast", source: "extension", description: "second" },
		]);
		expect(visible).toEqual([{ name: "Fast", source: "extension", description: "first" }]);
	});
});

describe("buildSuggestionItems 斜线命令", () => {
	it("以 runtime 目录为准，不注入手写清单", () => {
		const items = buildSuggestionItems("/", 1, [fast], []);
		expect(items.map((item) => item.value)).toEqual(["/fast"]);
	});

	it("把 input.hint 带进建议项", () => {
		const [item] = buildSuggestionItems("/fa", 3, [fast], []);
		expect(item.hint).toBe("[on|off|status]");
		expect(item.description).toBe("Toggle priority service tier");
	});

	it("命令名后跟子命令时列出匹配的 subcommands", () => {
		const items = buildSuggestionItems("/fast o", 8, [fast], []);
		expect(items).toEqual([
			{
				key: "fast on",
				label: "/fast on",
				description: "Enable fast tier",
				value: "/fast on",
			},
			{
				key: "fast off",
				label: "/fast off",
				description: "Disable fast tier",
				value: "/fast off",
			},
		]);
	});

	it("只有空格时列出全部子命令", () => {
		const items = buildSuggestionItems("/fast ", 6, [fast], []);
		expect(items.map((item) => item.value)).toEqual(["/fast on", "/fast off"]);
	});

	it("插入文本沿用 runtime 的命令原始大小写", () => {
		const mixed: PiCommand = { name: "MyFast", source: "extension", subcommands: [{ name: "on" }] };
		const items = buildSuggestionItems("/myfast o", 10, [mixed], []);
		expect(items.map((item) => item.value)).toEqual(["/MyFast on"]);
	});

	it("命令没有声明 subcommands 时不把参数当命令候选", () => {
		const items = buildSuggestionItems("/compact x", 10, [{ name: "compact", source: "builtin" }], []);
		expect(items).toEqual([]);
	});
});

describe("detectTrigger 子命令输入", () => {
	it("保留 `/命令 子命令` 触发", () => {
		expect(detectTrigger("/fast on", 8)).toMatchObject({ char: "/", query: "fast on" });
	});

	it("再出现空白就关闭，避免面板钉死", () => {
		expect(detectTrigger("/fast on off", 12)).toBeNull();
	});

	it("普通命令文本仍按原规则关闭", () => {
		expect(detectTrigger("/fast on, please", 17)).toBeNull();
	});

	it("正文里的斜杠词不触发子命令面板", () => {
		expect(detectTrigger("and/or something", 16)).toBeNull();
	});
});
