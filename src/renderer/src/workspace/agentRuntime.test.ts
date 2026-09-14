import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeState } from "../../../shared/types";
import { applyAgentRuntimeState, getAgentRuntimeState, ingestAgentRuntimeState } from "./agentRuntime";
import { createSessionWorkspaceStore } from "./sessionWorkspace";

const AGENT = "agent-1";

describe("ingestAgentRuntimeState（agents:runtimeState 事件流）", () => {
  it("落进 runtime 切片并回传 tool 结束边沿", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    ingestAgentRuntimeState(AGENT, { isExecutingTool: true }, store);
    const resolved = ingestAgentRuntimeState(
      AGENT,
      { isExecutingTool: false },
      store,
    );
    expect(resolved?.isToolCompletionEdge).toBe(true);
    expect(getAgentRuntimeState(AGENT, store)?.isExecutingTool).toBe(false);
  });

  it("序号更小的旧快照丢弃：不落库、不通知", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    ingestAgentRuntimeState(AGENT, { runtimeStateSeq: 5, isStreaming: false }, store);
    const listener = vi.fn();
    const unsubscribe = store.subscribeSlice(AGENT, "runtime", listener);
    const resolved = ingestAgentRuntimeState(
      AGENT,
      { runtimeStateSeq: 3, isStreaming: true },
      store,
    );
    expect(resolved).toBeNull();
    expect(getAgentRuntimeState(AGENT, store)?.isStreaming).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("同值快照不唤醒订阅者（same-ref 语义）", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    ingestAgentRuntimeState(AGENT, { modelId: "m1" }, store);
    const listener = vi.fn();
    const unsubscribe = store.subscribeSlice(AGENT, "runtime", listener);
    ingestAgentRuntimeState(AGENT, { modelId: "m1" }, store);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("后台 agent 的运行态变化不唤醒其他 agent 的订阅者", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    store.joinTab("agent-2");
    const listener = vi.fn();
    const unsubscribe = store.subscribeSlice(AGENT, "runtime", listener);
    ingestAgentRuntimeState("agent-2", { isExecutingTool: true }, store);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("applyAgentRuntimeState（RPC 结果路径）", () => {
  it("合并并返回合并结果（模型/思考级别等字段）", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    applyAgentRuntimeState(AGENT, { modelId: "m1", provider: "p" }, store);
    const merged = applyAgentRuntimeState(AGENT, { thinkingLevel: "high" }, store);
    expect(merged).toMatchObject({ modelId: "m1", provider: "p", thinkingLevel: "high" });
    expect(getAgentRuntimeState(AGENT, store)).toBe(merged);
  });

  it("不做序号守卫：RPC 返回值即使序号更小也要落地", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    applyAgentRuntimeState(AGENT, { runtimeStateSeq: 9, modelId: "m1" }, store);
    const applied = applyAgentRuntimeState(
      AGENT,
      { runtimeStateSeq: 4, modelId: "m2" },
      store,
    );
    expect(applied.modelId).toBe("m2");
    expect(getAgentRuntimeState(AGENT, store)?.modelId).toBe("m2");
  });

  it("同值合并返回原引用且不替换切片状态", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    const first = applyAgentRuntimeState(AGENT, { modelId: "m1" }, store);
    const second = applyAgentRuntimeState(AGENT, { modelId: "m1" }, store);
    expect(second).toBe(first);
    expect(getAgentRuntimeState(AGENT, store)).toBe(first);
  });

  it("条目不存在时自愈 join（迟到 RPC 结果不丢）", () => {
    const store = createSessionWorkspaceStore();
    applyAgentRuntimeState(AGENT, { modelId: "m1" }, store);
    expect(store.has(AGENT)).toBe(true);
    expect(getAgentRuntimeState(AGENT, store)?.modelId).toBe("m1");
  });

  it("agent 关闭后运行态随条目裁剪一起消失", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    applyAgentRuntimeState(AGENT, { modelId: "m1" }, store);
    store.leave(AGENT);
    expect(getAgentRuntimeState(AGENT, store)).toBeUndefined();
  });
});
