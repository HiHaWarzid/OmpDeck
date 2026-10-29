// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setI18nLocale } from "../../../i18n";
import type { AgentTodoPhase } from "../../../../../shared/types";
import { NativeTodoPanel } from "./NativeTodoPanel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	setI18nLocale("zh-CN");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const phases: AgentTodoPhase[] = [
	{
		name: "实现",
		tasks: [
			{ content: "写测试", status: "pending" },
			{ content: "等 review", status: "blocked", blocker: "等 #42" },
			{ content: "收尾", status: "completed" },
		],
	},
];

it("渲染原生 todo 的阶段与任务行", () => {
	act(() => {
		root.render(<NativeTodoPanel phases={phases} onSetTodos={() => undefined} />);
	});

	expect(container.querySelector(".native-todo-phase-name")?.textContent).toBe("实现");
	const items = Array.from(container.querySelectorAll(".native-todo-item"));
	expect(items.map((item) => item.textContent)).toEqual([
		"写测试待处理",
		"等 review阻塞",
		"收尾已完成",
	]);
});

it("点击任务推进状态；离开 blocked 时清掉 blocker", () => {
	const calls: AgentTodoPhase[][] = [];
	act(() => {
		root.render(
			<NativeTodoPanel phases={phases} onSetTodos={(next) => calls.push(next)} />,
		);
	});

	const items = container.querySelectorAll<HTMLButtonElement>(".native-todo-item");
	act(() => items[0]?.click());
	act(() => items[1]?.click());

	expect(calls[0]?.[0]?.tasks[0]).toMatchObject({
		content: "写测试",
		status: "in_progress",
	});
	expect(calls[1]?.[0]?.tasks[1]).toMatchObject({ content: "等 review", status: "pending" });
	expect(calls[1]?.[0]?.tasks[1]?.blocker).toBeUndefined();
});

it("busy 或 disabled 时禁止再改 todo", () => {
	act(() => {
		root.render(
			<NativeTodoPanel phases={phases} disabled busy onSetTodos={() => undefined} />,
		);
	});

	const items = Array.from(container.querySelectorAll<HTMLButtonElement>(".native-todo-item"));
	expect(items.every((item) => item.disabled)).toBe(true);
	expect(container.querySelector(".native-todo-round-hint")?.textContent).toBe("保存中…");
});

it("上一轮全部完成时标注来源，避免被当成本轮计划", () => {
	const allDone: AgentTodoPhase[] = [
		{ name: "审计", tasks: [{ content: "聚合日志", status: "completed" }] },
	];
	act(() => {
		root.render(<NativeTodoPanel phases={allDone} onSetTodos={() => undefined} />);
	});

	expect(container.querySelector(".native-todo-round-hint")?.textContent).toContain(
		"上一轮待办已全部完成",
	);
});

it("空阶段被过滤后，点击仍写回正确的阶段", () => {
	const withEmptyPhase: AgentTodoPhase[] = [
		{ name: "空", tasks: [] },
		{ name: "实现", tasks: [{ content: "写测试", status: "pending" }] },
	];
	const calls: AgentTodoPhase[][] = [];
	act(() => {
		root.render(
			<NativeTodoPanel phases={withEmptyPhase} onSetTodos={(next) => calls.push(next)} />,
		);
	});

	act(() => container.querySelector<HTMLButtonElement>(".native-todo-item")?.click());

	expect(calls[0]?.[0]?.tasks).toHaveLength(0);
	expect(calls[0]?.[1]?.tasks[0]).toMatchObject({ content: "写测试", status: "in_progress" });
});
