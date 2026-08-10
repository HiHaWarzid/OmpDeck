/**
 * useAgentLifecycle — Agent 生命周期状态 Hook
 *
 * 独占 App.tsx 中 7 个按 agent 隔离的状态切片（prompt / images / queuedPrompts /
 * terminalDock / drawerPinned / promptHistory / queueFlush），将 agent 替换
 * （pending→real、重启、关闭）这个 seam 变成两个原子事务方法：
 *
 * - migratePerAgentState: onState 推送时一次性迁移所有 per-agent 状态
 * - commitPendingToReal: createAgent 成功时将 pending 草稿迁移到真实 tab
 *
 * 所有 state 值、setter 和 ref 都透传给 App.tsx，现有调用点零感知。
 */
import { useCallback, useRef, useState } from "react";
import type { ImageContent } from "../../../shared/types";
import type { QueuedPromptSnapshot } from "../utils/queuedPromptQueue";
import { migrateQueuedPrompts } from "../utils/queuedPromptQueue";
import {
	migrateTerminalDockAgentState,
	type TerminalDockStateByOwner,
} from "../terminalDockState";
import type { DrawerPanel } from "../components/app/AppParts";

export type QueuedPrompt = QueuedPromptSnapshot;

/**
 * 将 per-agent record 按 replacementById 迁移键并按 liveIds 裁剪。
 * - replacementById: 旧 agentId → 新 agentId（pending 被真实 tab 替换）
 * - liveIds: 当前仍存活的 agent 集合（含 pending），不在集合内的键被裁剪
 */
export function migrateAgentRecord<T>(
	current: Record<string, T>,
	replacementById: Map<string, string>,
	liveIds: Set<string>,
): Record<string, T> {
	const next: Record<string, T> = {};
	for (const [agentId, value] of Object.entries(current)) {
		const nextAgentId = replacementById.get(agentId) ?? agentId;
		if (liveIds.has(nextAgentId)) next[nextAgentId] = value;
	}
	return next;
}

