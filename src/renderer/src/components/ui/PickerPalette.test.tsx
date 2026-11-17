// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PickerPalette } from "./PickerPalette";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `PickerPalette` 是 composer 四个选择器浮层的公共外壳。这里验证接线：Esc 走关闭层、
 * 外部点击走 backdrop 的 click（两条路径分工见组件头注释）、点浮层内部不关闭、
 * 焦点归还给打开它的元素。
 *
 * 「焦点归还」是这次收敛真正修好的行为——旧实现只有鼠标路径，Esc 无效，
 * 关闭后焦点留在被卸载的节点上。
 */

let container: HTMLDivElement;
let root: Root;

function Harness(props: { onClose: () => void }) {
	// 打开者先拿到焦点再挂载浮层，复现真实路径：点按钮 → 按钮聚焦 → 状态位打开浮层。
	const [open, setOpen] = useState(false);
	return (
		<>
			<button id="trigger" type="button" onClick={() => setOpen(true)}>
				open
			</button>
			{open && (
				<PickerPalette
					className="model-picker"
					onClose={() => {
						setOpen(false);
						props.onClose();
					}}
				>
					<button id="inside" type="button">
						inside
					</button>
				</PickerPalette>
			)}
		</>
	);
}

function pressEscape(): void {
	document.body.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
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

it("Esc 关闭浮层并把焦点还给打开它的元素", () => {
	const onClose = vi.fn();
	act(() => {
		root.render(<Harness onClose={onClose} />);
	});
	const trigger = container.querySelector<HTMLButtonElement>("#trigger");
	act(() => trigger?.focus());
	act(() => trigger?.click());
	act(() => container.querySelector<HTMLButtonElement>("#inside")?.focus());

	act(() => pressEscape());

	expect(onClose).toHaveBeenCalledTimes(1);
	expect(container.querySelector(".picker-palette")).toBeNull();
	expect(document.activeElement?.id).toBe("trigger");
});

it("点浮层内部不关闭，点 backdrop 关闭", () => {
	const onClose = vi.fn();
	act(() => {
		root.render(<Harness onClose={onClose} />);
	});
	act(() => container.querySelector<HTMLButtonElement>("#trigger")?.click());

	const palette = container.querySelector<HTMLElement>(".picker-palette");
	const backdrop = container.querySelector<HTMLElement>(".picker-backdrop");
	act(() => {
		palette?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(onClose).not.toHaveBeenCalled();
	expect(container.querySelector(".picker-palette")).not.toBeNull();

	// 外部点击由 backdrop 的 click 承担：关闭层的 pointerdown 会先卸载浮层，
	// 紧随的 click 落到下层元素上，等于顺带触发一次下面的按钮。
	act(() => {
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
	});
	expect(onClose).not.toHaveBeenCalled();
	expect(container.querySelector(".picker-palette")).not.toBeNull();

	act(() => {
		backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(onClose).toHaveBeenCalledTimes(1);
	expect(container.querySelector(".picker-palette")).toBeNull();
});

it("保留调用方给的 palette 类名，外壳结构不变", () => {
	act(() => {
		root.render(<Harness onClose={() => {}} />);
	});
	act(() => container.querySelector<HTMLButtonElement>("#trigger")?.click());
	const palette = container.querySelector(".picker-palette");
	expect(palette?.className).toBe("picker-palette model-picker");
	expect(palette?.parentElement?.className).toBe("picker-backdrop");
});
