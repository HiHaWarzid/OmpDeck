import type { AgentUiRequest } from "../../../../shared/types";
import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * uiRequest 切片：条目自己待回答的交互式 UI 请求（select/confirm/input/editor/ask）。
 *
 * 对应 App 原根级 `Record<requestId, AgentUiRequest>`：
 * - 只按 `agentId === activeAgentId` 过滤读取，却由根 state 承载——任何 agent
 *   的扩展提问都会唤醒 9k 行根组件；
 * - `completed` 只删除对应 request，agent 关闭后残余请求永不清理，卡片会挂到
 *   已关闭的会话上（回到该 tab 时复现）。
 *
 * 迁入后键 = 条目键，离场即回收；读取侧只订阅焦点条目的切片。
 * `completed` 字段保留在请求对象里：扩展可能先发普通请求再发 completed 事件，
 * 两者都走 upsert/remove 归约，切片不解释语义。
 */

export interface UiRequestState {
  readonly requests: readonly AgentUiRequest[];
}

/** 共享空列表：条目 join 初值与「无待答请求」的稳定引用。 */
const EMPTY_REQUESTS: readonly AgentUiRequest[] = Object.freeze([]);

export type UiRequestAction =
  | { type: "uiRequest/upsert"; request: AgentUiRequest }
  | { type: "uiRequest/remove"; requestId: string };

export const uiRequestActions = {
  upsert: (request: AgentUiRequest): UiRequestAction => ({ type: "uiRequest/upsert", request }),
  remove: (requestId: string): UiRequestAction => ({ type: "uiRequest/remove", requestId }),
};

export const uiRequestSlice = {
  name: "uiRequest",

  seed(_kind: EntryKind): UiRequestState {
    return { requests: EMPTY_REQUESTS };
  },

  reduce(state: UiRequestState, action: WorkspaceAction): UiRequestState {
    if (action.type === "uiRequest/upsert") {
      const { request } = action as Extract<UiRequestAction, { type: "uiRequest/upsert" }>;
      const index = state.requests.findIndex((item) => item.requestId === request.requestId);
      if (index === -1) return { requests: [...state.requests, request] };
      // 同一对象重复到达（扩展重发未变化请求）不替换、不通知
      if (state.requests[index] === request) return state;
      const requests = state.requests.slice();
      requests[index] = request;
      return { requests };
    }
    if (action.type === "uiRequest/remove") {
      const { requestId } = action as Extract<UiRequestAction, { type: "uiRequest/remove" }>;
      const requests = state.requests.filter((item) => item.requestId !== requestId);
      // 未知 requestId（已回答/已由 completed 事件删除）空转
      if (requests.length === state.requests.length) return state;
      return { requests };
    }
    return state;
  },
};
