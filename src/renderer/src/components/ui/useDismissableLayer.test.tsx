// @vitest-environment jsdom
import { act, createElement, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDismissableLayer } from "./useDismissableLayer";

/**
 * 焦点归还的不变式：Esc 关闭后焦点回到「打开它的那个元素」。
 *
 * 这条不变式不能靠每个调用方各自透传 ref 保证——设备菜单、分支下拉、模型角色选择器、
 * 会话操作菜单都没传，此前的文档却宣称焦点会归还。快照必须落在渲染期：
 * 层内输入框的 autoFocus 在 commit 阶段就把 activeElement 抢走了。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(element: ReactElement): void {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => root.render(element));
}

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

/** 一个「触发器 + 带 autoFocus 输入框的弹层」的宿主，模拟真实的打开路径。 */
function Harness(): ReactElement {
	const [open, setOpen] = useState(false);
	const layerRef = useRef<HTMLDivElement>(null);
	useDismissableLayer({ open, elementRef: layerRef, onDismiss: () => setOpen(false) });
	return createElement(
		"div",
		null,
		createElement("button", { id: "trigger", onClick: () => setOpen(true) }, "open"),
		open
			? createElement(
					"div",
					{ ref: layerRef, id: "popup" },
					createElement("input", { id: "search", autoFocus: true }),
				)
			: null,
	);
}

function pressEscape(): void {
	document.body.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
	);
}

describe("useDismissableLayer", () => {
	it("未显式给 returnFocusRef 时，Esc 后焦点回到打开弹层的元素", () => {
		mount(createElement(Harness));

		const trigger = container.querySelector<HTMLButtonElement>("#trigger");
		act(() => trigger?.focus());
		act(() => trigger?.click());

		// autoFocus 已经把焦点搬进层里：这正是「注册期再读 activeElement」会读错的地方。
		expect(document.activeElement?.id).toBe("search");

		act(() => pressEscape());

		expect(container.querySelector("#popup")).toBeNull();
		expect(document.activeElement?.id).toBe("trigger");
	});

	it("显式 returnFocusRef 优先于自动快照", () => {
		const explicit = document.createElement("button");
		document.body.appendChild(explicit);
		function Explicit(): ReactElement {
			const [open, setOpen] = useState(false);
			const layerRef = useRef<HTMLDivElement>(null);
			const explicitRef = useRef<HTMLElement | null>(explicit);
			useDismissableLayer({
				open,
				elementRef: layerRef,
				onDismiss: () => setOpen(false),
				returnFocusRef: explicitRef,
			});
			return createElement(
				"div",
				null,
				createElement("button", { id: "trigger", onClick: () => setOpen(true) }, "open"),
				open ? createElement("div", { ref: layerRef, id: "popup" }) : null,
			);
		}

		mount(createElement(Explicit));
		act(() => container.querySelector<HTMLButtonElement>("#trigger")?.focus());
		act(() => container.querySelector<HTMLButtonElement>("#trigger")?.click());

		act(() => pressEscape());

		expect(document.activeElement).toBe(explicit);
		explicit.remove();
	});

	it("打开时没有真实焦点（body）则不抢焦点", () => {
		mount(createElement(Harness));
		act(() => container.querySelector<HTMLButtonElement>("#trigger")?.click());

		const spy = vi.spyOn(document.body, "focus");
		act(() => pressEscape());

		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("toggle 型浮层：真实 pointerdown + click 落在触发器上时收起，而不是先关后开", () => {
		function Toggle(): ReactElement {
			const [open, setOpen] = useState(false);
			const layerRef = useRef<HTMLDivElement>(null);
			const triggerRef = useRef<HTMLElement | null>(null);
			useDismissableLayer({
				open,
				elementRef: layerRef,
				triggerRef,
				onDismiss: () => setOpen(false),
			});
			return createElement(
				"div",
				null,
				createElement(
					"button",
					{
						id: "toggle",
						ref: triggerRef,
						onClick: () => setOpen((current) => !current),
					},
					"toggle",
				),
				open ? createElement("div", { ref: layerRef, id: "popup" }, "popup") : null,
			);
		}

		mount(createElement(Toggle));
		const trigger = container.querySelector<HTMLButtonElement>("#toggle")!;

		act(() => trigger.click());
		expect(container.querySelector("#popup")).not.toBeNull();

		// 打开态下再点一次：pointerdown 若把层关掉，随后 click 会重新打开（用户看到的是
		// 「按钮一直亮着」）。断言最终状态是收起，而不是仍存在。
		act(() => {
			trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			trigger.click();
		});

		expect(container.querySelector("#popup")).toBeNull();
	});
});
