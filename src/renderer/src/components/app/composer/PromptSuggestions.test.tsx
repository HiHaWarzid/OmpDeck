// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setI18nLocale } from "../../../i18n";
import { PromptSuggestions } from "./PromptSuggestions";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	setI18nLocale("zh-CN");
	// jsdom 没有实现 scrollIntoView，组件滚动到选中项时会调用。
	Element.prototype.scrollIntoView = () => undefined;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

it("命令参数提示与子命令标签都渲染在建议列表里", () => {
	act(() => {
		root.render(
			<PromptSuggestions
				prompt="/fast"
				items={[
					{
						key: "fast",
						label: "/fast",
						hint: "[on|off|status]",
						description: "Toggle fast mode",
						value: "/fast",
					},
					{
						key: "fast on",
						label: "/fast on",
						description: "Enable fast mode (priority tier)",
						value: "/fast on",
					},
				]}
				selectedIndex={0}
				onSelectedIndexChange={() => undefined}
				onClose={() => undefined}
				onPick={() => undefined}
			/>,
		);
	});

	// hint 紧贴命令名渲染为独立节点，说明文案仍完整保留
	expect(container.querySelector(".command-palette-hint")?.textContent).toBe("[on|off|status]");
	const labels = Array.from(container.querySelectorAll(".command-palette-label")).map((node) => node.textContent);
	expect(labels).toEqual(["/fast", "/fast on"]);
	const descriptions = Array.from(container.querySelectorAll(".command-palette-desc")).map((node) => node.textContent);
	expect(descriptions).toEqual(["Toggle fast mode", "Enable fast mode (priority tier)"]);
});
