import type { AgentRuntimeState, AgentStatus } from "../../../shared/types";

/**
 * 合并异步 runtime 快照。完整状态查询可能晚于原始 tool start/end 事件返回，
 * 因此迟到快照只更新模型/token 等字段，不能倒灌旧的工具执行状态。
 */
export function mergeAgentRuntimeState(
  current: AgentRuntimeState | undefined,
  incoming: AgentRuntimeState,
): AgentRuntimeState {
  if (
    current?.toolStateSequence != null &&
    incoming.toolStateSequence != null &&
    incoming.toolStateSequence < current.toolStateSequence
  ) {
    const {
      isExecutingTool: _staleToolFlag,
      executingToolName: _staleToolName,
      toolStateSequence: _staleToolSequence,
      ...nonToolState
    } = incoming;
    return { ...current, ...nonToolState };
  }
  const merged = { ...current, ...incoming };
  if (
    current &&
    Object.keys(merged).every(
      (key) => current[key as keyof AgentRuntimeState] === merged[key as keyof AgentRuntimeState],
    )
  ) {
    return current;
  }
  return merged;
}

/**
 * busy 单一推导：生命周期运行态（running/starting）或运行时流式/工具执行标志。
 * 工具执行必发生在 running 期间，isExecutingTool 是 running 的补充信号而非独立维度。
 * 全项目所有「agent 是否繁忙」判断统一走这里，避免各处谓词语义漂移。
 */
export function isAgentBusy(
  agent: { status?: AgentStatus } | undefined,
  runtimeState?: AgentRuntimeState,
): boolean {
  return Boolean(
    agent &&
      (agent.status === "running" ||
        agent.status === "starting" ||
        runtimeState?.isStreaming ||
        runtimeState?.isExecutingTool),
  );
}

/** agent 正在产生输出：running 生命周期态或流式标志（帧率采样/awaiting 判断用）。 */
export function isAgentStreaming(
  agent: { status?: AgentStatus } | undefined,
  runtimeState?: AgentRuntimeState,
): boolean {
  return Boolean(agent?.status === "running" || runtimeState?.isStreaming);
}
