import { describe, expect, it } from "vitest";
import { rpcLogActions, rpcLogSlice } from "./rpcLogSlice";
import type { WorkspaceAction } from "../sessionWorkspace";

const empty = rpcLogSlice.seed("tab");

describe("rpcLog slice", () => {
	it("seeds off", () => {
		expect(empty).toEqual({ enabled: false });
	});

	it("set flips the flag", () => {
		const on = rpcLogSlice.reduce(empty, rpcLogActions.set(true));
		expect(on.enabled).toBe(true);
		expect(rpcLogSlice.reduce(on, rpcLogActions.set(false)).enabled).toBe(false);
	});

	it("same value is a no-op so subscribers are not woken (each menu open re-seeds from main)", () => {
		const on = rpcLogSlice.reduce(empty, rpcLogActions.set(true));
		// 打开右键菜单会先向主进程查一次当前开关：同值不得触发订阅者重渲染
		expect(rpcLogSlice.reduce(on, rpcLogActions.set(true))).toBe(on);
		expect(rpcLogSlice.reduce(empty, rpcLogActions.set(false))).toBe(empty);
	});

	it("foreign actions are ignored", () => {
		const foreign = { type: "composer/setMode", mode: "plan" } as WorkspaceAction;
		expect(rpcLogSlice.reduce(empty, foreign)).toBe(empty);
	});
});
