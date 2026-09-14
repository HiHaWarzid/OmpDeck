import type { AgentMessagesDelta, ChatMessage } from "../../../shared/types";
import {
  resolveFullPullResult,
  resolveIncomingMessagesDelta,
} from "../utils/messageDeltaResolver";
import { createSingleFlight } from "../utils/singleFlight";
import { dispatchToAgent } from "./dispatch";
import { transcriptActions, type TranscriptState } from "./slices/transcriptSlice";
import { isProjectKey, type SessionWorkspaceStore } from "./sessionWorkspace";
import { sessionWorkspaceStore } from "./store";

/**
 * transcript 运行时（批次 5a）：把 IPC 事件翻译成切片动作，并承载增量失同步自愈。
 *
 * 迁出 App 的三件事，这里全在一起：
 * - 增量合并（resolveIncomingMessagesDelta 纯函数原样调用，语义未改）；
 * - 代数守卫：代数住在 transcript 切片状态里（原 messageDeltaSeqRef 的替代），
 *   所以全量基线与 delta 的竞态判定、以及切片裁剪（agent 关闭）天然同生命周期；
 * - 自愈单飞：createSingleFlight 按 agentId 去重，在途期间的再次失同步只登记尾随重跑，
 *   避免持续失同步把每个 50ms delta 放大成一次全量 transcript IPC。
 *
 * reducer 只落存（同引用即无变更）：prompt 历史重建结果属于 App 的持久化状态
 * （useAgentLifecycle/localStorage），无法从 reducer 交回调用方，故纯解码留在本模块。
 */

/**
 * prompt 历史的宿主端口：历史本身是 App 的持久化状态，切片只驱动重建、不持有它。
 * 键的解析（优先 sessionPath、否则 agentId）也留在宿主：那是 App 的 displayAgents 知识。
 */
export interface PromptHistoryPort {
  /** 该 agent 的历史键是否已初始化（true 时解析器跳过重建，幂等保护）。 */
  isInited(agentId: string): boolean;
  /** 该历史键已有记录（最新在前），用于与新基线合并。 */
  existing(agentId: string): string[] | undefined;
  /** 落库重建结果（null = 跳过），并异步从会话文件补全更早记录。 */
  rebuild(agentId: string, history: string[] | null): void;
}

export interface TranscriptRuntimeDeps {
  /** 全量消息拉取（IPC）。 */
  fetchMessages(agentId: string): Promise<ChatMessage[]>;
  promptHistory: PromptHistoryPort;
  /** 该 agent 是否仍处于选中态：选中时补拉的结果只在用户没切走时写入（见 ensureLoaded）。 */
  isActiveAgent(agentId: string): boolean;
  store?: SessionWorkspaceStore;
}

export interface TranscriptRuntime {
  /** 应用一次 agents:message 增量推送。 */
  ingestDelta(agentId: string, delta: AgentMessagesDelta): void;
  /** 选中会话时的主动补拉：条目尚无消息才发起（空会话不重复拉基线）。 */
  ensureLoaded(agentId: string): void;
}

export function createTranscriptRuntime(deps: TranscriptRuntimeDeps): TranscriptRuntime {
  const { fetchMessages, promptHistory, isActiveAgent, store = sessionWorkspaceStore } = deps;
  const requestFullPull = createSingleFlight();

  function transcript(agentId: string): TranscriptState | undefined {
    return store.getSlice(agentId, "transcript");
  }

  function historyContext(agentId: string) {
    return {
      inited: promptHistory.isInited(agentId),
      existingHistory: promptHistory.existing(agentId),
    };
  }

  /** 落地一次全量拉取结果：消息整体替换 + prompt 历史重建；代数已前进则结果作废。 */
  function applyPulledBaseline(capturedSeq: number, agentId: string, full: ChatMessage[]): void {
    const pull = resolveFullPullResult(
      capturedSeq,
      transcript(agentId)?.seq ?? 0,
      full,
      historyContext(agentId),
    );
    if (!pull) return;
    dispatchToAgent(agentId, transcriptActions.setMessages(pull.messages), store);
    promptHistory.rebuild(agentId, pull.promptHistory);
  }

  /** 失同步自愈：单飞全量补拉（在途期间的再次触发合并为一次尾随重跑）。 */
  function pullFullBaseline(agentId: string): void {
    requestFullPull(agentId, async () => {
      // 捕获发起时的代数：拉取期间有更新 delta 到达则本次结果作废（resolveFullPullResult）
      const capturedSeq = transcript(agentId)?.seq ?? 0;
      applyPulledBaseline(capturedSeq, agentId, await fetchMessages(agentId));
    });
  }

  return {
    ingestDelta(agentId, delta) {
      const state = transcript(agentId);
      const resolved = resolveIncomingMessagesDelta(state?.messages, delta, {
        ...historyContext(agentId),
        currentSeq: state?.seq ?? 0,
      });
      dispatchToAgent(
        agentId,
        transcriptActions.setMessages(resolved.messages, resolved.seq, resolved.needsFullPull),
        store,
      );
      if (resolved.promptHistory) promptHistory.rebuild(agentId, resolved.promptHistory);
      // 增量失同步（渲染层重载后 agent 仍在流式，期间只有尾部增量、缺会话头）：
      // 异步拉全量基线补平。拉取期间的更新 delta 使代数前进，旧基线被丢弃。
      if (resolved.needsFullPull) pullFullBaseline(agentId);
    },

    ensureLoaded(agentId) {
      const state = transcript(agentId);
      if (state?.loaded) return;
      const capturedSeq = state?.seq ?? 0;
      void fetchMessages(agentId)
        .then((full) => {
          // 用户已切走则不写入：主进程可能仍在后台加载，这里拿到的部分结果会被
          // 当成 loaded 基线（挡住后续补拉），切回来就是一段残缺历史。
          if (!isActiveAgent(agentId)) return;
          // 拉取期间的更新 delta 由增量路径负责；代数已前进时本次结果作废
          // （applyPulledBaseline 内的 resolveFullPullResult 守卫）。
          applyPulledBaseline(capturedSeq, agentId, full);
        })
        .catch(() => undefined);
    },
  };
}

/**
 * agents:state 推送时对账 transcript 条目（位置与原 migrateAgentMessages 调用一致）：
 * - 按 replacementById 迁移（pending 占位被真实 tab 顶替时，占位期间到达的消息不能丢）；
 * - 按 liveIds 回收已关闭 agent 的条目——增量事件对未知 agent 会 join 自愈（见 dispatchToAgent），
 *   这里保证迟到增量不会让已关闭的条目常驻。
 * 成员同步 effect 仍是通用兜底：这里只处理 transcript 关心的键。
 */
export function reconcileTranscriptEntries(
  replacementById: Map<string, string>,
  liveIds: Set<string>,
  store: SessionWorkspaceStore = sessionWorkspaceStore,
): void {
  for (const [from, to] of replacementById) {
    const migrated = store.getSlice(from, "transcript");
    if (!migrated?.loaded) continue;
    dispatchToAgent(
      to,
      transcriptActions.setMessages(migrated.messages, migrated.seq, migrated.needsFullPull),
      store,
    );
  }
  for (const ref of [...store.getSnapshot().entries.values()]) {
    if (isProjectKey(ref.key) || liveIds.has(ref.key)) continue;
    store.leave(ref.key);
  }
}
