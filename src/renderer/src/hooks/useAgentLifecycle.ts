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
 * 接口深度：prompt 的 ref/state 双写镜像、images 的 ref 镜像、终端 Dock 的
 * 函数式更新均收敛为意图命名的 op（setLivePrompt / setNativePrompt /
 * stageLivePrompt / getLivePrompt / setAttachedImagesForAgent /
 * setTerminalDockOpen / setTerminalDockCollapsed / pruneTerminalDock），
 * 调用方不感知 ref 与 state 的选择。
 */
import { useCallback, useRef, useState } from "react";
import type { ImageContent } from "../../../shared/types";
import type { QueuedPromptSnapshot } from "../utils/queuedPromptQueue";
import { createQueuedPromptStore, type QueuedPromptStore } from "../utils/queuedPromptStore";
import { usePersistedState } from "./usePersistedState";
import {
	migrateTerminalDockAgentState,
	pruneTerminalDockState,
	setTerminalDockCollapsed as applyTerminalDockCollapsed,
	setTerminalDockOpen as applyTerminalDockOpen,
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

export interface UseAgentLifecycleOptions {
	/**
	 * 草稿文本变化回调（App 注入：同步 hasComposerText / composerBangMode 布尔状态）。
	 * plain 打字只走 live ref 不触发重渲染，程序化设置（建议选择/历史恢复/发送清空）
	 * 与 chips 翻转发起重渲染时由 App 借此刷新按钮态。hook 内部经 ref 调用，
	 * 保证挂载一次的回调闭包也能拿到最新实现。
	 */
	onPromptTextChange?: (text: string) => void;
}

export function useAgentLifecycle(options: UseAgentLifecycleOptions = {}) {
	const onPromptTextChangeRef = useRef(options.onPromptTextChange);
	onPromptTextChangeRef.current = options.onPromptTextChange;

	// ── prompt 草稿（按 agent 隔离） ──
	// promptByAgent 仅驱动 RichInput chip 渲染；livePromptByAgentRef 始终保持最新，
	// 发送路径从 ref 读取，避免每键触发 App 重渲染。
	// ref/state 双写完全由本 hook 的 op 承载：调用方只表达意图
	// （setLivePrompt / setNativePrompt / stageLivePrompt / getLivePrompt）。
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
	// 队列的唯一事实来源是 queuedPromptStore：每个 op（claim/enqueue/resolve/
	// retract/discard/migrate）原子推进 FSM 并恰好回调一次 onUpdate 回填 React state，
	// 不再需要 ref/state 双写；drain 循环从 store.state 同步读取当前队列。
	const [queuedPrompts, setQueuedPrompts] = useState<Record<string, QueuedPrompt[]>>({});
	const queuedPromptStoreRef = useRef<QueuedPromptStore | null>(null);
	if (queuedPromptStoreRef.current === null) {
		// setQueuedPrompts 跨渲染稳定，初始化时捕获即可；store 对象本身引用稳定。
		queuedPromptStoreRef.current = createQueuedPromptStore({}, setQueuedPrompts);
	}
	const queuedPromptStore = queuedPromptStoreRef.current;

	// ── 终端 Dock 状态（按 owner 隔离：agent 或 project） ──
	const [terminalDockStateByOwner, setTerminalDockStateByOwner] =
		useState<TerminalDockStateByOwner>({});

	// ── 抽屉面板 pinned（按 project 隔离） ──
	const [drawerPinnedByProject, setDrawerPinnedByProject] = useState<
		Record<string, DrawerPanel>
	>({});

	// ── prompt 历史（按 agent 隔离，localStorage 持久化） ──
	// 存储键/迁移逻辑沿用 App 原实现（pid:prompt-history，JSON 整表存取）；
	// 读-写-ref 同步由 usePersistedState 统一承载，savePromptHistory/loadPromptHistory
	// 等成对 helper 不再需要。
	const PROMPT_HISTORY_STORAGE_KEY = "pid:prompt-history";
	const [promptHistory, setPromptHistory, promptHistoryRef] =
		usePersistedState<Record<string, string[]>>(PROMPT_HISTORY_STORAGE_KEY, {}, {
			// 历史是 Record<string, string[]>；JSON 解析出非对象（损坏/旧数据）时回退空表。
			parse: (raw) =>
				raw && typeof raw === "object" && !Array.isArray(raw)
					? (raw as Record<string, string[]>)
					: undefined,
		});
	/** 跟踪哪些 agent 已经用会话消息重建过 prompt history；重启/替换时清除标记 */
	const promptHistoryInitedRef = useRef<Set<string>>(new Set());

	// ── 客户端队列 flush 锁（按 agent 隔离） ──
	/** 避免 tool-end 与 idle 并发投递导致同一条 queued prompt 被提交两次 */
	const queueFlushByAgentRef = useRef<Set<string>>(new Set());

	// ===== Per-agent 草稿/状态 ops（ref 与 state 的同步是内部实现细节） =====

	/**
	 * 读取指定 agent 的实时草稿：优先 live ref（始终保持最新），
	 * promptByAgent 兜底（chips 翻转后未写 ref 的瞬态为空）。
	 */
	function getLivePrompt(agentId: string): string {
		return livePromptByAgentRef.current[agentId] ?? promptByAgent[agentId] ?? "";
	}

	/**
	 * 程序化设置草稿（建议选择、历史恢复、发送后清空、失败回填等）：写 live ref +
	 * 同步 state（触发 RichInput chip 渲染与受控检查）+ 通知 App 更新布尔状态。
	 * 返回实际生效的文本，便于调用方继续处理。
	 */
	function setLivePrompt(
		agentId: string,
		value: string | ((current: string) => string),
	): string {
		const previous = livePromptByAgentRef.current[agentId] ?? "";
		const nextValue = typeof value === "function" ? value(previous) : value;
		if (nextValue) livePromptByAgentRef.current[agentId] = nextValue;
		else delete livePromptByAgentRef.current[agentId];
		setPromptByAgent((current) => {
			if (!nextValue) {
				const next = { ...current };
				delete next[agentId];
				return next;
			}
			return { ...current, [agentId]: nextValue };
		});
		onPromptTextChangeRef.current?.(nextValue);
		return nextValue;
	}

	/**
	 * RichInput 原生输入路径：只写 live ref（普通按键不触发 state 更新），
	 * 仅在 chips 形态变化或空/非空翻转时才同步 state（驱动 chip 重渲染）。
	 * chipsKeyOf 由 App 注入（依赖 validCommandNames/validFilePaths/validSessionRefs），
	 * hook 只比较 key 是否变化，不感知 chips 细节。
	 */
	function setNativePrompt(
		agentId: string,
		value: string,
		chipsKeyOf?: (text: string) => string,
	): string {
		if (value) livePromptByAgentRef.current[agentId] = value;
		else delete livePromptByAgentRef.current[agentId];
		const oldValue = promptByAgent[agentId] ?? "";
		const oldChipsKey = chipsKeyOf ? chipsKeyOf(oldValue) : oldValue;
		const newChipsKey = chipsKeyOf ? chipsKeyOf(value) : value;
		const isEmptyChanged = Boolean(oldValue) !== Boolean(value);
		if (oldChipsKey !== newChipsKey || isEmptyChanged) {
			setPromptByAgent((current) => {
				if (!value) {
					const next = { ...current };
					delete next[agentId];
					return next;
				}
				return { ...current, [agentId]: value };
			});
		}
		onPromptTextChangeRef.current?.(value);
		return value;
	}

	/**
	 * 仅更新 live ref（不碰 state、不回调）：发送路径的 DOM 直读同步
	 * 与发送前/失败回填前的临时草稿暂存。text 为空/省略时清除。
	 */
	function stageLivePrompt(agentId: string, text?: string | null) {
		if (text) livePromptByAgentRef.current[agentId] = text;
		else delete livePromptByAgentRef.current[agentId];
	}

	/**
	 * 设置 agent 的附加图片（ref + state 双写镜像；函数式更新以 ref 为基线，
	 * 避免异步粘贴回调读到陈旧闭包）。
	 */
	function setAttachedImagesForAgent(
		agentId: string,
		value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]),
	) {
		const current = attachedImagesByAgentRef.current;
		const previous = current[agentId] ?? [];
		const nextValue = typeof value === "function" ? value(previous) : value;
		const next = { ...current };
		if (nextValue.length === 0) delete next[agentId];
		else next[agentId] = nextValue;
		attachedImagesByAgentRef.current = next;
		setAttachedImagesByAgent(next);
	}

	/** 展开/收起指定 owner（agent 或 project）的终端 Dock。 */
	function setTerminalDockOpen(ownerKey: string, open: boolean) {
		setTerminalDockStateByOwner((current) =>
			applyTerminalDockOpen(current, ownerKey, open),
		);
	}

	/** 折叠/展开指定 owner（agent 或 project）的终端 Dock。 */
	function setTerminalDockCollapsed(ownerKey: string, collapsed: boolean) {
		setTerminalDockStateByOwner((current) =>
			applyTerminalDockCollapsed(current, ownerKey, collapsed),
		);
	}

	/** 按存活 agent/project 集合裁剪终端 Dock 状态（项目/agent 变化 effect 调用）。 */
	function pruneTerminalDock(liveAgentIds: Set<string>, liveProjectIds: Set<string>) {
		setTerminalDockStateByOwner((current) =>
			pruneTerminalDockState(current, liveAgentIds, liveProjectIds),
		);
	}

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
			// 迁移走 store 原子 op：只复制确定未投递的 pending/failed 项，
			// 并按 draftIds 裁剪已关闭 agent 的队列。
			queuedPromptStore.migrate(replacementById, draftIds);
			// 重启/替换 agent 时清除 prompt history 重建标记，等待 onMessages 重新从会话重建
			for (const [oldAgentId] of replacementById) {
				promptHistoryInitedRef.current.delete(oldAgentId);
			}
			// 按 agentId 键存的匿名会话历史随之移除（会话路径键保留）；经 setter 落库。
			setPromptHistory((current) => {
				let next = current;
				for (const [oldAgentId] of replacementById) {
					if (!(oldAgentId in current)) continue;
					if (next === current) next = { ...current };
					delete next[oldAgentId];
				}
				return next;
			});
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
		// prompt 草稿（ref/state 双写收敛为 op + selector）
		getLivePrompt,
		setLivePrompt,
		setNativePrompt,
		stageLivePrompt,
		// 附加图片（ref 镜像为内部实现细节）
		attachedImagesByAgent,
		setAttachedImagesForAgent,
		// 排队 prompt
		queuedPrompts,
		queuedPromptStore,
		// 终端 Dock（状态写入收敛为 op）
		terminalDockStateByOwner,
		setTerminalDockOpen,
		setTerminalDockCollapsed,
		pruneTerminalDock,
		// 抽屉 pinned
		drawerPinnedByProject,
		setDrawerPinnedByProject,
		// prompt 历史
		promptHistory,
		setPromptHistory,
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
