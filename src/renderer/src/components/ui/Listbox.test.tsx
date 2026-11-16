// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Listbox } from "./Listbox";
import { useDismissableLayer } from "./useDismissableLayer";

/**
 * Listbox 的测试面是它的界面行为：打开/选中/关闭，以及两条此前漏掉的键盘能力
 * （Esc 关闭、方向键在选项间移动）。关闭层与 ARIA 结构都从这一层验证，
 * 不测内部实现——内部换成别的状态机时这些断言不应改。
 */

const options = [
	{ value: "alpha", label: "Alpha" },
	{ value: "beta", label: "Beta" },
	{ value: "gamma", label: "Gamma" },
];

let container: HTMLDivElement;
let root: Root;

function Harness(props: { onSelect?: (value: string) => void }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [value, setValue] = useState("alpha");
	return (
		<div ref={containerRef}>
			<Listbox
				containerRef={containerRef}
				value={value}
				options={options}
				onSelect={(next) => {
					setValue(next);
					props.onSelect?.(next);
				}}
				ariaLabel="pick"
				triggerClassName="trigger"
				valueClassName="value"
				menuClassName="menu"
				optionClassName="option"
			/>
		</div>
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

function menu(): HTMLElement | null {
	return container.querySelector(".menu");
}

function trigger(): HTMLButtonElement {
	const node = container.querySelector<HTMLButtonElement>(".trigger");
	if (!node) throw new Error("trigger missing");
	return node;
}

function optionButtons(): HTMLButtonElement[] {
	return Array.from(container.querySelectorAll<HTMLButtonElement>(".option"));
}

function openMenu(): void {
	act(() => {
		trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

it("点击触发器打开菜单，ARIA 状态跟着反转", () => {
	act(() => root.render(<Harness />));
	expect(menu()).toBeNull();
	expect(trigger().getAttribute("aria-expanded")).toBe("false");

	openMenu();

	expect(menu()?.getAttribute("role")).toBe("listbox");
	expect(trigger().getAttribute("aria-expanded")).toBe("true");
	expect(optionButtons().map((node) => node.textContent)).toEqual([
		"Alpha",
		"Beta",
		"Gamma",
	]);
	expect(optionButtons()[0].getAttribute("aria-selected")).toBe("true");
});

it("选中选项后关闭并把值写回", () => {
	const onSelect = vi.fn();
	act(() => root.render(<Harness onSelect={onSelect} />));
	openMenu();

	act(() => {
		optionButtons()[2].dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});

	expect(onSelect.mock.calls).toEqual([["gamma"]]);
	expect(menu()).toBeNull();
	expect(container.querySelector(".value")?.textContent).toBe("Gamma");
	// 焦点回到触发器，否则下一次 Tab 会从文档开头重新开始。
	expect(document.activeElement).toBe(trigger());
});

it("Escape 关闭菜单，且只关最内层", () => {
	act(() => root.render(<Harness />));
	openMenu();

	act(() => {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
	});

	expect(menu()).toBeNull();
});

it("方向键打开菜单并在选项间移动焦点", () => {
	act(() => root.render(<Harness />));

	act(() => {
		trigger().dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
	});
	expect(menu()).not.toBeNull();
	// 打开时焦点落在当前选中项（alpha）。
	expect(document.activeElement).toBe(optionButtons()[0]);

	act(() => {
		document.activeElement?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
	});
	expect(document.activeElement).toBe(optionButtons()[1]);
});

it("点外部关闭菜单", () => {
	act(() => root.render(<Harness />));
	openMenu();
	expect(menu()).not.toBeNull();

	const outside = document.createElement("button");
	document.body.appendChild(outside);
	act(() => {
		outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
	});

	expect(menu()).toBeNull();
	outside.remove();
});

it("嵌套层：内层 Listbox 打开时 Esc 只关内层", () => {
	function Outer() {
		const containerRef = useRef<HTMLDivElement>(null);
		const [open, setOpen] = useState(true);
		useDismissableLayer({
			open,
			elementRef: containerRef,
			onDismiss: () => setOpen(false),
		});
		return (
			<div ref={containerRef} data-testid="outer">
				{open && <Harness />}
			</div>
		);
	}

	act(() => root.render(<Outer />));
	expect(container.querySelector("[data-testid=outer]")).not.toBeNull();
	openMenu();

	act(() => {
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
	});

	// 内层菜单关闭，外层弹层留下。
	expect(menu()).toBeNull();
	expect(container.querySelector("[data-testid=outer]")).not.toBeNull();
});
