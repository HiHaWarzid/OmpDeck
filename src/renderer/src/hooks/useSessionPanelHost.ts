/**
 * useSessionPanelHost — 右侧面板（文件 / Git / 浏览器 / 历史会话）的唯一所有者。
 *
 * App 以前自己持有 `drawer` / `drawerCollapsed` / `renderedDrawer` / `expandedDirs` /
 * `sessionsProjectId` 五个 state 加 `lastToolDrawerRef` / `prevDrawerPanelRef` /
 * `drawerUnmountTimerRef` 三个 ref，并用六个 handler + 两个受控 effect 维护规则。
 * 现在规则全在 `sessionPanelState` 的纯归约里，本 hook 只负责：
 *
 * - 落地归约结果（state）、执行归约返回的副作用（持久化 / 刷新）
 * - 与 React 强耦合的两件事：收起动画的延迟卸载 timer、项目切换时的一次性恢复
 *
 * 对外只暴露意图命名的方法与派生视图，调用方拿不到 raw setter。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DrawerPanel } from "../components/app/types";
import {
	DRAWER_ANIMATION_MS,
	EMPTY_PANEL_STATE,
	applyPanelIntent,
	loadExpandedDirs,
	loadStoredPanel,
	saveExpandedDirs,
	saveStoredPanel,
	selectPanelView,
	type PanelEffect,
	type PanelIntent,
	type PanelState,
	type StorageLike,
} from "../components/app/panel/sessionPanelState";

export interface SessionPanelHostOptions {
	activeProjectId: string | undefined;
	/** Git 功能开关；关闭时 Git 面板不可打开/恢复 */
	gitEnabled: boolean;
	/** 旧版按 agent 持久化的键；用于一次性迁移到项目级 */
	legacyAgentIdsFor?: (projectId: string) => string[];
	/** 测试注入；默认用 window.localStorage，不可用时退化为不持久化 */
	storage?: StorageLike | null;
	onRefreshFiles: (projectId: string) => void;
}

/** 右侧面板 host 的对外接口：状态视图 + 意图方法 */
export interface SessionPanelHost {
	/** 当前面板；null = 抽屉关闭 */
	panel: DrawerPanel | null;
	/** 折叠态（Grid 列宽收起） */
	collapsed: boolean;
	/** 当前项目是否钉选本面板 */
	pinned: boolean;
	/** 折叠动画期间仍需渲染的上次内容 */
	contentPanel: DrawerPanel | null;
	sessionsProjectId: string | undefined;
	expandedDirs: Set<string>;

	openPanel: (panel: DrawerPanel) => boolean;
	openSessions: (projectId: string) => void;
	toggleHeader: () => void;
	close: () => void;
	/** 隐藏面板但不落盘：用于面板被弹层替代的临时关闭 */
	hide: () => void;
	collapse: () => void;
	restore: () => void;
	/** 拖拽分隔条导致的收起/展开 */
	resizeCollapse: (collapsed: boolean) => void;
	togglePin: () => void;
	/** 项目被真正删除时调用：清钉选、清会话面板归属、清持久化记录 */
	forgetProject: (projectId: string) => void;

	toggleDirectory: (path: string) => void;
	collapseAllDirectories: () => void;
	replaceExpandedDirs: (dirs: Iterable<string>) => void;
}

