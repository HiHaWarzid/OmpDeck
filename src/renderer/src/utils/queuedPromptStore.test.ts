import { describe, expect, it } from "vitest";
import type { QueuedPromptSnapshot } from "./queuedPromptQueue";
import { createQueuedPromptStore } from "./queuedPromptStore";

function makePrompt(id: string, overrides: Partial<QueuedPromptSnapshot> = {}): QueuedPromptSnapshot {
  return {
    id,
    message: `message-${id}`,
    displayText: `display-${id}`,
    behavior: "steer",
    agentMode: "normal",
    timestamp: 1,
    status: "pending",
    ...overrides,
  };
}

describe("createQueuedPromptStore", () => {
  it("claim 原子性：同一 pending 快照只能被 claim 一次，后续 claim 被拒绝", () => {
    const updates: unknown[] = [];
    const store = createQueuedPromptStore(
      { a: [makePrompt("p1"), makePrompt("p2")] },
      (next) => updates.push(next),
    );

    const first = store.claim("a", "p1");
    expect(first.claimed).toBe(true);
    expect(first.prompt?.id).toBe("p1");
    expect(store.state.a[0].status).toBe("sending");

    const second = store.claim("a", "p1");
    expect(second.claimed).toBe(false);
    expect(second.prompt).toBeUndefined();

    // 第二次 claim 被门禁拒绝，不触发任何更新
    expect(updates).toHaveLength(1);
  });

  it("claim 拒绝非 pending 快照（failed/unknown 不可再 claim）", () => {
    const store = createQueuedPromptStore(
      { a: [makePrompt("f", { status: "failed" }), makePrompt("u", { status: "unknown" })] },
      () => {},
    );

    expect(store.claim("a", "f").claimed).toBe(false);
    expect(store.claim("a", "u").claimed).toBe(false);
    expect(store.claim("a", "missing").claimed).toBe(false);
  });

  it("claimIdleHead：原子 claim 队首 pending", () => {
    const store = createQueuedPromptStore(
      { a: [makePrompt("head"), makePrompt("tail")] },
      () => {},
    );

    const result = store.claimIdleHead("a");
    expect(result.claimed).toBe(true);
    expect(result.prompt?.id).toBe("head");
    expect(store.state.a[0].status).toBe("sending");
    expect(store.state.a[1].status).toBe("pending");
  });

  it("claimIdleHead：失败/未知队首是发送屏障，阻止越过它 claim 后续 pending", () => {
    const store = createQueuedPromptStore(
      { a: [makePrompt("barrier", { status: "failed" }), makePrompt("next")] },
      () => {},
    );
    expect(store.claimIdleHead("a").claimed).toBe(false);
    expect(store.state.a[1].status).toBe("pending");
  });

  it("claimIdleHead：空队列不 claim 且不通知", () => {
    const store = createQueuedPromptStore({}, () => {});
    expect(store.claimIdleHead("a").claimed).toBe(false);
  });

  it("claimNextSteer：跳过 pending followUp，原子 claim 第一个 pending steer", () => {
    const store = createQueuedPromptStore(
      {
        a: [
          makePrompt("fu1", { behavior: "followUp" }),
          makePrompt("st1"),
          makePrompt("st2"),
        ],
      },
      () => {},
    );

    const result = store.claimNextSteer("a");
    expect(result.claimed).toBe(true);
    expect(result.prompt?.id).toBe("st1");
    expect(store.state.a[1].status).toBe("sending");
  });

  it("claimNextSteer：sending/failed/unknown 前驱是排序屏障", () => {
    for (const status of ["sending", "failed", "unknown"] as const) {
      const store = createQueuedPromptStore(
        { a: [makePrompt("barrier", { status }), makePrompt("st")] },
        () => {},
      );
      expect(store.claimNextSteer("a").claimed).toBe(false);
    }
  });

  it("claimNextSteer：无 steer 时返回未 claim", () => {
    const store = createQueuedPromptStore(
      { a: [makePrompt("fu", { behavior: "followUp" })] },
      () => {},
    );
    expect(store.claimNextSteer("a").claimed).toBe(false);
  });

  it("retract：pending/failed 可撤回；sending/unknown 被门禁拒绝", () => {
    const updates: unknown[] = [];
    const store = createQueuedPromptStore(
      {
        a: [makePrompt("pending"), makePrompt("failed", { status: "failed" })],
        b: [makePrompt("sending", { status: "sending" }), makePrompt("unknown", { status: "unknown" })],
      },
      (next) => updates.push(next),
    );

    store.retract("a", "pending");
    expect(store.state.a?.map((p) => p.id)).toEqual(["failed"]);

    store.retract("a", "failed");
    expect(store.state.a).toBeUndefined();

    // 门禁违反：sending/unknown 拒绝，状态与通知数均不变
    const before = JSON.stringify(store.state);
    store.retract("b", "sending");
    store.retract("b", "unknown");
    expect(JSON.stringify(store.state)).toBe(before);
    expect(updates).toHaveLength(2);
  });

  it("discard：sending 拒绝；pending/failed 移除；unknown 仅清提示（移除快照）", () => {
    const updates: unknown[] = [];
    const store = createQueuedPromptStore(
      {
        a: [makePrompt("pending"), makePrompt("failed", { status: "failed" }), makePrompt("unknown", { status: "unknown" })],
        b: [makePrompt("sending", { status: "sending" })],
      },
      (next) => updates.push(next),
    );

    store.discard("a", "pending");
    store.discard("a", "failed");
    store.discard("a", "unknown");
    expect(store.state.a).toBeUndefined();

    const before = JSON.stringify(store.state);
    store.discard("b", "sending");
    expect(JSON.stringify(store.state)).toBe(before);
    expect(updates).toHaveLength(3);
  });

  it("resolve：accepted 移除 sending；failed/unknown 落状态与错误；非 sending 忽略", () => {
    const updates: unknown[] = [];
    const store = createQueuedPromptStore(
      {
        a: [makePrompt("ok"), makePrompt("bad"), makePrompt("unk")],
        b: [makePrompt("done", { status: "failed" })],
      },
      (next) => updates.push(next),
    );

    expect(store.claim("a", "ok").claimed).toBe(true);
    expect(store.claim("a", "bad").claimed).toBe(true);
    expect(store.claim("a", "unk").claimed).toBe(true);
    expect(updates).toHaveLength(3);

    store.resolve("a", "ok", { type: "accepted" });
    store.resolve("a", "bad", { type: "failed", error: "boom" });
    store.resolve("a", "unk", { type: "unknown", error: "timeout" });
    expect(updates).toHaveLength(6);

    const a = store.state.a;
    expect(a?.map((p) => p.id)).toEqual(["bad", "unk"]);
    expect(a?.[0].status).toBe("failed");
    expect(a?.[0].error).toBe("boom");
    expect(a?.[1].status).toBe("unknown");
    expect(a?.[1].error).toBe("timeout");

    // 非 sending（已结算的 failed）resolve 被门禁忽略，不通知
    store.resolve("b", "done", { type: "accepted" });
    expect(updates).toHaveLength(6);
  });

  it("migrate：sending/unknown 必然被丢弃，只迁移 pending/failed——历史重复发送 bug 的形状断言", () => {
    const original = {
      a: [
        makePrompt("pending"),
        makePrompt("failed", { status: "failed" }),
        makePrompt("sending", { status: "sending" }),
        makePrompt("unknown", { status: "unknown" }),
      ],
      // 无 replacement 的 agent 整体保留原样（含 sending/unknown——仍在原进程语义内）
      b: [makePrompt("b-pending"), makePrompt("b-sending", { status: "sending" })],
    };
    const store = createQueuedPromptStore(original, () => {});

    store.migrate(new Map([["a", "a2"]]), new Set(["a2", "b"]));

    // 被替换的 agent：只迁移 pending/failed 到 replacement key，sending/unknown 一个不剩
    expect(store.state.a).toBeUndefined();
    expect(store.state.a2?.map((p) => p.id)).toEqual(["pending", "failed"]);
    for (const p of store.state.a2 ?? []) {
      expect(["pending", "failed"]).toContain(p.status);
      expect(p.status).not.toBe("sending");
      expect(p.status).not.toBe("unknown");
    }
    // 未被替换的 agent 原样保留
    expect(store.state.b?.map((p) => p.id)).toEqual(["b-pending", "b-sending"]);
  });

  it("migrate：replacement 或原 agent 不在存活集合时整体丢弃（不复制到死会话）", () => {
    const store = createQueuedPromptStore(
      { a: [makePrompt("ok")], b: [makePrompt("alive")] },
      () => {},
    );

    store.migrate(new Map([["a", "ghost"]]), new Set(["b"]));
    expect(store.state.a).toBeUndefined();
    expect(store.state.ghost).toBeUndefined();
    expect(store.state.b?.map((p) => p.id)).toEqual(["alive"]);
  });

  it("migrate：输入本就一致时（自映射且全存活）不触发 onUpdate", () => {
    let calls = 0;
    const store = createQueuedPromptStore(
      { a: [makePrompt("ok", { status: "failed" })] },
      () => {
        calls += 1;
      },
    );

    store.migrate(new Map([["a", "a"]]), new Set(["a"]));
    expect(calls).toBe(0);
    expect(store.state.a?.map((p) => p.id)).toEqual(["ok"]);
  });

  it("每个成功 op 恰好触发一次 onUpdate，且 state getter 实时反映最新状态", () => {
    let calls = 0;
    let lastState: unknown = null;
    const store = createQueuedPromptStore(
      { a: [makePrompt("p1")] },
      (next) => {
        calls += 1;
        lastState = next;
      },
    );

    // claim -> resolve 两个成功 op，各一次通知；onUpdate 收到的 map 即当前 state
    const claimed = store.claim("a", "p1");
    expect(claimed.claimed).toBe(true);
    expect(calls).toBe(1);
    expect(lastState).toBe(store.state);
    expect(store.state.a[0].status).toBe("sending");

    store.resolve("a", "p1", { type: "accepted" });
    expect(calls).toBe(2);
    expect(lastState).toBe(store.state);
    expect(store.state.a).toBeUndefined();
  });

  it("enqueue：正常入队触发一次 onUpdate 并返回 true；state 立即反映新条目", () => {
    let calls = 0;
    let lastState: unknown = null;
    const store = createQueuedPromptStore({}, (next) => {
      calls += 1;
      lastState = next;
    });

    const enqueued = store.enqueue("a", makePrompt("p1"));
    expect(enqueued).toBe(true);
    expect(calls).toBe(1);
    expect(lastState).toBe(store.state);
    expect(store.state.a?.map((p) => p.id)).toEqual(["p1"]);
  });

  it("enqueue：达到 limit 时拒绝入队，返回 false 且不触发 onUpdate", () => {
    let calls = 0;
    const store = createQueuedPromptStore(
      { a: [makePrompt("p1"), makePrompt("p2")] },
      () => {
        calls += 1;
      },
    );

    const enqueued = store.enqueue("a", makePrompt("p3"), 2);
    expect(enqueued).toBe(false);
    expect(calls).toBe(0);
    expect(store.state.a?.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("enqueue：limit 缺省时沿用 QUEUED_PROMPT_LIMIT 语义（超量拒绝）", () => {
    const full: QueuedPromptSnapshot[] = Array.from({ length: 10 }, (_, i) =>
      makePrompt(`p${i}`),
    );
    let calls = 0;
    const store = createQueuedPromptStore({ a: full }, () => {
      calls += 1;
    });

    expect(store.enqueue("a", makePrompt("overflow"))).toBe(false);
    expect(calls).toBe(0);
  });
});