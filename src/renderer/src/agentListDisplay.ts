import type { AgentTab, SessionSummary } from "../../shared/types";

const DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT = 5;

/** 占位 Agent：真实进程尚未就绪时的侧栏临时条目，进程到达后被替换。 */
export type PendingAgentTab = AgentTab & {
	pendingKind?: "create" | "restart";
	pendingStartedAt?: number;
};

/**
 * 判断真实 Agent 是否是某个 Pending 占位的替换者。
 * 重启占位只匹配本次重启之后出现的新进程，避免误选同项目下已有的同名 Agent。
 */
export function isReplacementForPendingAgent(agent: AgentTab, pending: PendingAgentTab) {
	if (agent.projectId !== pending.projectId || agent.cwd !== pending.cwd)
		return false;

	if (pending.pendingKind === "restart") {
		const startedAt = pending.pendingStartedAt ?? pending.createdAt;
		if (agent.createdAt < startedAt - 1000) return false;
		if (isSameSessionPath(agent.sessionPath, pending.sessionPath)) return true;
		return !pending.sessionPath && agent.title === pending.title;
	}

	if (!pending.id.startsWith("pending-")) return false;
	if (isSameSessionPath(agent.sessionPath, pending.sessionPath)) return true;
	if (pending.sessionPath && agent.createdAt >= pending.createdAt - 1000)
		return true;
	// noSession 匿名 agent：没有 sessionPath，靠 noSession 标记 + 归属项目匹配
	if (pending.noSession && agent.noSession) return true;
	return (
		agent.title === pending.title && agent.createdAt >= pending.createdAt - 1000
	);
}

export type ProjectChildItem =
	| {
			type: "agent";
			key: string;
			agent: AgentTab;
			sortAt: number;
			/** 该 Agent 对应的会话来源（历史会话激活时从 SessionSummary 传递） */
			source?: "pi" | "codex" | "claude" | "opencode";
			/** Codex 导入的子会话 */
			codexSubagents: SessionSummary[];
			/** pi 原生子会话（pi-subagents 等扩展产生的，通过 parentSessionPath 关联） */
			piSubagents: SessionSummary[];
	  }
	| {
			type: "session";
			key: string;
			session: SessionSummary;
			sortAt: number;
			/** Codex 导入的子会话 */
			codexSubagents: SessionSummary[];
			/** pi 原生子会话（pi-subagents 等扩展产生的，通过 parentSessionPath 关联） */
			piSubagents: SessionSummary[];
	  };

export type ProjectAgentSessionDisplay = {
	children: ProjectChildItem[];
	visibleChildren: ProjectChildItem[];
	hiddenChildCount: number;
	/**
	 * 归一化父路径 → 子会话列表 的分组映射。
	 * 除顶层嵌套外，还供侧栏递归渲染孙级（子会话的子会话），避免多级链被孤儿恢复平铺到顶层。
	 */
	piSubagentsByParent: ReadonlyMap<string, SessionSummary[]>;
};

