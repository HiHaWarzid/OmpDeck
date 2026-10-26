import type { AgentRuntimeState, AgentSubagent } from "../../../shared/types";
import { mergeAgentRuntimeState, resolveIncomingRuntimeState } from "../utils/agentRuntimeState";
import { dispatchToAgent } from "./dispatch";
import { runtimeActions, type RuntimeState } from "./slices/runtimeSlice";
import { subagentsActions } from "./slices/subagentsSlice";
import type { SessionWorkspaceStore } from "./sessionWorkspace";
import { sessionWorkspaceStore } from "./store";

/**
 * agent 运行态（批次 5b）：状态住 runtime 切片，读写都经这里，App 不再持有
 * runtimeStateByAgent 这张 per-agent record（及其镜像 ref）。
 *
 * 两个入口语义不同，别合并：
 * - ingestAgentRuntimeState：agents:runtimeState 推送（事件流）。带 runtimeStateSeq
 *   守卫——旧快照必须丢弃（长任务后 agent_end 的慢 RPC 快照可能晚于更新的空闲快照
 *   到达，旧快照会把已 idle 的状态倒灌回 streaming）。同时回传 tool true→false 边沿，
 *   调用方据此投递积压的 steer（边沿判定必须在原始事件上做，见原实现注释）。
 * - applyAgentRuntimeState：RPC 返回值（cycleModel/setThinking/compact/interrupt）。
 *   那是刚发生的操作结果，序号可能更小也不能丢，只做合并（mergeAgentRuntimeState）。
 */

/** 读取某 agent 最新运行态；条目不存在或尚无快照返回 undefined（原 runtimeStateByAgentRef 的替代）。 */
export function getAgentRuntimeState(
  agentId: string,
  store: SessionWorkspaceStore = sessionWorkspaceStore,
): RuntimeState {
  return store.getSlice(agentId, "runtime");
}

/** 事件流入口：序号守卫 + 合并后落进切片，返回合并结果与工具结束边沿。 */
export function ingestAgentRuntimeState(
  agentId: string,
  incoming: AgentRuntimeState,
  store: SessionWorkspaceStore = sessionWorkspaceStore,
): { state: AgentRuntimeState; isToolCompletionEdge: boolean } | null {
  const resolved = resolveIncomingRuntimeState(getAgentRuntimeState(agentId, store), incoming);
  if (!resolved) return null; // 序号更小的旧快照：丢弃，不落库不通知
  dispatchToAgent(agentId, runtimeActions.set(resolved.state), store);
  return resolved;
}

/** RPC 结果入口：合并（无序号守卫）并落进切片，返回合并后的状态供调用方即时使用。 */
export function applyAgentRuntimeState(
  agentId: string,
  incoming: AgentRuntimeState,
  store: SessionWorkspaceStore = sessionWorkspaceStore,
): AgentRuntimeState {
  const current = getAgentRuntimeState(agentId, store);
  const next = mergeAgentRuntimeState(current, incoming);
  // 同值合并返回原引用：无变更就不 dispatch，订阅者不被唤醒（批次 0 的 same-ref 语义）
  if (next !== current) dispatchToAgent(agentId, runtimeActions.set(next), store);
  return next;
}

/**
 * 子代理 registry 推送入口（agents:subagents）。
 *
 * 写独立的 subagents 切片，不进 runtime：progress 帧约 150ms 一批，
 * 混进 runtime 会持续唤醒订阅 runtime 的 App 根组件（与 thought 流同类的回归）。
 * runtimeStateSeq 也不适用——registry 帧不和 get_state 快照共享序号。
 */
export function ingestAgentSubagents(
  agentId: string,
  subagents: AgentSubagent[],
  store: SessionWorkspaceStore = sessionWorkspaceStore,
): void {
  dispatchToAgent(agentId, subagentsActions.set(subagents), store);
}
