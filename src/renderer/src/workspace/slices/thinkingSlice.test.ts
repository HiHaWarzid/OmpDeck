import { describe, expect, it } from "vitest";
import type { WorkspaceAction } from "../sessionWorkspace";
import { thinkingActions, thinkingSlice } from "./thinkingSlice";

const empty = thinkingSlice.seed("tab");

describe("thinking slice", () => {
  it("same text keeps the same reference (20Hz throttle guard)", () => {
    const once = thinkingSlice.reduce(empty, thinkingActions.update("same", 10));
    const again = thinkingSlice.reduce(once, thinkingActions.update("same", 20));
    expect(again).toBe(once);
    expect(again.startedAt).toBe(10);
  });

  it("new text updates and records startedAt on first non-empty", () => {
    const next = thinkingSlice.reduce(empty, thinkingActions.update("hello", 500));
    expect(next.text).toBe("hello");
    expect(next.startedAt).toBe(500);
  });

  it("keeps the first startedAt across later non-empty updates", () => {
    const first = thinkingSlice.reduce(empty, thinkingActions.update("hello", 500));
    const second = thinkingSlice.reduce(first, thinkingActions.update("hello world", 900));
    expect(second.text).toBe("hello world");
    expect(second.startedAt).toBe(500);
  });

  it("clearing text empties it and removes startedAt", () => {
    const current = thinkingSlice.reduce(empty, thinkingActions.update("hello", 500));
    const cleared = thinkingSlice.reduce(current, thinkingActions.update("", 700));
    expect(cleared.text).toBe("");
    expect(cleared.startedAt).toBeUndefined();
  });

  it("empty update on a fresh entry records empty text, no startedAt", () => {
    const next = thinkingSlice.reduce(empty, thinkingActions.update("", 100));
    expect(next.text).toBe("");
    expect(next.startedAt).toBeUndefined();
  });

  it("ignores foreign actions (same reference)", () => {
    const foreign = { type: "composer/setMode", mode: "plan" } as WorkspaceAction;
    expect(thinkingSlice.reduce(empty, foreign)).toBe(empty);
  });
});
