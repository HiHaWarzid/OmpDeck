import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspaceStore,
  focusKey,
  projectKey,
  type WorkspaceFocus,
} from "./sessionWorkspace";
import { composerActions } from "./slices/composerSlice";

describe("session workspace core", () => {
  const sessionA = "C:\\work\\project-a";
  const sessionB = "C:\\work\\project-b";

  it("joinTab seeds an entry with default slice state", () => {
    const store = createSessionWorkspaceStore();
    expect(store.joinTab(sessionA)).toBe(true);

    const snapshot = store.getSnapshot();
    expect(snapshot.entries.has(sessionA)).toBe(true);
    const entry = snapshot.entries.get(sessionA)!;
    expect(entry.kind).toBe("tab");
    expect(entry.data.composer).toEqual({ mode: "normal", busyDraft: false });
  });

  it("rejoining the same key is a no-op that never resets state", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.dispatchTo(sessionA, composerActions.setMode("plan"));

    expect(store.joinTab(sessionA)).toBe(false);
    expect(store.getSnapshot().entries.get(sessionA)!.data.composer.mode).toBe("plan");
  });

  it("entries are isolated per key", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.joinTab(sessionB);
    store.dispatchTo(sessionA, composerActions.setMode("plan"));
    store.dispatchTo(sessionA, composerActions.setBusyDraft(true));

    const b = store.getSnapshot().entries.get(sessionB)!.data.composer;
    expect(b).toEqual({ mode: "normal", busyDraft: false });
    const a = store.getSnapshot().entries.get(sessionA)!.data.composer;
    expect(a).toEqual({ mode: "plan", busyDraft: true });
  });

  it("leave removes the entry; rejoin reseeds fresh state", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.dispatchTo(sessionA, composerActions.setMode("plan"));

    expect(store.leave(sessionA)).toBe(true);
    expect(store.leave(sessionA)).toBe(false);
    expect(store.has(sessionA)).toBe(false);

    store.joinTab(sessionA);
    expect(store.getSnapshot().entries.get(sessionA)!.data.composer.mode).toBe("normal");
  });

  it("dispatch to an unknown key returns false and never throws", () => {
    const store = createSessionWorkspaceStore();
    expect(store.dispatchTo(sessionA, composerActions.setMode("plan"))).toBe(false);
    expect(store.dispatchActive(composerActions.setBusyDraft(true))).toBe(false);
  });

  it("activate requires an existing tab entry; project keys cannot be activated as tabs", () => {
    const store = createSessionWorkspaceStore();
    expect(store.activate(sessionA)).toBe(false);
    store.joinTab(sessionA);
    expect(store.activate(sessionA)).toBe(true);

    const focus: WorkspaceFocus = { kind: "tab", sessionKey: sessionA };
    expect(store.getSnapshot().focus).toEqual(focus);
  });

  it("leaving the focused entry clears the focus (no dangling frame)", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.activate(sessionA);
    expect(store.getSnapshot().focus).not.toBeNull();

    store.leave(sessionA);
    expect(store.getSnapshot().focus).toBeNull();
    expect(store.dispatchActive(composerActions.setBusyDraft(true))).toBe(false);
  });

  it("project entries: join/focus require project kind, keyed by project prefix", () => {
    const store = createSessionWorkspaceStore();
    const projectId = "proj-1";
    expect(store.focusProject(projectId)).toBe(false);
    expect(store.joinProject(projectId)).toBe(true);
    expect(store.joinProject(projectId)).toBe(false);
    // tab activate 不接受 project 键
    expect(store.activate(projectKey(projectId))).toBe(false);
    expect(store.focusProject(projectId)).toBe(true);
    expect(store.getSnapshot().focus).toEqual({ kind: "project", projectId });

    // 聚焦 project 后 dispatchActive 作用于 project 条目
    expect(store.dispatchActive(composerActions.setMode("plan"))).toBe(true);
    expect(
      store.getSnapshot().entries.get(projectKey(projectId))!.data.composer.mode,
    ).toBe("plan");
  });

  it("no-op dispatch keeps snapshot identity and wakes nobody", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.activate(sessionA);
    const listener = vi.fn();
    store.subscribe(listener);

    const before = store.getSnapshot();
    store.dispatchActive(composerActions.setBusyDraft(false)); // 已 false → 无变更
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before); // 引用不变
    expect(before.revision).toBe(store.getSnapshot().revision);
  });

  it("real change notifies once, bumps revision, and swaps snapshot identity", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.activate(sessionA);
    const listener = vi.fn();
    store.subscribe(listener);

    const before = store.getSnapshot();
    expect(store.dispatchActive(composerActions.setBusyDraft(true))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().revision).toBe(before.revision + 1);
  });

  it("unsubscribe stops notifications", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.activate(sessionA);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.dispatchActive(composerActions.setBusyDraft(true));
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispatchTo updates a background entry without touching the focus", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.joinTab(sessionB);
    store.activate(sessionA);

    store.dispatchTo(sessionB, composerActions.setBusyDraft(true));
    expect(store.getSnapshot().focus).toEqual({ kind: "tab", sessionKey: sessionA });
    expect(store.getSnapshot().entries.get(sessionB)!.data.composer.busyDraft).toBe(true);
    // 焦点条目不受影响
    expect(store.getSnapshot().entries.get(sessionA)!.data.composer.busyDraft).toBe(false);
  });

  it("snapshot reference is stable between mutations", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    expect(store.getSnapshot()).toBe(first);
  });

  it("unknown action types are ignored by all slices", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    const before = store.getSnapshot();
    store.dispatchTo(sessionA, { type: "nonexistent/verb" });
    expect(store.getSnapshot()).toBe(before);
  });

  it("focusKey resolves both focus kinds to entry keys", () => {
    expect(focusKey({ kind: "tab", sessionKey: sessionA })).toBe(sessionA);
    expect(focusKey({ kind: "project", projectId: "p" })).toBe(projectKey("p"));
  });
});
