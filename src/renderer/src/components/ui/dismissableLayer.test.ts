// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDismissableLayer } from "./dismissableLayer";

/**
 * 关闭层的核心不变式：一份 window 监听、Esc 只关最上面一层、外部点击关闭所有
 * 不含点击目标的层。用 jsdom 真发事件验证，不碰内部实现。
 */

function firePointerDown(target: HTMLElement): void {
	target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

function fireEscape(): void {
	document.body.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
	);
}

const unregisters: Array<() => void> = [];

afterEach(() => {
	while (unregisters.length > 0) unregisters.pop()?.();
});

describe("dismissableLayer", () => {
	it("Esc 只关闭最上面一层，并消费按键", () => {
		const parentEl = document.createElement("div");
		const childEl = document.createElement("div");
		document.body.append(parentEl, childEl);
		const dismissParent = vi.fn();
		const dismissChild = vi.fn();
		unregisters.push(
			registerDismissableLayer({ getElement: () => parentEl, onDismiss: dismissParent }),
			registerDismissableLayer({ getElement: () => childEl, onDismiss: dismissChild }),
		);

		fireEscape();

		expect(dismissChild.mock.calls).toEqual([["escape"]]);
		expect(dismissParent).not.toHaveBeenCalled();

		parentEl.remove();
		childEl.remove();
	});

	it("点外部关闭所有不含点击目标的层，点进外层内部只关内层", () => {
		const outerEl = document.createElement("div");
		const innerEl = document.createElement("div");
		const insideOuter = document.createElement("button");
		const outside = document.createElement("button");
		outerEl.appendChild(insideOuter);
		document.body.append(outerEl, innerEl, outside);

		const dismissOuter = vi.fn();
		const dismissInner = vi.fn();
		unregisters.push(
			registerDismissableLayer({ getElement: () => outerEl, onDismiss: dismissOuter }),
			registerDismissableLayer({ getElement: () => innerEl, onDismiss: dismissInner }),
		);

		firePointerDown(insideOuter);
		expect(dismissInner.mock.calls).toEqual([["outside-pointer"]]);
		expect(dismissOuter).not.toHaveBeenCalled();

		dismissInner.mockClear();
		firePointerDown(outside);
		expect(dismissOuter.mock.calls).toEqual([["outside-pointer"]]);

		outerEl.remove();
		innerEl.remove();
		outside.remove();
	});

	it("多个层共用一份 window 监听，全部注销后卸掉", () => {
		const addSpy = vi.spyOn(window, "addEventListener");
		const removeSpy = vi.spyOn(window, "removeEventListener");
		const el = document.createElement("div");
		document.body.appendChild(el);

		const unregisterFirst = registerDismissableLayer({
			getElement: () => el,
			onDismiss: () => undefined,
		});
		expect(addSpy.mock.calls.map((call) => call[0])).toEqual(["pointerdown", "keydown"]);

		// 第二层不重复挂监听：这就是「9 处各自 addEventListener」被收掉的收益。
		unregisters.push(
			registerDismissableLayer({ getElement: () => el, onDismiss: () => undefined }),
		);
		expect(addSpy).toHaveBeenCalledTimes(2);

		unregisterFirst();
		expect(removeSpy).not.toHaveBeenCalled();
		unregisters.pop()?.();
		expect(removeSpy.mock.calls.map((call) => call[0])).toEqual(["pointerdown", "keydown"]);

		addSpy.mockRestore();
		removeSpy.mockRestore();
		el.remove();
	});

	it("dismissOnEscape:false 的层跳过 Esc，交给下面一层", () => {
		const keepEl = document.createElement("div");
		const closableEl = document.createElement("div");
		document.body.append(keepEl, closableEl);
		const dismissClosable = vi.fn();
		unregisters.push(
			registerDismissableLayer({ getElement: () => closableEl, onDismiss: dismissClosable }),
			registerDismissableLayer({
				getElement: () => keepEl,
				onDismiss: () => undefined,
				dismissOnEscape: false,
			}),
		);

		fireEscape();

		expect(dismissClosable.mock.calls).toEqual([["escape"]]);
		keepEl.remove();
		closableEl.remove();
	});

	it("Esc 时先归还焦点再通知关闭", () => {
		const layerEl = document.createElement("div");
		const triggerEl = document.createElement("button");
		document.body.append(layerEl, triggerEl);
		const order: string[] = [];
		triggerEl.addEventListener("focus", () => order.push("focus"));
		unregisters.push(
			registerDismissableLayer({
				getElement: () => layerEl,
				getReturnFocus: () => triggerEl,
				onDismiss: () => order.push("dismiss"),
			}),
		);

		fireEscape();

		expect(order).toEqual(["focus", "dismiss"]);
		layerEl.remove();
		triggerEl.remove();
	});

	it("先于层注册的 document 捕获监听器（如 Radix Dialog）收不到被层消费的 Esc", () => {
		// 回归：监听曾挂在 document 捕获阶段，与弹框的 Esc 处理处于同一节点，
		// 于是「谁先注册谁先跑」——弹框先挂载时一次 Esc 会同时关掉选择器与弹框。
		const outerDialogEscape = vi.fn();
		document.addEventListener("keydown", outerDialogEscape, { capture: true });
		const layerEl = document.createElement("div");
		document.body.append(layerEl);
		const dismissLayer = vi.fn();
		unregisters.push(
			registerDismissableLayer({ getElement: () => layerEl, onDismiss: dismissLayer }),
		);

		fireEscape();

		expect(dismissLayer.mock.calls).toEqual([["escape"]]);
		expect(outerDialogEscape).not.toHaveBeenCalled();
		document.removeEventListener("keydown", outerDialogEscape, { capture: true });
		layerEl.remove();
	});
});