function defaultStorage(): StorageLike | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function useSessionPanelHost(
	options: SessionPanelHostOptions,
): SessionPanelHost {
	const storage = options.storage === undefined ? defaultStorage() : options.storage;

	// 归约需要的环境事实（当前项目 / Git 开关）与刷新回调都经 ref 读取：
	// dispatch 必须是引用恒定的函数，否则所有下游 handler 每帧重建。
	const envRef = useRef({
		activeProjectId: options.activeProjectId,
		gitEnabled: options.gitEnabled,
	});
	envRef.current = {
		activeProjectId: options.activeProjectId,
		gitEnabled: options.gitEnabled,
	};
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const [state, setState] = useState<PanelState>(EMPTY_PANEL_STATE);
	// stateRef 是归约的权威输入：同一事件里连续两次 dispatch 时，第二次必须看到第一次的结果，
	// 而 React 的 setState 在闭包里还是旧值。
	const stateRef = useRef(state);
	/** 收起动画期间保留的待卸载内容（不能放进 state，否则关闭后面板永远残留） */
	const [renderedPanel, setRenderedPanel] = useState<DrawerPanel | null>(null);
	const unmountTimerRef = useRef<number | null>(null);
	const [expandedDirs, setExpandedDirsState] = useState<Set<string>>(new Set());

	const runEffects = useCallback(
		(effects: readonly PanelEffect[]) => {
			for (const effect of effects) {
				switch (effect.type) {
					case "persist":
						if (storage) {
							saveStoredPanel(storage, effect.projectId, {
								panel: effect.panel,
								pinned: effect.pinned,
							});
						}
						break;
					case "refresh-files":
						optionsRef.current.onRefreshFiles(effect.projectId);
						break;
				}
			}
		},
		[storage],
	);

	const dispatch = useCallback(
		(intent: PanelIntent) => {
			const result = applyPanelIntent(stateRef.current, intent, envRef.current);
			if (result.state !== stateRef.current) {
				stateRef.current = result.state;
				setState(result.state);
			}
			runEffects(result.effects);
		},
		[runEffects],
	);

	// 打开某项目时恢复其面板与展开目录。项目切换是恢复的唯一触发点：
	// 归约把“没有记录”也当作明确决策（清空面板与钉选），不会串上一个项目的状态。
	useEffect(() => {
		const projectId = options.activeProjectId;
		if (!projectId) {
			dispatch({ type: "project-restored", saved: null });
			setExpandedDirsState(new Set());
			return;
		}
		const legacyAgentIds = optionsRef.current.legacyAgentIdsFor?.(projectId) ?? [];
		dispatch({
			type: "project-restored",
			saved: storage ? loadStoredPanel(storage, projectId, legacyAgentIds) : null,
		});
		setExpandedDirsState(
			storage ? loadExpandedDirs(storage, projectId, legacyAgentIds) : new Set(),
		);
	}, [options.activeProjectId, storage, dispatch]);

	useEffect(() => {
		if (options.gitEnabled) return;
		// 关闭功能时可能还没有任何项目被恢复过（例如启动时就是关闭状态），
		// 内存里看不到 git 面板，但存储里可能留着记录。这里先把它读出来交给归约裁决。
		const projectId = optionsRef.current.activeProjectId;
		const legacyAgentIds = projectId
			? (optionsRef.current.legacyAgentIdsFor?.(projectId) ?? [])
			: [];
		const saved =
			storage && projectId ? loadStoredPanel(storage, projectId, legacyAgentIds) : null;
		dispatch({ type: "git-disabled", saved });
	}, [options.gitEnabled, storage, dispatch]);

	// 收起后延迟卸载内容：与 CSS Grid 列宽过渡耦合，提前卸载会让文字先消失再空壳收回。
	useEffect(() => {
		if (unmountTimerRef.current !== null) {
			window.clearTimeout(unmountTimerRef.current);
			unmountTimerRef.current = null;
		}
		if (state.panel && !state.collapsed) {
			setRenderedPanel(state.panel);
			return;
		}
		if (!renderedPanel) return;
		unmountTimerRef.current = window.setTimeout(() => {
			setRenderedPanel(null);
			unmountTimerRef.current = null;
		}, DRAWER_ANIMATION_MS);
		return () => {
			if (unmountTimerRef.current !== null) {
				window.clearTimeout(unmountTimerRef.current);
				unmountTimerRef.current = null;
			}
		};
	}, [state.panel, state.collapsed, renderedPanel]);

	/**
	 * 派发意图并回报归约是否真的改了状态。
	 * 供调用方判断「面板被钉选/Git 已关闭而拒绝切换」这类守卫是否生效，
	 * 避免在守卫之前执行只该跟着切换走的副作用（如清空 Git 详情快照）。
	 */
	const dispatchAccepted = useCallback(
		(intent: PanelIntent) => {
			const before = stateRef.current;
			dispatch(intent);
			return stateRef.current !== before;
		},
		[dispatch],
	);

	const openPanel = useCallback(
		(panel: DrawerPanel) => dispatchAccepted({ type: "open-panel", panel }),
		[dispatchAccepted],
	);
	const openSessions = useCallback(
		(projectId: string) => dispatch({ type: "open-sessions", projectId }),
		[dispatch],
	);
	const toggleHeader = useCallback(
		() => dispatch({ type: "toggle-header" }),
		[dispatch],
	);
	const close = useCallback(() => dispatch({ type: "close" }), [dispatch]);
	const hide = useCallback(() => dispatch({ type: "hide" }), [dispatch]);
	const collapse = useCallback(() => dispatch({ type: "collapse" }), [dispatch]);
	const restore = useCallback(() => dispatch({ type: "restore" }), [dispatch]);
	const resizeCollapse = useCallback(
		(collapsed: boolean) => dispatch({ type: "resize-collapse", collapsed }),
		[dispatch],
	);
	const togglePin = useCallback(() => dispatch({ type: "toggle-pin" }), [dispatch]);
	const forgetProject = useCallback(
		(projectId: string) => dispatch({ type: "project-removed", projectId }),
		[dispatch],
	);

	const persistDirs = useCallback(
		(dirs: Set<string>) => {
			const projectId = envRef.current.activeProjectId;
			if (storage && projectId) saveExpandedDirs(storage, projectId, dirs);
		},
		[storage],
	);

	const toggleDirectory = useCallback(
		(path: string) => {
			// 文件树默认折叠，只有用户显式展开目录才显示子项，避免大仓库一打开就产生视觉噪音。
			setExpandedDirsState((current) => {
				const next = new Set(current);
				if (next.has(path)) next.delete(path);
				else next.add(path);
				persistDirs(next);
				return next;
			});
		},
		[persistDirs],
	);

	const collapseAllDirectories = useCallback(() => {
		const next = new Set<string>();
		setExpandedDirsState(next);
		persistDirs(next);
	}, [persistDirs]);

	const replaceExpandedDirs = useCallback(
		(dirs: Iterable<string>) => {
			const next = new Set(dirs);
			setExpandedDirsState(next);
			persistDirs(next);
		},
		[persistDirs],
	);

	const view = selectPanelView(state, options.activeProjectId, renderedPanel);

	return {
		panel: view.panel,
		collapsed: view.collapsed,
		pinned: view.pinned,
		contentPanel: view.contentPanel,
		sessionsProjectId: state.sessionsProjectId,
		expandedDirs,

		openPanel,
		openSessions,
		toggleHeader,
		close,
		hide,
		collapse,
		restore,
		resizeCollapse,
		togglePin,
		forgetProject,

		toggleDirectory,
		collapseAllDirectories,
		replaceExpandedDirs,
	};
}
