import type { ImageContent } from "../../../shared/types";
import {
  canDiscardQueuedPrompt,
  canRetractQueuedPromptToInput,
  claimIdleHead,
  claimNextSteerPrompt,
  claimPrompt,
  enqueuePrompt,
  migrateQueuedPrompts,
  replaceAgentQueue,
  resolveClaimedPrompt,
  type QueuedPromptMap,
  type QueuedPromptSnapshot,
} from "./queuedPromptQueue";

/** 与 resolveClaimedPrompt 的 outcome 一致；独立导出便于调用方/测试引用同一形状。 */
export type QueuedPromptResolveOutcome =
  | { type: "accepted" }
  | { type: "failed" | "unknown"; error: string };

export interface QueuedPromptClaimResult {
  /** 被 claim 的快照（仍为 claim 前快照，status 未改写，与 FSM 行为一致）；无可 claim 项时为 undefined。 */
  prompt?: QueuedPromptSnapshot;
  /** 本次调用是否真的改动了队列（false = 门禁拒绝/无目标，未触发 onUpdate）。 */
  claimed: boolean;
}

export interface QueuedPromptStore {
  /** 当前队列的唯一事实来源；每次 op 后立即反映最新状态。 */
  readonly state: QueuedPromptMap;
  /** 原子 claim 指定 pending 快照；非 pending / 不存在时返回 claimed=false。 */
  claim(agentId: string, promptId: string): QueuedPromptClaimResult;
  /** idle drain 严格只 claim 队首；失败/未知队首是发送屏障。 */
  claimIdleHead(agentId: string): QueuedPromptClaimResult;
  /** 同一 final tool-end 窗口按队列顺序原子 claim 第一个 pending steer。 */
  claimNextSteer(agentId: string): QueuedPromptClaimResult;
  /**
   * 入队新快照（FSM 门禁与 enqueuePrompt 一致：超过 limit 拒绝，不触发 onUpdate）。
   * 返回是否真的入队——false = 满员，调用方应保留输入框内容并提示。
   */
  enqueue(
    agentId: string,
    prompt: QueuedPromptSnapshot,
    limit?: number,
  ): boolean;
  /** 结算 sending 快照：accepted 移除，failed/unknown 落状态+错误。非 sending 忽略。 */
  resolve(agentId: string, promptId: string, outcome: QueuedPromptResolveOutcome): void;
  /** 撤回输入框：仅 pending/failed 可撤回；sending/unknown 拒绝（防双发/误导）。 */
  retract(agentId: string, promptId: string): void;
  /** 丢弃：sending 拒绝；pending/failed 移除，unknown 仅清提示（同样移除快照，不重发）。 */
  discard(agentId: string, promptId: string): void;
  /**
   * 重启迁移：只复制确定未投递的 pending/failed 项到 replacement agent；
   * sending/unknown 可能已被旧进程接收，复制会造成重复发送，必须丢弃。
   */
  migrate(replacementById: Map<string, string>, liveIds: Set<string>): void;
}

/**
 * migrate 只做过滤 + 换 key，逐项比较 id/status/error 判定是否真变化。
 * 避免输入本已一致时仍触发 onUpdate——React 同引用/同内容 setState 也会空跑渲染。
 */
function queuedPromptMapEquals(a: QueuedPromptMap, b: QueuedPromptMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const aq = a[key];
    const bq = b[key];
    if (!bq || aq.length !== bq.length) return false;
    for (let i = 0; i < aq.length; i++) {
      const x = aq[i];
      const y = bq[i];
      if (x.id !== y.id || x.status !== y.status || x.error !== y.error) return false;
    }
  }
  return true;
}

/**
 * 队列的唯一事实来源包装器：内部持有一份 state，每个 op 原子地推进 FSM 并
 * 恰好回调一次 onUpdate（仅当状态真的变化时）。调用方不再需要 ref/state 双写。
 */
export function createQueuedPromptStore(
  initial: QueuedPromptMap,
  onUpdate: (next: QueuedPromptMap) => void,
): QueuedPromptStore {
  let state = initial;

  /** 唯一通知点：map 引用不变 = 门禁拒绝/无操作，绝不回调。 */
  function commit(next: QueuedPromptMap): void {
    if (next === state) return;
    state = next;
    onUpdate(next);
  }

  function claimVia(
    claimed: { queues: QueuedPromptMap; prompt?: QueuedPromptSnapshot },
  ): QueuedPromptClaimResult {
    // 同一 FSM 调用同时产出新队列与目标快照，claim 原子性由 FSM 保证；
    // map 引用未变说明目标不存在或非 pending，直接判为未 claim。
    const didClaim = claimed.queues !== state;
    commit(claimed.queues);
    return { prompt: claimed.prompt, claimed: didClaim };
  }

  return {
    get state(): QueuedPromptMap {
      return state;
    },

    claim(agentId: string, promptId: string): QueuedPromptClaimResult {
      return claimVia(claimPrompt(state, agentId, promptId));
    },

    claimIdleHead(agentId: string): QueuedPromptClaimResult {
      return claimVia(claimIdleHead(state, agentId));
    },

    claimNextSteer(agentId: string): QueuedPromptClaimResult {
      return claimVia(claimNextSteerPrompt(state, agentId));
    },

    enqueue(
      agentId: string,
      prompt: QueuedPromptSnapshot,
      limit?: number,
    ): boolean {
      // 门禁由 FSM（enqueuePrompt）保证：满员时返回原引用，不触发 onUpdate。
      const next = enqueuePrompt(state, agentId, prompt, limit);
      const didEnqueue = next !== state;
      commit(next);
      return didEnqueue;
    },

    resolve(
      agentId: string,
      promptId: string,
      outcome: QueuedPromptResolveOutcome,
    ): void {
      const prompt = state[agentId]?.find((item) => item.id === promptId);
      // 门禁前置：resolveClaimedPrompt 只结算 sending；预先拦截可避免它在
      // 非 sending 时经 replaceAgentQueue 产出同内容新引用而空触发 onUpdate。
      if (!prompt || prompt.status !== "sending") return;
      commit(resolveClaimedPrompt(state, agentId, promptId, outcome));
    },

    retract(agentId: string, promptId: string): void {
      const prompt = state[agentId]?.find((item) => item.id === promptId);
      // 门禁与 FSM 一致：sending/unknown 拒绝撤回；不存在时也静默忽略。
      if (!prompt || !canRetractQueuedPromptToInput(prompt.status)) return;
      commit(replaceAgentQueue(state, agentId, (queue) =>
        queue.filter((item) => item.id !== promptId),
      ));
    },

    discard(agentId: string, promptId: string): void {
      const prompt = state[agentId]?.find((item) => item.id === promptId);
      // 门禁与 FSM 一致：sending 禁用丢弃；unknown 仅清提示（移除快照即清除提示，
      // 与 acknowledgeUnknownPrompt 的移除语义一致），pending/failed 真正移除。
      if (!prompt || !canDiscardQueuedPrompt(prompt.status)) return;
      commit(
        replaceAgentQueue(state, agentId, (queue) =>
          queue.filter((item) => item.id !== promptId),
        ),
      );
    },

    migrate(replacementById: Map<string, string>, liveIds: Set<string>): void {
      const next = migrateQueuedPrompts(state, replacementById, liveIds);
      if (!queuedPromptMapEquals(state, next)) commit(next);
    },
  };
}