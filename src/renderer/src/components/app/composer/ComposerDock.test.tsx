// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerDock, DockSection } from "./ComposerDock";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function renderDock() {
	act(() => {
		root.render(
			<ComposerDock maxBodyHeight={200}>
				<DockSection id="todo" icon={<span />} label="TODO">
					<div className="todo-body" />
				</DockSection>
				<DockSection id="queue" icon={<span />} label="Queue">
					<div className="queue-body" />
				</DockSection>
			</ComposerDock>,
		);
	});
}

it("手风琴：同一时刻只展开一个分区，再点一次收起", () => {
	renderDock();
	const chips = () =>
		Array.from(container.querySelectorAll<HTMLButtonElement>(".composer-dock-chip"));

	expect(container.querySelectorAll(".composer-dock-body")).toHaveLength(0);

	act(() => chips()[0]?.click());
	expect(container.querySelectorAll(".composer-dock-body")).toHaveLength(1);
	expect(container.querySelector(".todo-body")).not.toBeNull();
	expect(chips()[0]?.getAttribute("aria-expanded")).toBe("true");

	act(() => chips()[1]?.click());
	expect(container.querySelectorAll(".composer-dock-body")).toHaveLength(1);
	expect(container.querySelector(".todo-body")).toBeNull();
	expect(container.querySelector(".queue-body")).not.toBeNull();

	act(() => chips()[1]?.click());
	expect(container.querySelectorAll(".composer-dock-body")).toHaveLength(0);
});

it("隐藏的分区不渲染 chip；上限写入 --dock-max-height", () => {
	act(() => {
		root.render(
			<ComposerDock maxBodyHeight={180}>
				<DockSection id="todo" icon={<span />} label="TODO" hidden>
					<div className="todo-body" />
				</DockSection>
			</ComposerDock>,
		);
	});

	expect(container.querySelectorAll(".composer-dock-chip")).toHaveLength(0);
	expect(
		container
			.querySelector<HTMLElement>(".composer-dock")
			?.style.getPropertyValue("--dock-max-height"),
	).toBe("180px");
});

it("分区隐藏再出现时保持收起，不会带着旧展开态自己撑开", () => {
	const render = (hidden: boolean) => {
		act(() => {
			root.render(
				<ComposerDock maxBodyHeight={200}>
					<DockSection id="queue" icon={<span />} label="Queue" hidden={hidden}>
						<div className="queue-body" />
					</DockSection>
				</ComposerDock>,
			);
		});
	};

	render(false);
	act(() => container.querySelector<HTMLButtonElement>(".composer-dock-chip")?.click());
	expect(container.querySelector(".queue-body")).not.toBeNull();

	// 队列清空 → 分区消失；新消息入队后再出现时必须是收起的。
	render(true);
	expect(container.querySelectorAll(".composer-dock-chip")).toHaveLength(0);
	render(false);

	expect(container.querySelectorAll(".composer-dock-chip")).toHaveLength(1);
	expect(container.querySelector(".composer-dock-body")).toBeNull();
	expect(
		container.querySelector(".composer-dock-chip")?.getAttribute("aria-expanded"),
	).toBe("false");
});

it("Esc 收起展开块，且不再冒泡", () => {
	renderDock();
	act(() => container.querySelector<HTMLButtonElement>(".composer-dock-chip")?.click());
	expect(container.querySelector(".todo-body")).not.toBeNull();

	const bubbled = vi.fn();
	document.addEventListener("keydown", bubbled);
	const pressEscape = (target?: Element | null) => {
		const el = target ?? container.querySelector(".composer-dock-chip");
		if (!el) throw new Error("chip missing");
		act(() => {
			// React 合成事件监听在根容器上，必须从真实 DOM 元素冒泡上去。
			el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
	};

	pressEscape();
	expect(container.querySelector(".todo-body")).toBeNull();
	expect(bubbled).not.toHaveBeenCalled();

	// 没有展开块时 Esc 继续交给上层处理（如关闭抽屉）。
	pressEscape();
	expect(bubbled).toHaveBeenCalled();
	document.removeEventListener("keydown", bubbled);
});

it("展开块内输入框按 Esc 不收起分区（避免丢掉 steer 草稿）", () => {
	act(() => {
		root.render(
			<ComposerDock maxBodyHeight={200}>
				<DockSection id="subagents" icon={<span />} label="Subagents">
					<input className="steer" />
				</DockSection>
			</ComposerDock>,
		);
	});
	act(() => container.querySelector<HTMLButtonElement>(".composer-dock-chip")?.click());

	pressEscapeInput();
	expect(container.querySelector(".steer")).not.toBeNull();

	function pressEscapeInput() {
		act(() => {
			container.querySelector<HTMLInputElement>(".steer")?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
	}
});
