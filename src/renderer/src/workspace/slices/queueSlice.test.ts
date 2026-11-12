import { describe, expect, it } from "vitest";
import { createSessionWorkspaceStore } from "../sessionWorkspace";
import {
	queueActions,
	queueSlice,
} from "./queueSlice";

describe("queueSlice", () => {
	it("seed 返回共享空列表", () => {
		expect(queueSlice.seed("tab").uncertain).toBe(queueSlice.seed("project").uncertain);
		expect(queueSlice.seed("tab").uncertain).toHaveLength(0);
	});

	it("append 追加保序；dismiss 移除指定项", () => {
		let state = queueSlice.seed("tab");
		state = queueSlice.reduce(
			state,
			queueActions.append({ id: "a", text: "one", error: "unknown" }),
		);
		state = queueSlice.reduce(
			state,
			queueActions.append({ id: "b", text: "two", error: "unknown" }),
		);
		expect(state.uncertain.map((item) => item.id)).toEqual(["a", "b"]);

		state = queueSlice.reduce(state, queueActions.dismiss("a"));
		expect(state.uncertain.map((item) => item.id)).toEqual(["b"]);
	});

	it("未知 id 与外部动作返回原引用（不唤醒订阅者）", () => {
		const state = queueSlice.reduce(
			queueSlice.seed("tab"),
			queueActions.append({ id: "a", text: "one", error: "x" }),
		);
		expect(queueSlice.reduce(state, queueActions.dismiss("missing"))).toBe(state);
		expect(queueSlice.reduce(state, { type: "composer/setMode" })).toBe(state);
	});

	it("按条目隔离，且条目离场后未知提示随条目回收", () => {
		const store = createSessionWorkspaceStore();
		store.joinTab("agent-a");
		store.joinTab("agent-b");
		expect(
			store.dispatchTo("agent-a", queueActions.append({ id: "a1", text: "one", error: "x" })),
		).toBe(true);
		expect(store.getSlice("agent-a", "queue")?.uncertain).toHaveLength(1);
		expect(store.getSlice("agent-b", "queue")?.uncertain).toHaveLength(0);

		store.leave("agent-a");
		expect(store.getSlice("agent-a", "queue")).toBeUndefined();

		// 同名 id 不影响其他条目
		store.joinTab("agent-a");
		expect(store.getSlice("agent-a", "queue")?.uncertain).toHaveLength(0);
	});
});
