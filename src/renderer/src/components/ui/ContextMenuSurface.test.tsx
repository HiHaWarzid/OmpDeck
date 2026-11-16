// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenuSurface } from "./ContextMenuSurface";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `ContextMenuSurface` 是六处右键菜单的公共外壳，关闭逻辑本身在 `dismissableLayer` 里，
 * 所以这里只验证接线与它独占的两条语义：
 * - Esc 关闭（旧实现六处菜单都只有鼠标路径，Esc 完全无效）；
 * - 外部点击走 backdrop 关闭，而不是关闭层的 pointerdown——否则一次「关菜单」的点击
 *   会穿透到下层元素上，顺带激活它。
 */

let container: HTMLDivElement;
let root: Root;

function Harness(props: { onClose: () => void; onInsideClick?: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button id="row" type="button" onClick={() => setOpen(true)}>
				row
			</button>
			{open && (
				<ContextMenuSurface
					x={40}
					y={60}
					className="filter-menu"
					onClose={() => {
						setOpen(false);
						props.onClose();
					}}
				>
					<button id="inside" type="button" onClick={props.onInsideClick}>
						inside
					</button>
				</ContextMenuSurface>
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

it("Esc 关闭菜单", () => {
	const onClose = vi.fn();
	act(() => root.render(<Harness onClose={onClose} />));
	act(() => container.querySelector<HTMLButtonElement>("#row")?.click());
	expect(container.querySelector(".context-menu")).not.toBeNull();

	act(() => pressEscape());

	expect(onClose).toHaveBeenCalledTimes(1);
	expect(container.querySelector(".context-menu")).toBeNull();
});

it("点菜单内部不关闭也不触发 backdrop", () => {
	const onClose = vi.fn();
	const onInsideClick = vi.fn();
	act(() => root.render(<Harness onClose={onClose} onInsideClick={onInsideClick} />));
	act(() => container.querySelector<HTMLButtonElement>("#row")?.click());

	act(() => container.querySelector<HTMLButtonElement>("#inside")?.click());

	expect(onInsideClick).toHaveBeenCalledTimes(1);
	expect(onClose).not.toHaveBeenCalled();
	expect(container.querySelector(".context-menu")).not.toBeNull();
});

it("点 backdrop 关闭，且菜单定位到传入坐标", () => {
	const onClose = vi.fn();
	act(() => root.render(<Harness onClose={onClose} />));
	act(() => container.querySelector<HTMLButtonElement>("#row")?.click());
	const menu = container.querySelector<HTMLDivElement>(".context-menu");
	expect(menu?.style.left).toBe("40px");
	expect(menu?.style.top).toBe("60px");
	expect(menu?.className).toContain("filter-menu");

	act(() => container.querySelector<HTMLDivElement>(".context-backdrop")?.click());

	expect(onClose).toHaveBeenCalledTimes(1);
	expect(container.querySelector(".context-menu")).toBeNull();
});
