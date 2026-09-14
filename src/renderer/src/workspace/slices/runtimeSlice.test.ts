import { describe, expect, it } from "vitest";
import type { WorkspaceAction } from "../sessionWorkspace";
import { runtimeActions, runtimeSlice } from "./runtimeSlice";

describe("runtime slice", () => {
  it("seed 无快照（undefined），不再是 record 里的缺键", () => {
    expect(runtimeSlice.seed("tab")).toBeUndefined();
  });

  it("落存快照", () => {
    const state = { modelId: "m1" };
    expect(runtimeSlice.reduce(undefined, runtimeActions.set(state))).toBe(state);
  });

  it("同引用写入 → 原引用（批次 0 的 same-ref 语义：同值合并不唤醒订阅者）", () => {
    const state = { modelId: "m1" };
    const once = runtimeSlice.reduce(undefined, runtimeActions.set(state));
    expect(runtimeSlice.reduce(once, runtimeActions.set(state))).toBe(once);
  });

  it("新引用写入 → 替换", () => {
    const first = { modelId: "m1" };
    const second = { modelId: "m2" };
    const once = runtimeSlice.reduce(undefined, runtimeActions.set(first));
    expect(runtimeSlice.reduce(once, runtimeActions.set(second))).toBe(second);
  });

  it("忽略其他切片的动作（原引用）", () => {
    const state = { modelId: "m1" };
    const foreign = { type: "composer/setMode", mode: "plan" } as WorkspaceAction;
    expect(runtimeSlice.reduce(state, foreign)).toBe(state);
  });
});
