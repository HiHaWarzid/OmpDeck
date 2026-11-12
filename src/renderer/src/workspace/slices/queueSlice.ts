import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * queue 切片：条目自己的「投递结果未知」提示。
 *
 * 对应 App 原根级 `Record<agentId, UncertainPrompt[]>` + 裸 setter：
 * - agent 关闭后该键永不裁剪（transcript/runtime 都随条目 dispose，唯独这里漏了）；
 * - 每次追加/移除都整表写回根 state，唤醒 9k 行根组件。
 *
 * 迁入后键 = 条目键，离场即回收；订阅者按 (key, slice) 精确唤醒。
 * 服务端队列（runtimeState.queuedMessages）不在本切片：它是服务端事实，
 * 由 runtime 切片承载，二者在 UI 层合并成待发送行（utils/queueChips）。
 */

/** 本地「投递结果未知」提示：omp 可能已接收，不能重试也不能伪造撤回。 */
export interface UncertainPromptEntry {
  id: string;
  text: string;
  error: string;
}

export interface QueueState {
  readonly uncertain: readonly UncertainPromptEntry[];
}

/** 共享空列表：条目 join 初值与「无未知提示」的稳定引用。 */
const EMPTY_QUEUE: readonly UncertainPromptEntry[] = Object.freeze([]);

export type QueueAction =
  | { type: "queue/append"; entry: UncertainPromptEntry }
  | { type: "queue/dismiss"; id: string };

export const queueActions = {
  append: (entry: UncertainPromptEntry): QueueAction => ({ type: "queue/append", entry }),
  dismiss: (id: string): QueueAction => ({ type: "queue/dismiss", id }),
};

export const queueSlice = {
  name: "queue",

  seed(_kind: EntryKind): QueueState {
    return { uncertain: EMPTY_QUEUE };
  },

  reduce(state: QueueState, action: WorkspaceAction): QueueState {
    if (action.type === "queue/append") {
      const { entry } = action as Extract<QueueAction, { type: "queue/append" }>;
      return { uncertain: [...state.uncertain, entry] };
    }
    if (action.type === "queue/dismiss") {
      const { id } = action as Extract<QueueAction, { type: "queue/dismiss" }>;
      const next = state.uncertain.filter((item) => item.id !== id);
      // 未知 id 空转：返回原引用，不唤醒订阅者
      if (next.length === state.uncertain.length) return state;
      return { uncertain: next };
    }
    return state;
  },
};
