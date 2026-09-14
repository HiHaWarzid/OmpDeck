import type { SessionWorkspaceStore, WorkspaceAction } from "./sessionWorkspace";
import { sessionWorkspaceStore } from "./store";

/**
 * 对活体 tab 条目 dispatch；条目缺失时先 join 自愈。
 *
 * 自愈存在的根因是时序窗口：条目由成员同步 effect（agents/pendingAgents 变化后）
 * join，而 IPC 事件（增量消息、运行态、思考文本）可能在该 effect 之前到达——
 * 不 join 会丢事件，不丢事件就得容忍迟到事件临时复活条目，由成员同步/onState
 * 对账负责回收（见 transcriptRuntime.reconcileTranscriptEntries）。
 */
export function dispatchToAgent(
  agentId: string,
  action: WorkspaceAction,
  store: SessionWorkspaceStore = sessionWorkspaceStore,
): boolean {
  if (!store.has(agentId)) store.joinTab(agentId);
  return store.dispatchTo(agentId, action);
}
