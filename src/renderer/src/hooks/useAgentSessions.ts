/**
 * useAgentSessions — Agent/会话状态 Hook
 *
 * 从 App.tsx 提取的 agent/session 相关状态、refs、计算值和纯动作。
 * agent/session 状态与项目、UI、settings 深度耦合，
 * 因此 RPC 流式 effect、createAgent 等带 UI 副作用的逻辑留在 App.tsx，
 * 通过本 hook 暴露的 setters/refs 更新状态。
 *
 * 迁移策略（见 .trae/documents/useAgentSessions-extraction.md）：
 * - Step 0: 状态 + refs + 计算值（零行为变化） ✅
 * - Step 1: 纯动作（applyAgentRuntimeState / cycleModel 等） ✅
 * - Step 2: 会话加载（refreshProjectSessions） ✅
 */

import { useMemo, useRef, useState } from "react";
import type { AgentTab, SessionSummary } from "../../../shared/types";
import type { PiDesktopApi } from "../../../shared/api";
import { isReplacementForPendingAgent, type PendingAgentTab } from "../agentListDisplay";
import { translateAgentErrorMessage } from "../utils/agentErrors";
import { showNotice } from "../utils/notice";
import { t } from "../i18n";
import { withTimeout } from "../utils/withTimeout";
import { sameSessionSummaryList as sameCatalogSummaryList } from "../agentListDisplay";
import { applyAgentRuntimeState, ingestAgentSubagents } from "../workspace/agentRuntime";

/** 会话扫描超时：避免 IPC 无响应时 UI 永久等待。 */
const SESSION_REFRESH_TIMEOUT_MS = 20_000;

/**
 * 判断 agentId 是否为占位（pending-）Agent。
 * 占位 Agent 尚无真实进程，所有 RPC 路径（cycleModel / refreshRuntimeState 等）都应跳过。
 */
export function isPendingAgentId(agentId?: string) {
	return Boolean(agentId?.startsWith("pending-"));
}

interface UseAgentSessionsDeps {
	/** 桌面 API（Electron preload / browser / preview），由 App.tsx 注入。 */
	api: PiDesktopApi;
	/** 当前活跃项目 ID。 */
	activeProjectId: string | undefined;
	/**
	 * 项目会话列表变更后的回调（如更新侧栏可见子项数）。
	 * hook 只负责数据获取和 sessionsByProject 状态，UI 侧栏分页由 App.tsx 在此回调中处理。
	 */
	onSessionsByProjectChanged?: (projectId: string, sessions: SessionSummary[]) => void;
}

