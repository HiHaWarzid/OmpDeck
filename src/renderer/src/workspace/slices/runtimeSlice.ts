import type { AgentRuntimeState } from "../../../../shared/types";
import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * runtime 切片（批次 5b 迁入）：条目（= 活体 agent tab）的运行态快照。
 *
 * 对应 App 原根级 per-agent map + 同步镜像：
 * - runtimeStateByAgent / runtimeStateByAgentRef
 * 原实现每次工具循环（≤150ms）都把整张 record `{...current, [agentId]: next}` 推回
 * 根 state，任何 agent 的运行态变化都会唤醒整个 App 及其内联侧栏；且裁剪只发生在
 * agent 关闭时的通用成员同步里（messages 有 migrateAgentMessages，运行态没有）。
 *
 * 状态进 store 后：按 (key, slice) 精确订阅——状态指示器只订阅自己 agent 的运行态；
 * 条目 dispose 即整块清空，裁剪路径与 thinking/composer/transcript 一致。
 * 切片状态类型直接用 AgentRuntimeState | undefined（undefined = 尚无快照），
 * 不再包一层 record，省掉「取值要 `record[id]`」的中间层。
 */

export type RuntimeState = AgentRuntimeState | undefined;

export type RuntimeAction = { type: "runtime/set"; state: AgentRuntimeState };

export const runtimeActions = {
	/** 落存合并后的运行态；调用方保证已过序号守卫与 mergeAgentRuntimeState。 */
	set: (state: AgentRuntimeState): RuntimeAction => ({ type: "runtime/set", state }),
};

export const runtimeSlice = {
	name: "runtime",

	seed(_kind: EntryKind): RuntimeState {
		return undefined;
	},

	reduce(state: RuntimeState, action: WorkspaceAction): RuntimeState {
		if (action.type !== "runtime/set") return state;
		const { state: incoming } = action as Extract<RuntimeAction, { type: "runtime/set" }>;
		// 引用守卫（批次 0 的 same-ref 语义）：mergeAgentRuntimeState 对同值快照返回
		// 原引用，这里再守一层——同引用即无变更，不唤醒订阅者。
		return state === incoming ? state : incoming;
	},
};
