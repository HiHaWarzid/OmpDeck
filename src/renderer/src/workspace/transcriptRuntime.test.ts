import { describe, expect, it, vi } from "vitest";
import type { AgentMessagesDelta, ChatMessage } from "../../../shared/types";
import { getAgentRuntimeState, ingestAgentRuntimeState } from "./agentRuntime";
import {
  createTranscriptRuntime,
  reconcileTranscriptEntries,
  type PromptHistoryPort,
} from "./transcriptRuntime";
import {
  createSessionWorkspaceStore,
  type SessionWorkspaceStore,
} from "./sessionWorkspace";

const AGENT = "agent-1";
const OTHER = "agent-2";

function message(id: string, role: ChatMessage["role"] = "assistant", text = id): ChatMessage {
  return { id, agentId: AGENT, role, text, timestamp: 0 };
}

function delta(replaceFrom: number, messages: ChatMessage[], agentId = AGENT): AgentMessagesDelta {
  return { agentId, replaceFrom, messages };
}

type HistoryRecorder = PromptHistoryPort & { rebuilt: Array<string[] | null> };

/** prompt 历史宿主替身：记录 rebuild 调用，inited/existing 按用例给。 */
function historyPort(options: { inited?: boolean; existing?: string[] } = {}): HistoryRecorder {
  const rebuilt: Array<string[] | null> = [];
  return {
    isInited: () => options.inited ?? false,
    existing: () => options.existing,
    rebuild: (_agentId, history) => {
      rebuilt.push(history);
    },
    rebuilt,
  };
}

/** 可手动 settle 的拉取替身：每次调用记录一对 resolver，便于断言在途行为。 */
function deferredFetcher() {
  const calls: Array<{ promise: Promise<ChatMessage[]>; resolve: (m: ChatMessage[]) => void }> = [];
  const fetchMessages = vi.fn(() => {
    const resolvers = Promise.withResolvers<ChatMessage[]>();
    calls.push(resolvers);
    return resolvers.promise;
  });
  return { fetchMessages, calls };
}

function setup(options: {
  fetchMessages?: (agentId: string) => Promise<ChatMessage[]>;
  history?: HistoryRecorder;
  isActiveAgent?: (agentId: string) => boolean;
  store?: SessionWorkspaceStore;
} = {}) {
  const store = options.store ?? createSessionWorkspaceStore();
  if (!store.has(AGENT)) store.joinTab(AGENT);
  if (!store.has(OTHER)) store.joinTab(OTHER);
  const history = options.history ?? historyPort();
  const runtime = createTranscriptRuntime({
    store,
    fetchMessages: options.fetchMessages ?? (async () => []),
    isActiveAgent: options.isActiveAgent ?? (() => true),
    promptHistory: history,
  });
  return { store, runtime, history };
}

function ids(store: SessionWorkspaceStore, agentId = AGENT): string[] {
  return (store.getSlice(agentId, "transcript")?.messages ?? []).map((m) => m.id);
}

