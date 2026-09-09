import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * thinking 切片（切片 2a 迁入）：按条目的流式思考文本 + 首次非空开始时间。
 *
 * 对应 App 原两张 per-agent 键控 map + 一对镜像 ref：
 * - streamingThinking[agentId] / streamingThinkingRef
 * - streamingThinkingStartedAt[agentId] / streamingThinkingStartedAtRef
 * 镜像 ref 存在的根因是「挂载一次的 onThinking 监听器需要读最新缓存」——
 * store 的 dispatch 直接落进自身最新状态，镜像对随之消亡（见 CONTEXT.md
 * SessionEntry / Slice 术语）。语义与 utils/thinkingState.reduceThinkingUpdate
 * 逐点等价（该模块随迁入删除）：
 * - 同文本 → 原引用（主进程 50ms 节流重复推送不触发订阅者）；
 * - 首次非空记录 now；已有 startedAt 后保持首次时间；
 * - 清空（text=""）→ text 置空并移除 startedAt。
 */

export interface ThinkingState {
  /** 累积思考文本（流式展示用）；清空 = ""。 */
  text: string;
  /** 首次收到非空思考的时间戳（思考时长计时起点）。 */
  startedAt?: number;
}

export type ThinkingAction = { type: "thinking/update"; text: string; now: number };

export const thinkingActions = {
  update: (text: string, now: number = Date.now()): ThinkingAction => ({
    type: "thinking/update",
    text,
    now,
  }),
};

export const thinkingSlice = {
  name: "thinking",

  seed(_kind: EntryKind): ThinkingState {
    return { text: "" };
  },

  reduce(state: ThinkingState, action: WorkspaceAction): ThinkingState {
    if (action.type !== "thinking/update") return state;
    const { text, now } = action as Extract<ThinkingAction, { type: "thinking/update" }>;
    if (state.text === text) return state; // 同文本空转：20Hz 节流推送的相等守卫
    const next: ThinkingState = { text };
    if (text) {
      // 首次非空记录起点；已有 startedAt 保持首次时间
      next.startedAt = state.startedAt ?? now;
    }
    return next; // 清空（text=""）→ 无 startedAt
  },
};