export function useAgentLifecycle() {
	// ── prompt 草稿（按 agent 隔离） ──
	// promptByAgent 仅驱动 RichInput chip 渲染；livePromptByAgentRef 始终保持最新，
	// 发送路径从 ref 读取，避免每键触发 App 重渲染。
	const [promptByAgent, setPromptByAgent] = useState<Record<string, string>>({});
	const livePromptByAgentRef = useRef<Record<string, string>>({});

	// ── 附加图片（按 agent 隔离） ──
	const [attachedImagesByAgent, setAttachedImagesByAgent] = useState<
		Record<string, ImageContent[]>
	>({});
	const attachedImagesByAgentRef = useRef<Record<string, ImageContent[]>>(
		attachedImagesByAgent,
	);
	attachedImagesByAgentRef.current = attachedImagesByAgent;

	// ── 排队中的 prompt（按 agent 隔离） ──
	// ref 是 drain 的同步数据源：React 批量 state 更新期间也能原子 claim，
	// 避免 tool-end 与 idle 两条状态边沿把同一条消息提交两次。
	const [queuedPrompts, setQueuedPrompts] = useState<Record<string, QueuedPrompt[]>>({});
	const queuedPromptsRef = useRef<Record<string, QueuedPrompt[]>>({});

	// ── 终端 Dock 状态（按 owner 隔离：agent 或 project） ──
	const [terminalDockStateByOwner, setTerminalDockStateByOwner] =
		useState<TerminalDockStateByOwner>({});

	// ── 抽屉面板 pinned（按 project 隔离） ──
	const [drawerPinnedByProject, setDrawerPinnedByProject] = useState<
		Record<string, DrawerPanel>
	>({});

	// ── prompt 历史（按 agent 隔离，localStorage 持久化） ──
	const promptHistoryRef = useRef<Record<string, string[]>>({});
	/** 跟踪哪些 agent 已经用会话消息重建过 prompt history；重启/替换时清除标记 */
	const promptHistoryInitedRef = useRef<Set<string>>(new Set());

	// ── 客户端队列 flush 锁（按 agent 隔离） ──
	/** 避免 tool-end 与 idle 并发投递导致同一条 queued prompt 被提交两次 */
	const queueFlushByAgentRef = useRef<Set<string>>(new Set());

	/**
	 * Agent 替换时原子迁移所有 per-agent 状态切片。
	 *
	 * 在 api.agents.onState 回调中调用，替代原来散落在回调里的 7 个独立
	 * setState/migrate 调用。确保 replacement 是一个不可分割的事务。
	 *
	 * @param replacementById 旧 agentId → 新 agentId 的映射（pending 被真实 tab 替换）
	 * @param draftIds 当前存活的 agent id 集合（含 pending），不在集合内的键被裁剪
	 * @param activeProjectIds 当前有活跃 agent 的 project id 集合，用于裁剪 drawerPinned
	 */
	const migratePerAgentState = useCallback(
		(
			replacementById: Map<string, string>,
			draftIds: Set<string>,
			activeProjectIds: Set<string>,
		) => {
			// 仅迁移/裁剪 agent 键；project 键留给 projects+displayAgents effect。
			// 禁止用 agentId 集合 prune project 键（流式 onState 会误关 Dock）。
			setTerminalDockStateByOwner((current) =>
				migrateTerminalDockAgentState(current, replacementById, draftIds),
			);
			setDrawerPinnedByProject((current) =>
				Object.fromEntries(
					Object.entries(current).filter(([projectId]) =>
						activeProjectIds.has(projectId),
					),
				),
			);
			setPromptByAgent((current) => {
				const next = migrateAgentRecord(current, replacementById, draftIds);
				livePromptByAgentRef.current = migrateAgentRecord(
					livePromptByAgentRef.current,
					replacementById,
					draftIds,
				);
				return next;
			});
			setAttachedImagesByAgent((current) =>
				migrateAgentRecord(current, replacementById, draftIds),
			);
			// 发送中的条目必须保持 sending，直到对应 IPC promise 明确完成。
			// 普通 state 推送（包括 sendPrompt 先发出的 running）不能把它重新开放为可撤回。
			const nextQueued = migrateQueuedPrompts(
				queuedPromptsRef.current,
				replacementById,
				draftIds,
			);
			queuedPromptsRef.current = nextQueued;
			setQueuedPrompts(nextQueued);
			// 重启/替换 agent 时清除 prompt history 重建标记，等待 onMessages 重新从会话重建
			for (const [oldAgentId] of replacementById) {
				promptHistoryInitedRef.current.delete(oldAgentId);
				delete promptHistoryRef.current[oldAgentId];
			}
			// 清理已关闭/替换 agent 的 flush 锁
			for (const [oldAgentId] of replacementById) {
				queueFlushByAgentRef.current.delete(oldAgentId);
			}
			for (const agentId of queueFlushByAgentRef.current) {
				if (!draftIds.has(agentId)) queueFlushByAgentRef.current.delete(agentId);
			}
		},
		[],
	);

	/**
	 * createAgent 成功时将 pending 草稿迁移到真实 tab。
	 *
	 * 仅迁移 prompt 和 images——queuedPrompts 在 pending 阶段不入队，
	 * terminalDock/drawerPinned 按 project 隔离不受 agentId 替换影响。
	 */
	const commitPendingToReal = useCallback(
		(pendingTabId: string, tabId: string) => {
			setPromptByAgent((current) => {
				const draft =
					livePromptByAgentRef.current[pendingTabId] ?? current[pendingTabId];
				if (draft == null) return current;
				const next = { ...current, [tabId]: draft };
				delete next[pendingTabId];
				livePromptByAgentRef.current[tabId] = draft;
				delete livePromptByAgentRef.current[pendingTabId];
				return next;
			});
			setAttachedImagesByAgent((current) => {
				const draft = current[pendingTabId];
				if (draft == null) return current;
				const next = { ...current, [tabId]: draft };
				delete next[pendingTabId];
				return next;
			});
		},
		[],
	);

	return {
		// prompt 草稿
		promptByAgent,
		setPromptByAgent,
		livePromptByAgentRef,
		// 附加图片
		attachedImagesByAgent,
		setAttachedImagesByAgent,
		attachedImagesByAgentRef,
		// 排队 prompt
		queuedPrompts,
		setQueuedPrompts,
		queuedPromptsRef,
		// 终端 Dock
		terminalDockStateByOwner,
		setTerminalDockStateByOwner,
		// 抽屉 pinned
		drawerPinnedByProject,
		setDrawerPinnedByProject,
		// prompt 历史
		promptHistoryRef,
		promptHistoryInitedRef,
		// flush 锁
		queueFlushByAgentRef,
		// 原子迁移方法
		migratePerAgentState,
		commitPendingToReal,
	};
}

export type AgentLifecycle = ReturnType<typeof useAgentLifecycle>;