export function useAgentSessions(deps: UseAgentSessionsDeps) {
	const { api, activeProjectId, onSessionsByProjectChanged } = deps;

	// ===== State =====
	const [agents, setAgents] = useState<AgentTab[]>([]);
	const [pendingAgents, setPendingAgents] = useState<PendingAgentTab[]>([]);
	const [activeAgentId, setActiveAgentId] = useState<string>();
	const [activeAgentByProject, setActiveAgentByProject] = useState<
		Record<string, string>
	>({});
	const [sessionsByProject, setSessionsByProject] = useState<
		Record<string, SessionSummary[]>
	>({});
	const [sessionLoadingByProject, setSessionLoadingByProject] = useState<
		Record<string, boolean>
	>({});
	/** 项目会话列表加载失败信息（非静默刷新）：驱动侧栏错误行与重试入口，成功时清除。 */
	const [sessionErrorByProject, setSessionErrorByProject] = useState<
		Record<string, string>
	>({});

	// ===== Refs =====
	const activeAgentIdRef = useRef<string | undefined>(activeAgentId);
	activeAgentIdRef.current = activeAgentId;
	const agentsRef = useRef<AgentTab[]>(agents);
	agentsRef.current = agents;
	// pendingAgentsRef 不做 .current = pendingAgents 同步：createAgent 路径直接写 ref（先于 setState），
	// 随后 setState 触发重渲染时会用 ref 中已更新的值，避免占位 Agent 闪烁。
	const pendingAgentsRef = useRef<PendingAgentTab[]>([]);
	/** 会话扫描可能由项目展开、运行态结束和周期同步同时触发；按项目丢弃旧响应，避免慢请求覆盖新子会话。 */
	const sessionRequestByProjectRef = useRef<Record<string, number>>({});
	const sessionRefreshRunningRef = useRef<Set<string>>(new Set());
	const sessionRefreshPendingRef = useRef<Set<string>>(new Set());

	// ===== Computed =====
	const displayAgents = useMemo(() => {
		const realIds = new Set(agents.map((agent) => agent.id));
		return [
			...agents,
			...pendingAgents.filter(
				(agent) =>
					!realIds.has(agent.id) &&
					!agents.some((realAgent) =>
						isReplacementForPendingAgent(realAgent, agent),
					),
			),
		];
	}, [agents, pendingAgents]);
	// displayAgents 的 ref，供只挂载一次的 IPC 监听器读取最新 Agent 列表，避免闭包陈旧
	const displayAgentsRef = useRef(displayAgents);
	displayAgentsRef.current = displayAgents;

	// 查看器已移除：activeAgent 直接从 displayAgents / pendingAgents 取，不再有伪 Agent。
	// useMemo 缓存：流式 20Hz 渲染时避免每次展开两数组 + 线性查找。
	const activeAgent = useMemo(
		() =>
			activeAgentId
				? [...displayAgents, ...pendingAgents].find(
						(agent) => agent.id === activeAgentId,
					)
				: undefined,
		[activeAgentId, displayAgents, pendingAgents],
	);

	// 消息缓存（messagesByAgent）与运行态（runtimeStateByAgent）已迁入会话工作区切片
	// （批次 5a/5b）：App 经 useWorkspaceSlice 按 (agentId, slice) 订阅，本 hook 不再
	// 持有、也不再暴露对应 state/ref/判空 op。

	// ===== Actions（纯逻辑，无 UI 副作用） =====

	/**
	 * 更新 pending 占位 Agent 列表。
	 * pendingAgentsRef 与 state 是双写镜像（createAgent 路径先写 ref 再 setState，
	 * 避免占位 Agent 闪烁）；调用方只表达"列表变成什么"，
	 * ref/state 同步由本 op 承载。
	 */
	function updatePendingAgents(
		updater: (current: PendingAgentTab[]) => PendingAgentTab[],
	) {
		const next = updater(pendingAgentsRef.current);
		pendingAgentsRef.current = next;
		setPendingAgents(next);
	}

	/**
	 * 从主进程拉取指定 agent 的最新 runtime state。
	 * 占位 Agent 无真实进程，直接跳过。
	 */
	async function refreshRuntimeState(agentId = activeAgentId) {
		if (!agentId || isPendingAgentId(agentId)) return;
		const state = await api.agents.runtimeState(agentId).catch(() => undefined);
		if (state) applyAgentRuntimeState(agentId, state);
		// registry 帧只推增量；渲染层重载后已完成/空闲子代理不会再发帧，
		// 这里补一次快照，避免面板在重载后空白直到下一个 progress。
		const subagents = await api.agents.subagents(agentId).catch(() => undefined);
		if (subagents) ingestAgentSubagents(agentId, subagents);
	}

	/** 循环切换当前 agent 的模型，并通知用户切换结果。 */
	async function cycleModel() {
		if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
		const state = await api.agents.cycleModel(activeAgentId);
		applyAgentRuntimeState(activeAgentId, state);
		showNotice(t("app.modelCycled", { name: state.modelName ?? state.modelId }), 2000);
	}

	/** 循环切换当前 agent 的思考级别。 */
	async function cycleThinking() {
		if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
		const state = await api.agents.cycleThinking(activeAgentId);
		applyAgentRuntimeState(activeAgentId, state);
	}

	/**
	 * 编辑消息：修改 JSONL + 重载会话。
	 * 用户已点击「编辑 + 保存」两步操作，意图明确，不额外弹框确认。
	 */
	async function editMessage(messageId: string, newText: string) {
		if (!activeAgentId) return;
		try {
			await api.agents.editMessage(activeAgentId, messageId, newText);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			showNotice(`${t("message.editFailed")}: ${translateAgentErrorMessage(msg)}`, 5000);
		}
	}

	// ===== 会话加载 =====

	/**
	 * 拉取会话列表（带超时保护）。
	 * 超时 ≠ 扫描失败：renderer 超时只是放弃等待，主进程扫描可能仍在继续。
	 * 用户主动触发的刷新在超时后重试一次——主进程按扫描根共享进行中的扫描，
	 * 重试通常能在原扫描完成后立即返回，避免“点了没反应”而反复点击叠加更多扫描。
	 */
	async function listSessionsWithRetry(projectId: string | undefined, silent: boolean): Promise<SessionSummary[]> {
		const timeoutMsg = t("app.sessionRefreshTimeout");
		try {
			return await withTimeout(api.sessions.list(projectId), SESSION_REFRESH_TIMEOUT_MS, timeoutMsg);
		} catch (error) {
			// 只有超时才值得重试：主进程扫描仍在继续，第二次请求会与进行中的扫描共享结果。
			if (!silent && error instanceof Error && error.message === timeoutMsg) {
				return await withTimeout(api.sessions.list(projectId), SESSION_REFRESH_TIMEOUT_MS, timeoutMsg);
			}
			throw error;
		}
	}

	/**
	 * 刷新指定项目的会话列表（sessionsByProject），带去重和 loading 状态。
	 *
	 * 并发控制：同一项目的请求通过 sessionRefreshRunningRef 串行化，
	 * 忙碌期间错过的请求通过 sessionRefreshPendingRef 标记，当前快照完成后补扫一次。
	 * 旧响应通过 sessionRequestByProjectRef 的序号丢弃，避免慢请求覆盖新子会话。
	 */
	async function refreshProjectSessions(projectId: string, silent = false) {
		if (sessionRefreshRunningRef.current.has(projectId)) {
			// 无论来源是周期同步还是用户操作，都必须在当前快照完成后补扫一次。
			sessionRefreshPendingRef.current.add(projectId);
			if (!silent) {
				// 点击触发的刷新撞上已有扫描（如周期同步）时也给出加载反馈：
				// 否则“点了没反应”，扫描完成后列表才突然出现。
				// loading 由实际完成的那次扫描在 finally 无条件收尾（见下）。
				setSessionLoadingByProject((current) => ({
					...current,
					[projectId]: true,
				}));
			}
			return;
		}
		const request = (sessionRequestByProjectRef.current[projectId] ?? 0) + 1;
		sessionRequestByProjectRef.current[projectId] = request;
		sessionRefreshRunningRef.current.add(projectId);
		const loadingStart = Date.now();
		const MIN_LOADING_MS = 200;
		if (!silent) {
			setSessionLoadingByProject((current) => ({
				...current,
				[projectId]: true,
			}));
			// 让出主线程确保 React 提交 loading 状态到 DOM，避免快速 API 响应导致 loading 状态在同一批中被覆盖
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		try {
			const next = await listSessionsWithRetry(projectId, silent);
			if (sessionRequestByProjectRef.current[projectId] !== request) return next;
			const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
			setSessionsByProject((current) => {
				const previous = current[projectId] ?? [];
				if (sameCatalogSummaryList(previous, sorted)) return current;
				return { ...current, [projectId]: sorted };
			});
			// 任意来源的成功都清除错误标记，让侧栏错误行/重试入口消失。
			setSessionErrorByProject((current) => {
				if (!(projectId in current)) return current;
				const next = { ...current };
				delete next[projectId];
				return next;
			});
			// 通知 App.tsx 更新侧栏可见子项数等 UI 状态（hook 不直接操作 UI state）。
			onSessionsByProjectChanged?.(projectId, sorted);
			return sorted;
		} catch (error) {
			// 失败不向调用方抛错：调用点多用 void/.catch 忽略，这里统一兜底，
			// 由 sessionErrorByProject 驱动侧栏错误行与重试按钮。
			if (!silent) {
				const msg = error instanceof Error ? error.message : String(error);
				setSessionErrorByProject((current) => ({ ...current, [projectId]: msg }));
				showNotice(`${t("app.sessionLoadFailed")}: ${msg}`, 4000, "error");
			}
			return undefined;
		} finally {
			if (sessionRequestByProjectRef.current[projectId] === request) {
				sessionRefreshRunningRef.current.delete(projectId);
				// loading 无条件收尾：可能由被 pending 吞掉的用户点击设置，
				// 而实际完成的是 silent 扫描（其 finally 原本不清 loading）——
				// 若不在此收尾，加载行会永久旋转。
				if (!silent) {
					const elapsed = Date.now() - loadingStart;
					if (elapsed < MIN_LOADING_MS) {
						await new Promise<void>((resolve) => setTimeout(resolve, MIN_LOADING_MS - elapsed));
					}
				}
				setSessionLoadingByProject((current) => ({
					...current,
					[projectId]: false,
				}));
				if (sessionRefreshPendingRef.current.delete(projectId)) {
					// 忙碌期间错过的 tick 只补扫一次，避免并发，同时覆盖"子会话刚好在请求快照后落盘"的边界。
					void refreshProjectSessions(projectId, true).catch(() => undefined);
				}
			}
		}
	}

	/**
	 * 项目记录真的消失：清掉该项目的会话列表缓存与扫描在途标记。
	 *
	 * 会话缓存与项目记录同生命周期——项目被删/被连带删除后若留着 sessionsByProject、
	 * loading、error 与在途序号，同一路径重新注册成新项目时会先闪一段旧项目的会话，
	 * 且旧请求的序号还压在表里，新请求可能被当成"未变化"丢弃。
	 * 只在这里清理，App 侧不直接摸这些 map。
	 */
	function forgetProjectSessions(projectIds: readonly string[]) {
		if (projectIds.length === 0) return;
		const removed = new Set(projectIds);
		const prune = <T,>(current: Record<string, T>): Record<string, T> => {
			if (!projectIds.some((id) => id in current)) return current;
			const next: Record<string, T> = { ...current };
			for (const id of removed) delete next[id];
			return next;
		};
		setSessionsByProject(prune);
		setSessionLoadingByProject(prune);
		setSessionErrorByProject((current) => prune(current));
		// 在途扫描的序号与 pending 标记必须一起清：留着会让下一次扫描拿到旧序号。
		for (const id of removed) {
			delete sessionRequestByProjectRef.current[id];
			sessionRefreshRunningRef.current.delete(id);
			sessionRefreshPendingRef.current.delete(id);
		}
	}

	return {
		// state（messages/runtimeState 已迁入会话工作区切片：App 用 useWorkspaceSlice 订阅）
		agents,
		pendingAgents,
		activeAgentId,
		activeAgentByProject,
		sessionsByProject,
		sessionLoadingByProject,
		sessionErrorByProject,
		// setters（经 op 写入的切片不暴露裸 setter：pending/sessionError）
		setAgents,
		setActiveAgentId,
		setActiveAgentByProject,
		setSessionsByProject,
		setSessionLoadingByProject,
		// refs（挂载一次的监听器/异步路径需要最新值；会话扫描内部序号仅 hook 内部使用）
		agentsRef,
		activeAgentIdRef,
		pendingAgentsRef,
		displayAgentsRef,
		// computed
		displayAgents,
		activeAgent,
		// actions
		refreshRuntimeState,
		cycleModel,
		cycleThinking,
		editMessage,
		refreshProjectSessions,
		forgetProjectSessions,
		updatePendingAgents,
	};
}
