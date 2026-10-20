import type { AgentTab } from "../../../shared/types";
import { isReplacementForPendingAgent, type PendingAgentTab } from "../agentListDisplay";

/**
 * agents:state 推送的纯解码结果：一次 onState 事件所需的全部派生量。
 *
 * 从 App.tsx 的挂载一次 onState effect 提炼（W5：session-path → active-agent
 * 派生链收敛为可测纯函数）。调用方（effect）只负责落库：
 * - remainingPendingAgents.length 变化时才写 pending 列表
 * - pendingReplacementById / draftIds / activeProjectIds 直接喂给
 *   migratePerAgentState 与消息缓存迁移
 */
export interface AgentStateReconciliation {
	/** 尚未被真实 Agent 替换的占位列表（减掉已被新进程顶替的 pending）。 */
	remainingPendingAgents: PendingAgentTab[];
	/** 旧 pending agentId → 新真实 agentId 的替换映射。 */
	pendingReplacementById: Map<string, string>;
	/** 推导后的活跃 agent：原活跃 agent 仍存活不变；被替换则指向替换者；
	 *  占位尚未被替换时保持占位；已关闭则清空。 */
	nextActiveAgentId: string | undefined;
	/** 当前仍存活的 agent id 集合（含 pending），用于裁剪 per-agent 状态。 */
	draftIds: Set<string>;
	/** 当前有真实 agent 的 project id 集合，用于按项目裁剪 drawerPinned。 */
	activeProjectIds: Set<string>;
}

export function reconcileAgentState(
	previousPendingAgents: PendingAgentTab[],
	nextAgents: AgentTab[],
	activeAgentId: string | undefined,
): AgentStateReconciliation {
	const remainingPendingAgents = previousPendingAgents.filter(
		(pending) => !nextAgents.some((agent) => isReplacementForPendingAgent(agent, pending)),
	);
	const pendingReplacementById = new Map(
		previousPendingAgents
			.map((pending) => {
				const replacement = nextAgents.find((agent) =>
					isReplacementForPendingAgent(agent, pending),
				);
				return replacement ? [pending.id, replacement.id] : undefined;
			})
			.filter((entry): entry is [string, string] => Boolean(entry)),
	);
	const nextActiveAgentId = (() => {
		if (!activeAgentId) return undefined;
		if (nextAgents.some((agent) => agent.id === activeAgentId)) return activeAgentId;
		const pendingAgent = previousPendingAgents.find((agent) => agent.id === activeAgentId);
		const replacement = pendingAgent
			? nextAgents.find((agent) => isReplacementForPendingAgent(agent, pendingAgent))
			: undefined;
		if (replacement) return replacement.id;
		return pendingAgent ? activeAgentId : undefined;
	})();
	return {
		remainingPendingAgents,
		pendingReplacementById,
		nextActiveAgentId,
		draftIds: new Set([
			...nextAgents.map((agent) => agent.id),
			...remainingPendingAgents.map((agent) => agent.id),
		]),
		activeProjectIds: new Set(nextAgents.map((agent) => agent.projectId)),
	};
}

/**
 * 两次 agents:state 推送的列表内容是否一致（UI 可见字段全等）。
 *
 * 主进程在工具回合里每 50ms 推一次全量 agent 列表，内容多数时候没变。渲染层若无条件
 * `setAgents(next)`，新数组会击穿 App 的整条派生链（displayAgents → activeAgent →
 * 项目投影 → SidebarTree），让侧栏子树每 50ms 整棵重渲染一次——这是流式期间根组件
 * 被反复唤醒的主因之一。这里按字段比较，内容相同就沿用旧数组：引用稳定即所有
 * 下游 useMemo/memo 全部命中。
 *
 * 用「键集合 + 逐键比较」而不是写死字段名：AgentTab 以后新增字段不需要改这里，
 * 不会因为漏比较而吞掉更新；新字段若为对象（引用每次不同）则退化成「总是不等」，
 * 也就是今天的行为，不会更差。
 */
export function sameAgentTabList(previous: AgentTab[], next: AgentTab[]): boolean {
	if (previous === next) return true;
	if (previous.length !== next.length) return false;
	for (let i = 0; i < next.length; i += 1) {
		const before = previous[i] as unknown as Record<string, unknown>;
		const after = next[i] as unknown as Record<string, unknown>;
		const beforeKeys = Object.keys(before);
		if (beforeKeys.length !== Object.keys(after).length) return false;
		for (const key of beforeKeys) {
			if (before[key] !== after[key]) return false;
		}
	}
	return true;
}
