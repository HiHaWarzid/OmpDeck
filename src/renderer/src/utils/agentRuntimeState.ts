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
 * 解析一次进入的完整运行态快照：返回 null 表示旧快照（序号更小）应丢弃。
 * 返回对象含两个结果：state 为按 mergeAgentRuntimeState 合并后的新状态；
 * isToolCompletionEdge 表示 tool 执行是否刚结束（isExecutingTool true→false，
 * 且 toolStateSequence 不倒退）——App 用它投递积压的 steer prompt。
 * 逻辑从 App.onRuntimeState 处理器原样迁出，保证 steer 投递窗口不因 React 批量渲染丢失。
 *
 * 序号丢弃理由：完整快照带单调序号，长任务后 omp 繁忙时 agent_end 的慢 RPC 快照
 * 可能晚于更新的空闲快照到达，旧快照（isStreaming: true）会覆盖已 idle 的状态，
 * 让左下角三点指示器卡住；序号更小的旧快照直接丢弃。工具边沿轻量 patch 不带序号
 * （undefined），仍即时应用。toolStateSequence 兼容 null 判定：轻量 patch 不携带该
 * 序号时仍按 true→false 边沿投递，避免为了保证工具边沿顺序而短暂丢失模型、token
 * 等运行信息（tool start/end 由主进程以轻量 patch 立即推送，与最近一次完整状态合并）。
 */
export function resolveIncomingRuntimeState(
  previous: AgentRuntimeState | undefined,
  incoming: AgentRuntimeState,
): { state: AgentRuntimeState; isToolCompletionEdge: boolean } | null {
  const incomingSeq = incoming.runtimeStateSeq;
  if (incomingSeq != null && previous?.runtimeStateSeq != null && incomingSeq < previous.runtimeStateSeq) {
    return null;
  }
  const state = mergeAgentRuntimeState(previous, incoming);
  const isToolCompletionEdge = Boolean(
    previous?.isExecutingTool &&
      !state.isExecutingTool &&
      (incoming.toolStateSequence == null ||
        previous.toolStateSequence == null ||
        incoming.toolStateSequence >= previous.toolStateSequence),
  );
  return { state, isToolCompletionEdge };
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

/** 生命周期态恰为 running：区别于 isAgentBusy 的宽松语义，驱动精确的“正在运行”判断。 */
export function isAgentExactlyRunning(
  agent: { status?: AgentStatus } | undefined,
): boolean {
  return agent?.status === "running";
}

/** 生命周期态为 starting（进程启动中，不可交互）。 */
export function isAgentStarting(
  agent: { status?: AgentStatus } | undefined,
): boolean {
  return agent?.status === "starting";
}

/** 生命周期态为 idle（空闲、可接收新指令）。 */
export function isAgentIdle(
  agent: { status?: AgentStatus } | undefined,
): boolean {
  return agent?.status === "idle";
}

/** 生命周期态为 running 或 idle：活跃可交互的 agent（排除 starting/error/closed）。 */
export function isAgentActiveOrIdle(
  agent: { status?: AgentStatus } | undefined,
): boolean {
  return agent?.status === "running" || agent?.status === "idle";
}

/** 生命周期态为 running 或 starting：运行中或正在启动（非终态、非空闲）。 */
export function isAgentActiveOrStarting(
  agent: { status?: AgentStatus } | undefined,
): boolean {
  return agent?.status === "running" || agent?.status === "starting";
}
