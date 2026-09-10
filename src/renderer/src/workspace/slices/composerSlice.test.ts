import { describe, expect, it } from "vitest";
import type { WorkspaceAction } from "../sessionWorkspace";
import { composerActions, composerSlice } from "./composerSlice";

const empty = composerSlice.seed("tab");

describe("composer slice", () => {
	it("seeds normal mode with no busy draft", () => {
		expect(empty).toEqual({ mode: "normal", busyDraft: false });
	});

	it("setMode swaps mode and ignores same-mode dispatch (no subscriber wake)", () => {
		const plan = composerSlice.reduce(empty, composerActions.setMode("plan"));
		expect(plan).toEqual({ mode: "plan", busyDraft: false });
		expect(composerSlice.reduce(plan, composerActions.setMode("plan"))).toBe(plan);
	});

	it("setBusyDraft latches and releases", () => {
		const latched = composerSlice.reduce(empty, composerActions.setBusyDraft(true));
		expect(latched.busyDraft).toBe(true);
		const released = composerSlice.reduce(latched, composerActions.setBusyDraft(false));
		expect(released.busyDraft).toBe(false);
		// 已 false 再清一次：空转，原引用
		expect(composerSlice.reduce(released, composerActions.setBusyDraft(false))).toBe(released);
	});

	it("mode and busyDraft evolve independently", () => {
		const plan = composerSlice.reduce(empty, composerActions.setMode("plan"));
		const latched = composerSlice.reduce(plan, composerActions.setBusyDraft(true));
		expect(latched).toEqual({ mode: "plan", busyDraft: true });
	});

	it("ignores foreign actions (same reference)", () => {
		const foreign = { type: "thinking/update", text: "x", now: 1 } as WorkspaceAction;
		expect(composerSlice.reduce(empty, foreign)).toBe(empty);
	});
});
