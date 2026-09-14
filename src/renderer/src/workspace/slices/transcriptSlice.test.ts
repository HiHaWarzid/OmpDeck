import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../../shared/types";
import type { WorkspaceAction } from "../sessionWorkspace";
import { transcriptActions, transcriptSlice } from "./transcriptSlice";

function message(id: string, text = id): ChatMessage {
  return { id, agentId: "a1", role: "assistant", text, timestamp: 0 };
}

const seeded = transcriptSlice.seed("tab");

describe("transcript slice", () => {
  it("seed 是空态：无消息、代数 0、未加载", () => {
    expect(seeded.messages).toEqual([]);
    expect(seeded.seq).toBe(0);
    expect(seeded.loaded).toBe(false);
    expect(seeded.needsFullPull).toBe(false);
  });

  it("落存消息并把条目标记为已加载（loaded 与消息内容无关）", () => {
    const empty = transcriptSlice.reduce(seeded, transcriptActions.setMessages([]));
    expect(empty.loaded).toBe(true);
    expect(empty.messages).toEqual([]);
  });

  it("重复投递同一动作 → 原引用（不唤醒订阅者）", () => {
    const action = transcriptActions.setMessages([message("m1")], 3, true);
    const once = transcriptSlice.reduce(seeded, action);
    expect(transcriptSlice.reduce(once, action)).toBe(once);
  });

  it("同消息但代数前进 → 新状态（自愈拉取据此判定结果作废）", () => {
    const once = transcriptSlice.reduce(seeded, transcriptActions.setMessages([message("m1")], 3, true));
    const next = transcriptSlice.reduce(once, transcriptActions.setMessages([message("m1")], 4, true));
    expect(next).not.toBe(once);
    expect(next.seq).toBe(4);
  });

  it("缺省 seq 沿用当前代数（全量拉取落地不推进代数）", () => {
    const streamed = transcriptSlice.reduce(seeded, transcriptActions.setMessages([message("m1")], 7, true));
    const replaced = transcriptSlice.reduce(streamed, transcriptActions.setMessages([message("m2")]));
    expect(replaced.seq).toBe(7);
    // 缺省 needsFullPull = false：基线落地即清除自愈标记
    expect(replaced.needsFullPull).toBe(false);
  });

  it("忽略其他切片的动作（原引用）", () => {
    const foreign = { type: "composer/setMode", mode: "plan" } as WorkspaceAction;
    expect(transcriptSlice.reduce(seeded, foreign)).toBe(seeded);
  });
});
