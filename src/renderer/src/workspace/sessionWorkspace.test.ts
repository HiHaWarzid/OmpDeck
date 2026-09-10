import { describe, expect, it, vi } from "vitest";
import {
  createSessionWorkspaceStore,
  focusKey,
  projectKey,
  type WorkspaceFocus,
} from "./sessionWorkspace";
import { composerActions } from "./slices/composerSlice";
import { thinkingActions } from "./slices/thinkingSlice";

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
    // 快照只带结构；切片状态一律经 getSlice 读取
    expect(store.getSlice(sessionA, "composer")).toEqual({ mode: "normal", busyDraft: false });
  });

  it("rejoining the same key is a no-op that never resets state", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.dispatchTo(sessionA, composerActions.setMode("plan"));

    expect(store.joinTab(sessionA)).toBe(false);
    expect(store.getSlice(sessionA, "composer")?.mode).toBe("plan");
  });

  it("entries are isolated per key", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.joinTab(sessionB);
    store.dispatchTo(sessionA, composerActions.setMode("plan"));
    store.dispatchTo(sessionA, composerActions.setBusyDraft(true));

    const b = store.getSlice(sessionB, "composer");
    expect(b).toEqual({ mode: "normal", busyDraft: false });
    const a = store.getSlice(sessionA, "composer");
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
    expect(store.getSlice(sessionA, "composer")?.mode).toBe("normal");
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
      store.getSlice(projectKey(projectId), "composer")?.mode,
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

  it("real slice change wakes its slice subscriber without touching the structural snapshot", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.activate(sessionA);
    const structural = vi.fn();
    const composer = vi.fn();
    store.subscribe(structural);
    store.subscribeSlice(sessionA, "composer", composer);

    const before = store.getSnapshot();
    expect(store.dispatchActive(composerActions.setBusyDraft(true))).toBe(true);
    expect(composer).toHaveBeenCalledTimes(1);
    // 切片变化不动结构：快照引用与 revision 都不变，结构订阅者不醒
    expect(structural).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    expect(store.getSlice(sessionA, "composer")?.busyDraft).toBe(true);
  });

  it("unsubscribe stops notifications", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.activate(sessionA);
    const listener = vi.fn();
    const unsubscribe = store.subscribeSlice(sessionA, "composer", listener);

    unsubscribe();
    store.dispatchActive(composerActions.setBusyDraft(true));
    expect(listener).not.toHaveBeenCalled();

    // 取消后再订阅仍然生效（空桶被清理，不残留脏状态）
    store.subscribeSlice(sessionA, "composer", listener);
    store.dispatchActive(composerActions.setBusyDraft(false));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("dispatchTo updates a background entry without touching the focus", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.joinTab(sessionB);
    store.activate(sessionA);

    store.dispatchTo(sessionB, composerActions.setBusyDraft(true));
    expect(store.getSnapshot().focus).toEqual({ kind: "tab", sessionKey: sessionA });
    expect(store.getSlice(sessionB, "composer")?.busyDraft).toBe(true);
    // 焦点条目不受影响
    expect(store.getSlice(sessionA, "composer")?.busyDraft).toBe(false);
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

  // ── 订阅粒度：结构 vs 切片 ─────────────────────────────

  it("slice dispatch wakes only that slice's subscriber, never structural subscribers", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    const structural = vi.fn();
    const composer = vi.fn();
    const thinking = vi.fn();
    store.subscribe(structural);
    store.subscribeSlice(sessionA, "composer", composer);
    store.subscribeSlice(sessionA, "thinking", thinking);

    store.dispatchTo(sessionA, composerActions.setMode("plan"));

    expect(composer).toHaveBeenCalledTimes(1);
    expect(thinking).not.toHaveBeenCalled();
    // 热路径不得唤醒根组件：结构订阅与快照引用都不动
    expect(structural).not.toHaveBeenCalled();
  });

  it("a hot slice update keeps the snapshot reference stable (root does not re-render)", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.activate(sessionA);
    const snapshotBefore = store.getSnapshot();

    for (let i = 0; i < 50; i += 1) {
      store.dispatchTo(sessionA, thinkingActions.update(`t${i}`, i));
    }

    expect(store.getSnapshot()).toBe(snapshotBefore);
    expect(store.getSlice(sessionA, "thinking")?.text).toBe("t49");
  });

  it("slice subscribers are isolated per key", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.joinTab(sessionB);
    const a = vi.fn();
    const b = vi.fn();
    store.subscribeSlice(sessionA, "thinking", a);
    store.subscribeSlice(sessionB, "thinking", b);

    store.dispatchTo(sessionA, thinkingActions.update("only-a", 1));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(store.getSlice(sessionB, "thinking")?.text).toBe("");
  });

  it("leaving an entry wakes its slice subscribers so they can fall back to defaults", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    const thinking = vi.fn();
    store.subscribeSlice(sessionA, "thinking", thinking);

    store.leave(sessionA);

    expect(thinking).toHaveBeenCalledTimes(1);
    expect(store.getSlice(sessionA, "thinking")).toBeUndefined();
  });

  it("structural changes (join / focus / leave) wake structural subscribers", () => {
    const store = createSessionWorkspaceStore();
    const structural = vi.fn();
    store.subscribe(structural);

    store.joinTab(sessionA);
    store.activate(sessionA);
    store.leave(sessionA);

    expect(structural).toHaveBeenCalledTimes(3);
  });

  it("unsubscribing a slice listener stops notifications and drops the empty bucket", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    const thinking = vi.fn();
    const unsubscribe = store.subscribeSlice(sessionA, "thinking", thinking);

    unsubscribe();
    store.dispatchTo(sessionA, thinkingActions.update("after", 1));

    expect(thinking).not.toHaveBeenCalled();
    // 取消订阅后再次订阅仍然生效（桶被清理过，不能残留脏状态）
    store.subscribeSlice(sessionA, "thinking", thinking);
    store.dispatchTo(sessionA, thinkingActions.update("again", 2));
    expect(thinking).toHaveBeenCalledTimes(1);
  });

  it("getSlice returns the seeded defaults for a fresh entry", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    expect(store.getSlice(sessionA, "composer")).toMatchObject({ mode: "normal", busyDraft: false });
    expect(store.getSlice(sessionA, "thinking")).toMatchObject({ text: "" });
  });

  it("closing a tab disposes its slice state with the entry (no App-side prune needed)", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.dispatchTo(sessionA, composerActions.setBusyDraft(true));
    store.dispatchTo(sessionA, thinkingActions.update("streaming", 1_000));
    expect(store.getSlice(sessionA, "thinking")?.text).toBe("streaming");

    store.leave(sessionA);
    expect(store.getSlice(sessionA, "thinking")).toBeUndefined();
    expect(store.getSlice(sessionA, "composer")).toBeUndefined();

    // 重新打开同一会话：切片状态必须从零开始，不能继承上一轮的值
    store.joinTab(sessionA);
    expect(store.getSlice(sessionA, "thinking")).toMatchObject({ text: "" });
    expect(store.getSlice(sessionA, "composer")).toMatchObject({ busyDraft: false });
  });

  it("dispatchActive with no focus returns false and wakes nothing", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    const structural = vi.fn();
    const composer = vi.fn();
    store.subscribe(structural);
    store.subscribeSlice(sessionA, "composer", composer);

    expect(store.dispatchActive(composerActions.setMode("plan"))).toBe(false);
    expect(structural).not.toHaveBeenCalled();
    expect(composer).not.toHaveBeenCalled();
    expect(store.getSlice(sessionA, "composer")?.mode).toBe("normal");
  });

  it("dispatchTo a removed entry returns false; rejoin starts from seed", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(sessionA);
    store.dispatchTo(sessionA, composerActions.setMode("plan"));
    store.leave(sessionA);

    expect(store.dispatchTo(sessionA, composerActions.setMode("plan"))).toBe(false);
    expect(store.joinTab(sessionA)).toBe(true);
    expect(store.getSlice(sessionA, "composer")?.mode).toBe("normal");
  });

  it("leave on an unknown key returns false and wakes nobody", () => {
    const store = createSessionWorkspaceStore();
    const structural = vi.fn();
    store.subscribe(structural);
    expect(store.leave("missing")).toBe(false);
    expect(structural).not.toHaveBeenCalled();
  });

  it("focusProject on a joined-but-not-focused project still reports focus", () => {
    const store = createSessionWorkspaceStore();
    store.joinProject("proj-1");
    expect(store.focusProject("proj-1")).toBe(true);
    // 同一 project 再次 focus：幂等，不重复唤醒结构订阅者
    const structural = vi.fn();
    store.subscribe(structural);
    expect(store.focusProject("proj-1")).toBe(true);
    expect(structural).not.toHaveBeenCalled();
  });

  it("clearFocus with no focus is a no-op", () => {
    const store = createSessionWorkspaceStore();
    const structural = vi.fn();
    store.subscribe(structural);
    store.clearFocus();
    expect(structural).not.toHaveBeenCalled();
  });

  it("project entries seed slices like tab entries", () => {
    const store = createSessionWorkspaceStore();
    store.joinProject("proj-1");
    expect(store.getSlice(projectKey("proj-1"), "composer")).toMatchObject({
      mode: "normal",
    });
    expect(store.getSlice(projectKey("proj-1"), "thinking")).toMatchObject({ text: "" });
  });
});
