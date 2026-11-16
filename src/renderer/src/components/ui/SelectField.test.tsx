// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectField } from "./SelectField";

/**
 * `SelectField` 是 20 个调用点的公共外壳。它现在只是 `Listbox` 的标签包装，
 * 所以这里验证的是「接线没丢」：值回退、description、Esc 关闭、点击选中。
 */

const options = [
	{ value: "smol", label: "smol" },
	{ value: "slow", label: "slow" },
];

let container: HTMLDivElement;
let root: Root;

function Harness(props: { onChange?: (value: string) => void }) {
	const [value, setValue] = useState("smol");
	return (
		<SelectField
			label="角色"
			description="存档后生效"
			value={value}
			options={options}
			onChange={(next) => {
				setValue(next);
				props.onChange?.(next);
			}}
		/>
	);
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function control(): HTMLButtonElement {
	const node = container.querySelector<HTMLButtonElement>(".ui-select-control");
	if (!node) throw new Error("control missing");
	return node;
}

it("渲染标签、当前值与说明文字", () => {
	act(() => root.render(<Harness />));

	expect(container.querySelector(".ui-field-label")?.textContent).toBe("角色");
	expect(container.querySelector(".ui-select-value")?.textContent).toBe("smol");
	expect(container.querySelector(".ui-field-description")?.textContent).toBe("存档后生效");
});

it("展开后可选中，Esc 可关闭", () => {
	const onChange = vi.fn();
	act(() => root.render(<Harness onChange={onChange} />));

	act(() => control().dispatchEvent(new MouseEvent("click", { bubbles: true })));
	const items = Array.from(
		container.querySelectorAll<HTMLButtonElement>(".ui-select-option"),
	);
	expect(items).toHaveLength(2);

	act(() => items[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
	expect(onChange.mock.calls).toEqual([["slow"]]);
	expect(container.querySelector(".ui-select-menu")).toBeNull();
	expect(container.querySelector(".ui-select-value")?.textContent).toBe("slow");

	act(() => control().dispatchEvent(new MouseEvent("click", { bubbles: true })));
	expect(container.querySelector(".ui-select-menu")).not.toBeNull();

	act(() => {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
	});

	expect(container.querySelector(".ui-select-menu")).toBeNull();
});

it("值不在选项里时回退到第一个选项的标签（旧行为）", () => {
	act(() =>
		root.render(
			<SelectField
				label="角色"
				value="unset-value"
				options={options}
				onChange={() => undefined}
			/>,
		),
	);

	expect(container.querySelector(".ui-select-value")?.textContent).toBe("smol");
});
