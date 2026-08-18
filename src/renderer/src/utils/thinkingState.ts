/**
 * onThinking 推送的纯归约：流式思考文本 + 首次非空开始时间。
 *
 * 从 App.tsx 挂载一次的 onThinking effect 提炼：两个 setState 的守卫逻辑
 * （相同文本不触发重渲染；首次非空记录开始时间；清空时移除开始时间）
 * 收敛为单个纯函数，effect 只负责把结果映射回 React state。
 */

export interface ThinkingState {
	/** agentId → 累积思考文本（用于 stream thinking 展示）。 */
	thinkingByAgent: Record<string, string>;
	/** agentId → 首次收到非空思考的时间戳（驱动"思考中"时长展示）。 */
	startedAtByAgent: Record<string, number>;
}

/**
 * 应用一次 thinking 更新。返回值与输入引用相同时表示无变化（调用方可跳过 setState）。
 *
 * - 相同文本：两条记录的引用都保持不变 → 不触发重渲染（主进程在工具执行期间
 *   仍按 50ms 节流推送同一值，相等守卫避免 20Hz 整树重渲染）。
 * - 首次非空：记录 startedAt；文本已存在时保持不变。
 * - 清空（thinking=""）：移除 startedAt。
 */
export function reduceThinkingUpdate(
	current: ThinkingState,
	agentId: string,
	thinking: string,
	now: number = Date.now(),
): ThinkingState {
	let nextThinking = current.thinkingByAgent;
	if (nextThinking[agentId] !== thinking) {
		nextThinking = { ...nextThinking, [agentId]: thinking };
	}
	let nextStartedAt = current.startedAtByAgent;
	if (thinking) {
		if (current.startedAtByAgent[agentId] == null) {
			nextStartedAt = { ...nextStartedAt, [agentId]: now };
		}
	} else if (current.startedAtByAgent[agentId] != null) {
		nextStartedAt = { ...nextStartedAt };
		delete nextStartedAt[agentId];
	}
	if (nextThinking === current.thinkingByAgent && nextStartedAt === current.startedAtByAgent) {
		return current;
	}
	return { thinkingByAgent: nextThinking, startedAtByAgent: nextStartedAt };
}