// 会话文件路径可能来自扫描器或 Agent 状态回写，比较时统一分隔符和大小写，避免同一历史会话重复显示/重复激活。
export function normalizeSessionPathForCompare(sessionPath?: string) {
	return sessionPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isSameSessionPath(left?: string, right?: string) {
	const normalizedLeft = normalizeSessionPathForCompare(left);
	const normalizedRight = normalizeSessionPathForCompare(right);
	return Boolean(
		normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
	);
}

/**
 * 侧栏行只在它就是会话窗口当前内容时高亮。
 * 已落盘会话按稳定路径判断；新 Agent 尚未拿到 sessionPath 时才临时回退到 Agent ID。
 */
export function isSidebarSessionRowActive({
	rowSessionPath,
	displayedSessionPath,
	rowAgentId,
	activeAgentId,
}: {
	rowSessionPath?: string;
	displayedSessionPath?: string;
	rowAgentId?: string;
	activeAgentId?: string;
}) {
	if (rowSessionPath) {
		return isSameSessionPath(rowSessionPath, displayedSessionPath);
	}
	return Boolean(rowAgentId && rowAgentId === activeAgentId);
}

/**
 * Viewer 只为“正在恢复它所展示的同一个历史会话”提供启动桥接。
 * 全新 Agent 没有 sessionPath，不能继承此前 Viewer 的时间线或输入状态。
 */
export function getSessionViewerHandoffState({
	viewerSessionPath,
	activeAgentId,
	activeAgentSessionPath,
	activeAgentPending,
}: {
	viewerSessionPath?: string;
	activeAgentId?: string;
	activeAgentSessionPath?: string;
	activeAgentPending: boolean;
}) {
	const activeAgentMatchesViewer = isSameSessionPath(
		activeAgentSessionPath,
		viewerSessionPath,
	);
	const canBridgeMessages = Boolean(
		viewerSessionPath && (!activeAgentId || activeAgentMatchesViewer),
	);
	return {
		// 真实 Agent 就绪后由 Agent 承载界面，但消息到达前仍可用同会话 Viewer 桥接时间线。
		isViewerActive: canBridgeMessages && (!activeAgentId || activeAgentPending),
		canBridgeMessages,
	};
}

function getSessionKey(sessionPath?: string) {
	return normalizeSessionPathForCompare(sessionPath);
}

function getCodexParentKey(session: SessionSummary) {
	return session.codexSessionId ?? session.id;
}

function getAgentSortAt(agent: AgentTab, sessionByKey: Map<string, SessionSummary>) {
	const sessionKey = getSessionKey(agent.sessionPath);
	// 历史会话激活成 Agent 后仍按原会话更新时间排序；全新 Agent 没有历史文件时按创建时间排到最新。
	return sessionKey ? (sessionByKey.get(sessionKey)?.updatedAt ?? agent.createdAt) : agent.createdAt;
}

function chooseAgentForSession(current: AgentTab, candidate: AgentTab) {
	// 如果异常状态下同一个 sessionPath 已经产生多个 Agent，UI 只保留一个：优先保留更新创建的运行态，避免继续暴露重复入口。
	if (candidate.createdAt !== current.createdAt) {
		return candidate.createdAt > current.createdAt ? candidate : current;
	}
	return candidate.status === "running" ? candidate : current;
}

/** 查找某个历史会话当前对应的 Pending/真实 Agent，供嵌套子会话行直接完成 Viewer → Agent 交接。 */
export function getAgentForSessionPath(
	agents: AgentTab[],
	sessionPath?: string,
): AgentTab | undefined {
	const sessionKey = getSessionKey(sessionPath);
	if (!sessionKey) return undefined;
	let matched: AgentTab | undefined;
	for (const agent of agents) {
		if (getSessionKey(agent.sessionPath) !== sessionKey) continue;
		matched = matched ? chooseAgentForSession(matched, agent) : agent;
	}
	return matched;
}

export function getProjectAgentSessionDisplay({
	agents,
	sessions,
	visibleChildCount,
}: {
	agents: AgentTab[];
	sessions: SessionSummary[];
	visibleChildCount?: number;
}): ProjectAgentSessionDisplay {
	const sessionByKey = new Map<string, SessionSummary>();
	const unkeyedSessions: SessionSummary[] = [];
	const codexSubagentsByParent = new Map<string, SessionSummary[]>();

	// pi 原生子会话分组：按 parentSessionPath（归一化）关联到父会话
	const piSubagentsByParent = new Map<string, SessionSummary[]>();

	const parentCandidateSessions = sessions.filter(
		(session) => session.codexThreadSource !== "subagent",
	);
	const parentCodexIds = new Set(
		parentCandidateSessions.map(getCodexParentKey).filter(Boolean),
	);
	for (const session of sessions) {
		// Codex 子会话：按 codexParentThreadId 分组
		if (
			session.codexThreadSource === "subagent" &&
			session.codexParentThreadId &&
			parentCodexIds.has(session.codexParentThreadId)
		) {
			const children = codexSubagentsByParent.get(session.codexParentThreadId) ?? [];
			children.push(session);
			codexSubagentsByParent.set(session.codexParentThreadId, children);
			continue;
		}

		// pi 原生子会话（pi-subagents 等）：按 parentSessionPath 分组，从主列表移除
		if (session.parentSessionPath) {
			const parentKey = normalizeSessionPathForCompare(session.parentSessionPath);
			if (parentKey) {
				const children = piSubagentsByParent.get(parentKey) ?? [];
				children.push(session);
				piSubagentsByParent.set(parentKey, children);
				continue;
			}
		}

		const sessionKey = getSessionKey(session.filePath);
		if (sessionKey) sessionByKey.set(sessionKey, session);
		else unkeyedSessions.push(session);
	}

	const agentBySessionKey = new Map<string, AgentTab>();
	const unkeyedAgents: AgentTab[] = [];
	for (const agent of agents) {
		const sessionKey = getSessionKey(agent.sessionPath);
		if (!sessionKey) {
			unkeyedAgents.push(agent);
			continue;
		}
		const current = agentBySessionKey.get(sessionKey);
		agentBySessionKey.set(
			sessionKey,
			current ? chooseAgentForSession(current, agent) : agent,
		);
	}

	// 子会话启动后也会产生 Agent，但它的唯一视觉入口仍应留在父会话下面。
	// 仅当父条目确实可见时隐藏对应顶层 Agent；父会话缺失/被搜索过滤时仍允许孤儿 Agent 平铺，避免入口消失。
	const nestedAgentSessionKeys = new Set<string>();
	for (const [parentKey, subagents] of piSubagentsByParent) {
		if (!sessionByKey.has(parentKey) && !agentBySessionKey.has(parentKey)) continue;
		for (const subagent of subagents) {
			const sessionKey = getSessionKey(subagent.filePath);
			if (sessionKey) nestedAgentSessionKeys.add(sessionKey);
		}
	}
	for (const subagents of codexSubagentsByParent.values()) {
		for (const subagent of subagents) {
			const sessionKey = getSessionKey(subagent.filePath);
			if (sessionKey) nestedAgentSessionKeys.add(sessionKey);
		}
	}

	/** 根据父条目的 filePath（归一化）查找其 pi 原生子会话 */
	const getPiSubagents = (parentFilePath?: string): SessionSummary[] => {
		if (!parentFilePath) return [];
		const key = normalizeSessionPathForCompare(parentFilePath);
		if (!key) return [];
		const found = piSubagentsByParent.get(key) ?? [];
		return found;
	};

	const children: ProjectChildItem[] = [
		...unkeyedAgents.map<ProjectChildItem>((agent) => ({
			type: "agent",
			key: `agent:${agent.id}`,
			agent,
			sortAt: agent.createdAt,
			codexSubagents: [],
			piSubagents: [],
		})),
		...[...agentBySessionKey.entries()]
			.filter(([sessionKey]) => !nestedAgentSessionKeys.has(sessionKey))
			.map<ProjectChildItem>(
			([sessionKey, agent]) => {
				const linkedSession = sessionByKey.get(sessionKey);
				return {
					type: "agent",
					key: `session-agent:${sessionKey}`,
					agent,
					sortAt: getAgentSortAt(agent, sessionByKey),
					// 历史会话激活为 Agent 后仍携带来源标记，供侧边栏区分导入会话
					source: linkedSession?.source,
					codexSubagents: linkedSession
						? (codexSubagentsByParent.get(getCodexParentKey(linkedSession)) ?? [])
						: [],
					// Agent 激活后父会话在 projectSessions 中被滤掉 → linkedSession 可能为 undefined；
				// 此时仍通过 agent.sessionPath 查找子会话，避免父链接丢失导致子会话降级为孤儿。
				piSubagents: getPiSubagents(linkedSession?.filePath ?? agent.sessionPath),
				};
			},
		),
		...[...sessionByKey.entries()]
			.filter(([sessionKey]) => !agentBySessionKey.has(sessionKey))
			.map<ProjectChildItem>(([sessionKey, session]) => ({
				type: "session",
				key: `session:${sessionKey}`,
				session,
				sortAt: session.updatedAt,
				codexSubagents: codexSubagentsByParent.get(getCodexParentKey(session)) ?? [],
				piSubagents: getPiSubagents(session.filePath),
			})),
		...unkeyedSessions.map<ProjectChildItem>((session) => ({
			type: "session",
			key: `session-file:${session.filePath}`,
			session,
			sortAt: session.updatedAt,
			codexSubagents: codexSubagentsByParent.get(getCodexParentKey(session)) ?? [],
			piSubagents: getPiSubagents(session.filePath),
		})),
	];

	// 孤儿恢复：父会话缺失（被删除/过滤/搜索排除）时，将子会话降级回顶层。
	// 先收集所有已被嵌套展示的子会话路径（含孙级，沿 piSubagentsByParent 递归），
	// 避免孤儿恢复与嵌套展示同时命中导致重复显示，或孙级被错误平铺到顶层。
	const nestedSubagentPaths = new Set<string>();
	const collectNestedPaths = (subagents: SessionSummary[]) => {
		for (const sa of subagents) {
			const key = normalizeSessionPathForCompare(sa.filePath) ?? sa.filePath;
			nestedSubagentPaths.add(key);
			const grandchildren = piSubagentsByParent.get(key);
			if (grandchildren && grandchildren.length > 0) collectNestedPaths(grandchildren);
		}
	};
	for (const child of children) {
		collectNestedPaths(child.piSubagents);
		for (const sa of child.codexSubagents) {
			nestedSubagentPaths.add(normalizeSessionPathForCompare(sa.filePath) ?? sa.filePath);
		}
	}

	const visibleParentKeys = new Set<string>();
	for (const child of children) {
		if (child.type === "agent") {
			const sessionPath = child.agent.sessionPath;
			if (sessionPath) visibleParentKeys.add(normalizeSessionPathForCompare(sessionPath) ?? sessionPath);
		} else {
			visibleParentKeys.add(normalizeSessionPathForCompare(child.session.filePath) ?? child.session.filePath);
		}
	}
	for (const [parentKey, orphanSubagents] of piSubagentsByParent) {
		// 父本身已被嵌套展示（孙级）：由递归渲染挂在父下，不应再提升为顶层孤儿。
		if (nestedSubagentPaths.has(parentKey)) continue;
		if (!visibleParentKeys.has(parentKey) && orphanSubagents.length > 0) {
			for (const orphan of orphanSubagents) {
				const orphanKey = normalizeSessionPathForCompare(orphan.filePath) ?? orphan.filePath;
				// 防御性去重：已嵌套展示，或已有同 sessionPath 的孤儿 Agent 顶层入口时，不再追加第二行。
				if (nestedSubagentPaths.has(orphanKey) || visibleParentKeys.has(orphanKey)) continue;
				children.push({
					type: "session",
					key: `session:${orphanKey}`,
					session: orphan,
					sortAt: orphan.updatedAt,
					codexSubagents: [],
					piSubagents: [],
				});
			}
		}
	}

	children.sort((left, right) => right.sortAt - left.sortAt);

	const limit = visibleChildCount ?? DEFAULT_VISIBLE_PROJECT_CHILD_LIMIT;
	const visibleChildren = children.slice(0, limit);
	return {
		children,
		visibleChildren,
		hiddenChildCount: Math.max(0, children.length - visibleChildren.length),
		piSubagentsByParent,
	};
}
