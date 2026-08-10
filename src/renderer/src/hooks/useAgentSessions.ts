/**
 * useAgentSessions — Agent/会话状态 Hook
 *
 * 从 App.tsx 提取的 agent/session 相关状态、refs、计算值和纯动作。
 * 与 useFeishuBridge 不同，agent/session 状态与项目、UI、settings 深度耦合，
 * 因此 RPC 流式 effect、createAgent 等带 UI 副作用的逻辑留在 App.tsx，
 * 通过本 hook 暴露的 setters/refs 更新状态。
 *
 * 迁移策略（见 .trae/documents/useAgentSessions-extraction.md）：
 * - Step 0: 状态 + refs + 计算值（零行为变化） ✅
 * - Step 1: 纯动作（applyAgentRuntimeState / cycleModel 等） ✅
 * - Step 2: 会话加载（refreshSessions / refreshProjectSessions） ✅
 */

import { useMemo, useRef, useState } from "react";
import type {
	AgentRuntimeState,
	AgentTab,
	ChatMessage,
	SessionSummary,
} from "../../../shared/types";
import type { PiDesktopApi } from "../../../preload";
import { isReplacementForPendingAgent, type PendingAgentTab } from "../agentListDisplay";
import { mergeAgentRuntimeState } from "../utils/agentRuntimeState";
import { translateAgentErrorMessage } from "../utils/agentErrors";
import { showNotice } from "../utils/notice";
import { t } from "../i18n";
import { withTimeout } from "../utils/withTimeout";
import { sameSessionSummaryList } from "../utils/sessionSummaryList";

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
	/** 当前活跃项目 ID，refreshSessions 默认刷新该项目。 */
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
	const [messagesByAgent, setMessagesByAgent] = useState<
		Record<string, ChatMessage[]>
	>({});
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [sessionsByProject, setSessionsByProject] = useState<
		Record<string, SessionSummary[]>
	>({});
	const [sessionLoadingByProject, setSessionLoadingByProject] = useState<
		Record<string, boolean>
	>({});
	const [runtimeStateByAgent, setRuntimeStateByAgent] = useState<
		Record<string, AgentRuntimeState>
	>({});

	// ===== Refs =====
	const activeAgentIdRef = useRef<string | undefined>(activeAgentId);
	activeAgentIdRef.current = activeAgentId;
	const agentsRef = useRef<AgentTab[]>(agents);
	agentsRef.current = agents;
	// pendingAgentsRef 不做 .current = pendingAgents 同步：createAgent 路径直接写 ref（先于 setState），
	// 随后 setState 触发重渲染时会用 ref 中已更新的值，避免占位 Agent 闪烁。
	const pendingAgentsRef = useRef<PendingAgentTab[]>([]);
	const runtimeStateByAgentRef = useRef<Record<string, AgentRuntimeState>>({});
	runtimeStateByAgentRef.current = runtimeStateByAgent;
	const agentStatusByAgentRef = useRef<Record<string, AgentTab["status"]>>({});
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
	const activeAgent = activeAgentId
		? [...displayAgents, ...pendingAgents].find((agent) => agent.id === activeAgentId)
		: undefined;

	const activeMessages = activeAgentId
		? (messagesByAgent[activeAgentId] ?? [])
		: [];

	// ===== Actions（纯逻辑，无 UI 副作用） =====

	/**
	 * 合并传入的 runtime state 到对应 agent 的缓存。
	 * 通过 ref 读写避免闭包陈旧，合并后同步到 state 触发重渲染。
	 * 返回合并后的 state，供调用方（RPC effect / cycleModel 等）即时使用。
	 */
	function applyAgentRuntimeState(agentId: string, incoming: AgentRuntimeState) {
		const currentState = runtimeStateByAgentRef.current[agentId];
		const nextState = mergeAgentRuntimeState(currentState, incoming);
		if (nextState === currentState) return nextState;
		runtimeStateByAgentRef.current = {
			...runtimeStateByAgentRef.current,
			[agentId]: nextState,
		};
		setRuntimeStateByAgent(runtimeStateByAgentRef.current);
		return nextState;
	}

	/**
	 * 从主进程拉取指定 agent 的最新 runtime state。
	 * 占位 Agent 无真实进程，直接跳过。
	 */
	async function refreshRuntimeState(agentId = activeAgentId) {
		if (!agentId || isPendingAgentId(agentId)) return;
		const state = await api.agents.runtimeState(agentId).catch(() => undefined);
		if (state) applyAgentRuntimeState(agentId, state);
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
	 * 刷新活跃项目的会话列表（用于 sessions state，非按项目分组的 sessionsByProject）。
	 * silent=true 用于删除/重命名/复制等操作后的静默刷新：失败时保留旧列表且不弹错误提示，
	 * 避免与操作自身的成功提示叠加成矛盾通知；错误统一在此捕获，杜绝调用点产生未捕获 rejection。
	 */
	async function refreshSessions(projectId = activeProjectId, silent = false) {
		try {
			const next = await withTimeout(
				api.sessions.list(projectId),
				SESSION_REFRESH_TIMEOUT_MS,
				t("app.sessionRefreshTimeout"),
			);
			setSessions([...next].sort((a, b) => b.updatedAt - a.updatedAt));
		} catch (error) {
			if (!silent) {
				const msg = error instanceof Error ? error.message : String(error);
				showNotice(`${t("app.sessionLoadFailed")}: ${msg}`, 4000, "error");
			}
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
			const next = await withTimeout(
				api.sessions.list(projectId),
				SESSION_REFRESH_TIMEOUT_MS,
				t("app.sessionRefreshTimeout"),
			);
			if (sessionRequestByProjectRef.current[projectId] !== request) return next;
			const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
			setSessionsByProject((current) => {
				const previous = current[projectId] ?? [];
				if (sameSessionSummaryList(previous, sorted)) return current;
				return { ...current, [projectId]: sorted };
			});
			// 通知 App.tsx 更新侧栏可见子项数等 UI 状态（hook 不直接操作 UI state）。
			onSessionsByProjectChanged?.(projectId, sorted);
			return sorted;
		} finally {
			if (sessionRequestByProjectRef.current[projectId] === request) {
				sessionRefreshRunningRef.current.delete(projectId);
				if (!silent) {
					const elapsed = Date.now() - loadingStart;
					if (elapsed < MIN_LOADING_MS) {
						await new Promise<void>((resolve) => setTimeout(resolve, MIN_LOADING_MS - elapsed));
					}
					setSessionLoadingByProject((current) => ({
						...current,
						[projectId]: false,
					}));
				}
				if (sessionRefreshPendingRef.current.delete(projectId)) {
					// 忙碌期间错过的 tick 只补扫一次，避免并发，同时覆盖"子会话刚好在请求快照后落盘"的边界。
					void refreshProjectSessions(projectId, true).catch(() => undefined);
				}
			}
		}
	}

	return {
		// state
		agents,
		pendingAgents,
		activeAgentId,
		activeAgentByProject,
		messagesByAgent,
		runtimeStateByAgent,
		sessions,
		sessionsByProject,
		sessionLoadingByProject,
		// setters
		setAgents,
		setPendingAgents,
		setActiveAgentId,
		setActiveAgentByProject,
		setMessagesByAgent,
		setRuntimeStateByAgent,
		setSessions,
		setSessionsByProject,
		setSessionLoadingByProject,
		// refs
		agentsRef,
		activeAgentIdRef,
		pendingAgentsRef,
		runtimeStateByAgentRef,
		agentStatusByAgentRef,
		sessionRequestByProjectRef,
		sessionRefreshRunningRef,
		sessionRefreshPendingRef,
		displayAgentsRef,
		// computed
		displayAgents,
		activeAgent,
		activeMessages,
		// actions
		applyAgentRuntimeState,
		refreshRuntimeState,
		cycleModel,
		cycleThinking,
		editMessage,
		refreshSessions,
		refreshProjectSessions,
	};
}
