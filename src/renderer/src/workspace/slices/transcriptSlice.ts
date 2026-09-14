import type { ChatMessage } from "../../../../shared/types";
import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * transcript 切片（批次 5a 迁入）：条目（= 活体 agent tab）的消息列表与增量代数。
 *
 * 对应 App 原根级 per-agent map + 同步镜像：
 * - messagesByAgent / messagesByAgentRef、messageDeltaSeqRef
 * 镜像 ref 的根因与 thinking/rpcLog 切片相同：挂载一次的 onMessages 监听器要读
 * 最新缓存，而闭包只能看到挂载时的值。状态进 store 后监听器直接 getSlice 读最新值，
 * 镜像与代数 ref 随之消亡；条目 dispose（agent 关闭）即整块清空，无需 App 侧 prune。
 *
 * 合并（resolveIncomingMessagesDelta）、代数守卫、失同步自愈与 prompt 历史重建由
 * 同目录的 transcriptRuntime 承担：reducer 无法把「prompt 历史重建结果 / 自愈触发」
 * 这类额外输出交回调用方（那些输出分别属于 App 的持久化状态与异步 IPC 流程），
 * 因此纯解码留在运行时模块，reducer 只落存并守卫「无变更 ⇒ 原引用」（不唤醒订阅者）。
 */

export interface TranscriptState {
	/** 该条目的消息列表（首屏基线 / 流式增量合并结果）；seed 为空。 */
	messages: ChatMessage[];
	/**
	 * 已应用的增量代数（原 App 的 messageDeltaSeqRef[agentId]）：异步全量基线在落地时
	 * 与捕获代数比较，不一致即丢弃（resolveFullPullResult 守卫），避免旧基线覆盖新消息。
	 * 只有 delta 应用会前进；全量拉取落地不改变它。
	 */
	seq: number;
	/**
	 * 是否已有消息落库：区分「条目刚 join 的空态」与「已加载但确实为空的会话」。
	 * ensureLoaded 只在前者发起 get_messages（等价原 `messagesByAgent[agentId]` 判空，
	 * 否则空会话每次选中都会重复拉一次基线）。
	 */
	loaded: boolean;
	/**
	 * 增量失同步自愈标记（resolveIncomingMessagesDelta.needsFullPull）：replaceFrom
	 * 引用本地不存在的下标，需要异步拉全量基线补平；基线落地后清除。
	 * 留在切片里而不是运行时的局部变量：它是条目级事实，条目 dispose 时随之消失。
	 */
	needsFullPull: boolean;
}

export type TranscriptAction = {
	type: "transcript/setMessages";
	/** 本次要落库的消息数组（合并结果或全量基线）。 */
	messages: ChatMessage[];
	/** 写入后的增量代数；缺省沿用当前值（全量拉取不推进代数）。 */
	seq?: number;
	/** 写入后的自愈标记；缺省 false（基线落地即清除，合并结果按解析器输出传入）。 */
	needsFullPull?: boolean;
};

export const transcriptActions = {
	/** 落存一次解析/拉取结果：消息 + 代数 + 自愈标记，并把条目标记为已加载。 */
	setMessages: (
		messages: ChatMessage[],
		seq?: number,
		needsFullPull?: boolean,
	): TranscriptAction => ({ type: "transcript/setMessages", messages, seq, needsFullPull }),
};

export const transcriptSlice = {
	name: "transcript",

	seed(_kind: EntryKind): TranscriptState {
		return { messages: [], seq: 0, loaded: false, needsFullPull: false };
	},

	reduce(state: TranscriptState, action: WorkspaceAction): TranscriptState {
		if (action.type !== "transcript/setMessages") return state;
		const { messages, seq, needsFullPull } = action as Extract<
			TranscriptAction,
			{ type: "transcript/setMessages" }
		>;
		const nextSeq = seq ?? state.seq;
		const nextNeedsFullPull = needsFullPull ?? false;
		// 同值空转：主进程 50ms 节流重复推送同一批消息时不唤醒订阅者
		if (
			state.loaded &&
			state.messages === messages &&
			state.seq === nextSeq &&
			state.needsFullPull === nextNeedsFullPull
		) {
			return state;
		}
		return {
			messages,
			seq: nextSeq,
			loaded: true,
			needsFullPull: nextNeedsFullPull,
		};
	},
};
