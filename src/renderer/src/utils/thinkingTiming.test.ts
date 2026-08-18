import { describe, it, expect } from "vitest";
import { computeThinkingTiming } from "./thinkingTiming";
import type { ChatMessage } from "../../../shared/types/message";

/** 最小消息夹具：只有计时字段参与推导，其余字段与本函数无关 */
function msg(partial: Partial<Pick<ChatMessage, "thinkingStartedAt" | "thinkingEndedAt" | "timestamp">> = {}) {
  return partial;
}

describe("computeThinkingTiming startedAt 优先级链", () => {
  it("message.thinkingStartedAt 最优先，标记 source=message", () => {
    const timing = computeThinkingTiming(
      msg({ thinkingStartedAt: 1000, thinkingEndedAt: 2000, timestamp: 900 }),
      1500,
      500,
      9999,
    );
    expect(timing.startedAt).toBe(1000);
    expect(timing.source).toBe("message");
  });

  it("message 缺 thinkingStartedAt → 回退 streamingThinkingStartedAt", () => {
    const timing = computeThinkingTiming(
      msg({ timestamp: 900 }),
      1500,
      500,
      9999,
    );
    expect(timing.startedAt).toBe(1500);
    expect(timing.source).toBe("streaming");
  });

  it("message 与 streaming 都缺 → 回退 runStartedAt", () => {
    const timing = computeThinkingTiming(msg({ timestamp: 900 }), null, 500, 9999);
    expect(timing.startedAt).toBe(500);
    expect(timing.source).toBe("run");
  });

  it("全部缺失 → startedAt=null 且 source=none", () => {
    const timing = computeThinkingTiming(null, null, null, 9999);
    expect(timing.startedAt).toBeNull();
    expect(timing.source).toBe("none");
  });

  it("message 为 null 时可选参数缺省不抛错（null-safe）", () => {
    const timing = computeThinkingTiming(undefined, undefined, undefined, 9999);
    expect(timing).toEqual({ startedAt: null, endedAt: null, durationMs: null, source: "none" });
  });
});

describe("computeThinkingTiming endedAt 推导", () => {
  it("thinkingEndedAt 优先于 message.timestamp", () => {
    const timing = computeThinkingTiming(
      msg({ thinkingStartedAt: 1000, thinkingEndedAt: 3000, timestamp: 2500 }),
      null,
      null,
      9999,
    );
    expect(timing.endedAt).toBe(3000);
  });

  it("无 thinkingEndedAt → 回退 message.timestamp", () => {
    const timing = computeThinkingTiming(msg({ timestamp: 2500 }), null, null, 9999);
    expect(timing.endedAt).toBe(2500);
  });

  it("message 无结束信息 → endedAt=null（run.endedAt 兜底不在本函数签名内）", () => {
    const timing = computeThinkingTiming(msg({}), null, 500, 9999);
    expect(timing.endedAt).toBeNull();
  });
});

describe("computeThinkingTiming 耗时计算", () => {
  it("有合法 endedAt → durationMs = endedAt - startedAt", () => {
    const timing = computeThinkingTiming(
      msg({ thinkingStartedAt: 1000, thinkingEndedAt: 3500 }),
      null,
      null,
      9999,
    );
    expect(timing.durationMs).toBe(2500);
  });

  it("无 endedAt（流式进行中）→ 用 now 实时计时", () => {
    const timing = computeThinkingTiming(msg({ thinkingStartedAt: 1000 }), null, null, 4000);
    expect(timing.durationMs).toBe(3000);
  });

  it("无任何起点 → durationMs=null", () => {
    const timing = computeThinkingTiming(null, null, null, 9999);
    expect(timing.durationMs).toBeNull();
  });
});

describe("computeThinkingTiming 多段思考", () => {
  it("起点已刷新为最新一段：无 endedAt 时从新起点计时，而非首段起点", () => {
    // AgentManager 在第二段 thinking_delta 到达时刷新 thinkingStartedAt 并清
    // thinkingEndedAt（0539ac07）；消息上的起点就是最新一段的开始。
    const timing = computeThinkingTiming(
      msg({ thinkingStartedAt: 8000 }), // 第二段起点，第一段起点 1000
      null,
      1000,
      10000,
    );
    expect(timing.startedAt).toBe(8000);
    expect(timing.durationMs).toBe(2000);
  });

  it("残留 endedAt 早于新起点 → 视为流式进行中，按 now 计时", () => {
    // 上一段结束标记未清除（endedAt < startedAt）时，ThinkingBlock 停表条件
    // 判定仍为实时计时，时长不得出现负数。
    const timing = computeThinkingTiming(
      msg({ thinkingStartedAt: 8000, thinkingEndedAt: 6000 }),
      null,
      null,
      9000,
    );
    expect(timing.endedAt).toBe(6000);
    expect(timing.durationMs).toBe(1000); // 9000 - 8000，而非 6000 - 8000
  });
});