describe("ingestDelta：增量合并落进切片", () => {
  it("replaceFrom === 0 整体替换为全量基线，并推进代数", () => {
    const { store, runtime } = setup();
    runtime.ingestDelta(AGENT, delta(0, [message("u1", "user"), message("a1")]));
    const state = store.getSlice(AGENT, "transcript");
    expect(state?.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(state?.seq).toBe(1);
    expect(state?.loaded).toBe(true);
    expect(state?.needsFullPull).toBe(false);
  });

  it("replaceFrom 之前的消息保持原数组引用（流式 diff 约定）", () => {
    const { store, runtime } = setup();
    runtime.ingestDelta(AGENT, delta(0, [message("a1"), message("a2")]));
    const before = store.getSlice(AGENT, "transcript")?.messages ?? [];
    runtime.ingestDelta(AGENT, delta(1, [message("a2", "assistant", "updated"), message("a3")]));
    const after = store.getSlice(AGENT, "transcript")?.messages ?? [];
    expect(after.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    expect(after[0]).toBe(before[0]);
    expect(after[2].text).toBe("a3");
  });

  it("仅后台 agent 的增量不触碰当前 agent 的状态", () => {
    const { store, runtime } = setup();
    runtime.ingestDelta(AGENT, delta(0, [message("a1")]));
    runtime.ingestDelta(OTHER, delta(0, [message("b1")], OTHER));
    expect(ids(store, AGENT)).toEqual(["a1"]);
    expect(ids(store, OTHER)).toEqual(["b1"]);
  });

  it("全量基线含用户消息时重建 prompt 历史", () => {
    const history = historyPort();
    const { runtime } = setup({ history });
    runtime.ingestDelta(AGENT, delta(0, [message("u1", "user", "写个测试"), message("a1")]));
    expect(history.rebuilt).toEqual([["写个测试"]]);
  });

  it("增量事件不重建 prompt 历史（只含尾部，重建会得到不完整历史）", () => {
    const history = historyPort();
    const { runtime } = setup({ history });
    runtime.ingestDelta(AGENT, delta(0, [message("a1")]));
    runtime.ingestDelta(AGENT, delta(1, [message("u1", "user", "更晚的提问")]));
    expect(history.rebuilt).toEqual([]);
  });
});

describe("自愈：needsFullPull + 单飞全量补拉", () => {
  it("replaceFrom 超出本地长度 → 过渡结果先落地并异步补平", async () => {
    const fetcher = deferredFetcher();
    const { store, runtime } = setup({ fetchMessages: fetcher.fetchMessages });
    runtime.ingestDelta(AGENT, delta(2, [message("a3")]));
    // 过渡态：本地为空，钳制到 0 后拼接，聊天区不空白
    expect(ids(store)).toEqual(["a3"]);
    expect(store.getSlice(AGENT, "transcript")?.needsFullPull).toBe(true);
    expect(fetcher.fetchMessages).toHaveBeenCalledTimes(1);
    fetcher.calls[0].resolve([message("a1"), message("a2"), message("a3")]);
    await fetcher.calls[0].promise;
    expect(ids(store)).toEqual(["a1", "a2", "a3"]);
    expect(store.getSlice(AGENT, "transcript")?.needsFullPull).toBe(false);
  });

  it("持续失同步时单飞：在途期间的触发只做一次尾随重跑", async () => {
    const fetcher = deferredFetcher();
    const { store, runtime } = setup({ fetchMessages: fetcher.fetchMessages });
    runtime.ingestDelta(AGENT, delta(5, [message("x")]));
    runtime.ingestDelta(AGENT, delta(5, [message("y")]));
    runtime.ingestDelta(AGENT, delta(5, [message("z")]));
    // 在途：后续失同步只登记尾随（合并为一次），不是每个 delta 各发起一次 IPC
    expect(fetcher.fetchMessages).toHaveBeenCalledTimes(1);
    fetcher.calls[0].resolve([message("a1"), message("a2")]);
    await vi.waitFor(() => expect(fetcher.fetchMessages).toHaveBeenCalledTimes(2));
    // 第一次结果因拉取期间代数前进（三个 delta）被丢弃，过渡态仍是最新合并结果
    expect(ids(store)).toEqual(["x", "y", "z"]);
    fetcher.calls[1].resolve([message("a1"), message("a2")]);
    await fetcher.calls[1].promise;
    expect(ids(store)).toEqual(["a1", "a2"]);
  });

  it("拉取期间代数前进 → 旧基线作废，不覆盖更新的消息", async () => {
    const fetcher = deferredFetcher();
    const { store, runtime } = setup({ fetchMessages: fetcher.fetchMessages });
    runtime.ingestDelta(AGENT, delta(3, [message("stale-tail")])); // 触发自愈
    // 拉取在途：新的全量基线到达，代数前进
    runtime.ingestDelta(AGENT, delta(0, [message("fresh-1"), message("fresh-2")]));
    fetcher.calls[0].resolve([message("stale-1"), message("stale-2")]);
    await fetcher.calls[0].promise;
    expect(ids(store)).toEqual(["fresh-1", "fresh-2"]);
  });

  it("非失同步的普通增量不触发全量拉取", () => {
    const fetcher = deferredFetcher();
    const { runtime } = setup({ fetchMessages: fetcher.fetchMessages });
    runtime.ingestDelta(AGENT, delta(0, [message("a1")]));
    runtime.ingestDelta(AGENT, delta(1, [message("a2")]));
    expect(fetcher.fetchMessages).not.toHaveBeenCalled();
  });
});

describe("ensureLoaded：选中会话时补首屏", () => {
  it("尚未加载才拉取；空会话落地后不再重复拉取", async () => {
    const fetcher = deferredFetcher();
    const { store, runtime } = setup({ fetchMessages: fetcher.fetchMessages });
    runtime.ensureLoaded(AGENT);
    expect(fetcher.fetchMessages).toHaveBeenCalledTimes(1);
    fetcher.calls[0].resolve([]);
    await fetcher.calls[0].promise;
    expect(store.getSlice(AGENT, "transcript")?.loaded).toBe(true);
    runtime.ensureLoaded(AGENT);
    expect(fetcher.fetchMessages).toHaveBeenCalledTimes(1);
  });

  it("用户已切走 → 半加载结果不写入（不会挡住后续补拉）", async () => {
    const fetcher = deferredFetcher();
    let active = true;
    const { store, runtime } = setup({
      fetchMessages: fetcher.fetchMessages,
      isActiveAgent: () => active,
    });
    runtime.ensureLoaded(AGENT);
    active = false;
    fetcher.calls[0].resolve([message("partial")]);
    await fetcher.calls[0].promise;
    expect(store.getSlice(AGENT, "transcript")?.loaded).toBe(false);
    expect(ids(store)).toEqual([]);
  });

  it("补拉期间已有增量到达 → 增量结果保留（代数守卫）", async () => {
    const fetcher = deferredFetcher();
    const { store, runtime } = setup({ fetchMessages: fetcher.fetchMessages });
    runtime.ensureLoaded(AGENT);
    runtime.ingestDelta(AGENT, delta(0, [message("streamed")]));
    fetcher.calls[0].resolve([message("pulled-1")]);
    await fetcher.calls[0].promise;
    expect(ids(store)).toEqual(["streamed"]);
  });
});

describe("根订阅面：后台增量不唤醒任何根级订阅", () => {
  it("后台 agent 的 delta / 运行态变化不唤醒当前 agent 的订阅者", () => {
    const store = createSessionWorkspaceStore();
    store.joinTab(AGENT);
    store.joinTab(OTHER);
    const runtime = createTranscriptRuntime({
      store,
      fetchMessages: async () => [],
      isActiveAgent: () => true,
      promptHistory: historyPort(),
    });
    // App 根的订阅面：结构快照 + 当前 agent 的 transcript/runtime 切片 + 跨条目运行态
    const structural = vi.fn();
    const activeTranscript = vi.fn();
    const activeRuntime = vi.fn();
    const crossEntryRuntime = vi.fn();
    store.subscribe(structural);
    store.subscribeSlice(AGENT, "transcript", activeTranscript);
    store.subscribeSlice(AGENT, "runtime", activeRuntime);
    store.subscribeSliceChange("runtime", crossEntryRuntime);

    runtime.ingestDelta(OTHER, delta(0, [message("b1")], OTHER));
    ingestAgentRuntimeState(OTHER, { modelId: "m1", isStreaming: true }, store);

    expect(structural).not.toHaveBeenCalled();
    expect(activeTranscript).not.toHaveBeenCalled();
    expect(activeRuntime).not.toHaveBeenCalled();
    // 跨条目订阅只为兜底逻辑唤醒（队列冲刷），且按 agent 精确到键
    expect(crossEntryRuntime).toHaveBeenCalledTimes(1);
    expect(crossEntryRuntime).toHaveBeenCalledWith(OTHER);
    // 后台 agent 的状态确实落库了（不是没接收）
    expect(ids(store, OTHER)).toEqual(["b1"]);
    expect(getAgentRuntimeState(OTHER, store)?.isStreaming).toBe(true);
  });
});

describe("条目对账：裁剪已关闭 agent、迁移占位", () => {
  it("agent 关闭（条目 leave）后切片状态随之消失", () => {
    const { store, runtime } = setup();
    runtime.ingestDelta(AGENT, delta(0, [message("a1")]));
    expect(store.getSlice(AGENT, "transcript")).toBeDefined();
    store.leave(AGENT);
    expect(store.getSlice(AGENT, "transcript")).toBeUndefined();
  });

  it("按 liveIds 回收已关闭条目，保留存活条目", () => {
    const { store, runtime } = setup();
    runtime.ingestDelta(AGENT, delta(0, [message("a1")]));
    runtime.ingestDelta(OTHER, delta(0, [message("b1")], OTHER));
    reconcileTranscriptEntries(new Map(), new Set([OTHER]), store);
    expect(store.getSlice(AGENT, "transcript")).toBeUndefined();
    expect(ids(store, OTHER)).toEqual(["b1"]);
  });

  it("把占位条目迁移到真实 tab（占位期间的消息不丢），旧键被回收", () => {
    const store = createSessionWorkspaceStore();
    const { runtime } = setup({ store });
    store.joinTab("pending-1");
    runtime.ingestDelta("pending-1", delta(0, [message("a1")], "pending-1"));
    reconcileTranscriptEntries(new Map([["pending-1", "real-1"]]), new Set(["real-1"]), store);
    expect(ids(store, "real-1")).toEqual(["a1"]);
    expect(store.getSlice("pending-1", "transcript")).toBeUndefined();
  });

  it("未加载的占位条目不会被迁移出空基线", () => {
    const store = createSessionWorkspaceStore();
    setup({ store });
    store.joinTab("pending-2");
    reconcileTranscriptEntries(new Map([["pending-2", "real-2"]]), new Set(["real-2"]), store);
    expect(store.has("real-2")).toBe(false);
  });
});
