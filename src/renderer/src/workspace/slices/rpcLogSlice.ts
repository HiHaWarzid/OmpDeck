import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * rpcLog 切片：按条目的「RPC 日志开关」。
 *
 * 对应 App 原 `Map<agentId, boolean>` + 同步镜像 ref（agentRpcLoggingRef）。镜像 ref
 * 的根因与 thinking 切片相同：挂载一次的 onRpcLog 订阅回调需要读最新开关，
 * 而闭包只能看到挂载时的 Map。迁入 store 后订阅回调直接 getSlice 拿最新值，
 * 镜像对随之消亡；条目 dispose 即整块清空，无需 App 侧 prune。
 */

export interface RpcLogState {
  /** 该 agent 是否正在把 RPC 摘要写进 DevTools console。 */
  enabled: boolean;
}

export type RpcLogAction = { type: "rpcLog/set"; enabled: boolean };

export const rpcLogActions = {
  set: (enabled: boolean): RpcLogAction => ({ type: "rpcLog/set", enabled }),
};

export const rpcLogSlice = {
  name: "rpcLog",

  seed(_kind: EntryKind): RpcLogState {
    return { enabled: false };
  },

  reduce(state: RpcLogState, action: WorkspaceAction): RpcLogState {
    if (action.type !== "rpcLog/set") return state;
    const { enabled } = action as Extract<RpcLogAction, { type: "rpcLog/set" }>;
    if (state.enabled === enabled) return state; // 同值空转：不触发订阅者
    return { enabled };
  },
};
