import type { AgentSubagent } from "../../../../shared/types";
import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * subagents 切片：omp 子代理 registry 的实时投影（agents:subagents 推送）。
 *
 * 必须与 runtime 切片分开：progress 帧大约 150ms 一批，若混进 runtime 切片，
 * App 根组件对 runtime 的订阅会被这些高频帧持续唤醒。这里只有 SubagentBar
 * 订阅，高频更新影响面收敛到工具栏局部。
 *
 * undefined = 尚未收到任何 registry 帧（面板不渲染）；空数组 = 明确清空
 * （会话切换后由主进程推送），两者语义不同。
 */
export type SubagentsState = AgentSubagent[] | undefined;

export type SubagentsAction = { type: "subagents/set"; subagents: AgentSubagent[] };

export const subagentsActions = {
	set: (subagents: AgentSubagent[]): SubagentsAction => ({ type: "subagents/set", subagents }),
};

export const subagentsSlice = {
	name: "subagents",

	seed(_kind: EntryKind): SubagentsState {
		return undefined;
	},

	reduce(state: SubagentsState, action: WorkspaceAction): SubagentsState {
		if (action.type !== "subagents/set") return state;
		const { subagents } = action as Extract<SubagentsAction, { type: "subagents/set" }>;
		return state === subagents ? state : subagents;
	},
};
