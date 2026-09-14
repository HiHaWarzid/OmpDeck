import { describe, expect, it } from "vitest";
import type { WorkspaceAction } from "../sessionWorkspace";
import { createSessionWorkspaceStore } from "../sessionWorkspace";
import {
	extensionWidgetActions,
	extensionWidgetsSlice,
	type ExtensionWidgetState,
} from "./extensionWidgetsSlice";

/**
 * extensionWidgets 切片契约（批次 5d）。
 *
 * 迁移动机有两条，都要在此冻结：
 * 1. 写路径不再整表落根 state——「空数组 = 撤下 widget」与「同引用空转」的语义不能漂移；
 * 2. 裁剪：agent 离场（条目 leave）即整表回收。原实现里 agent 关闭后键永不裁剪，
 *    长会话累积泄漏；现在裁剪靠条目生命周期，所以断言必须走真实 store 的 leave。
 */

describe("extensionWidgets 切片", () => {
	it("seed 空表（共享冻结空值）", () => {
		expect(extensionWidgetsSlice.seed("tab")).toEqual({});
	});

	it("落存 widget 行", () => {
		const lines = ["one", "two"];
		const next = extensionWidgetsSlice.reduce(
			{},
			extensionWidgetActions.set("pi-deck-todo", lines),
		);
		expect(next).toEqual({ "pi-deck-todo": lines });
	});

	it("同引用写入 → 原引用（不唤醒订阅者）", () => {
		const lines = ["one"];
		const once = extensionWidgetsSlice.reduce(
			{},
			extensionWidgetActions.set("pi-deck-todo", lines),
		);
		expect(extensionWidgetsSlice.reduce(once, extensionWidgetActions.set("pi-deck-todo", lines))).toBe(once);
	});

	it("空数组 = 撤下该 widget（等价原实现的 delete）", () => {
		const withTodo = extensionWidgetsSlice.reduce(
			{},
			extensionWidgetActions.set("pi-deck-todo", ["a"]),
		);
		expect(extensionWidgetsSlice.reduce(withTodo, extensionWidgetActions.set("pi-deck-todo", []))).toEqual({});
	});

	it("撤下不存在的 widget → 原引用（空转）", () => {
		const state = { other: ["a"] };
		expect(extensionWidgetsSlice.reduce(state, extensionWidgetActions.set("pi-deck-todo", []))).toBe(state);
	});

	it("忽略其他切片的动作（原引用）", () => {
		const state = { other: ["a"] };
		const foreign = { type: "runtime/set" } as WorkspaceAction;
		expect(extensionWidgetsSlice.reduce(state, foreign)).toBe(state);
	});
});

describe("extensionWidgets 随条目离场裁剪", () => {
	it("agent 条目 leave 后 widget 表整块回收", () => {
		const store = createSessionWorkspaceStore();
		store.joinTab("agent-1");
		store.dispatchTo("agent-1", extensionWidgetActions.set("pi-deck-todo", ["a"]));
		expect(store.getSlice("agent-1", "extensionWidgets")).toEqual({ "pi-deck-todo": ["a"] });

		store.leave("agent-1");
		expect(store.getSlice("agent-1", "extensionWidgets")).toBeUndefined();
		expect(store.has("agent-1")).toBe(false);
	});

	it("只影响离场条目，其余 agent 的 widget 保留", () => {
		const store = createSessionWorkspaceStore();
		store.joinTab("agent-1");
		store.joinTab("agent-2");
		store.dispatchTo("agent-1", extensionWidgetActions.set("pi-deck-todo", ["a"]));
		store.dispatchTo("agent-2", extensionWidgetActions.set("pi-deck-todo", ["b"]));

		store.leave("agent-1");
		expect(store.getSlice("agent-2", "extensionWidgets")).toEqual({ "pi-deck-todo": ["b"] });
	});

	it("订阅者只在自身切片变化时被唤醒，离场也通知一次（读到 undefined）", () => {
		const store = createSessionWorkspaceStore();
		store.joinTab("agent-1");
		const seen: Array<ExtensionWidgetState | undefined> = [];
		const unsubscribe = store.subscribeSlice("agent-1", "extensionWidgets", () => {
			seen.push(store.getSlice("agent-1", "extensionWidgets"));
		});

		store.dispatchTo("agent-1", extensionWidgetActions.set("pi-deck-todo", ["a"]));
		expect(seen).toEqual([{ "pi-deck-todo": ["a"] }]);

		// 与 widget 无关的切片动作不该唤醒该订阅
		store.dispatchTo("agent-1", { type: "runtime/set" });
		expect(seen).toHaveLength(1);

		store.leave("agent-1");
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBeUndefined();
		unsubscribe();
	});
});
