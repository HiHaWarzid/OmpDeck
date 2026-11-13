/**
 * 右侧面板（文件 / Git / 浏览器）的单一状态机。
 *
 * 以前这条规则分散在 App 的 `openDrawer` / `switchToolDrawer` / `toggleRightDrawer` /
 * `closeDrawer` / `collapseDrawer` / `toggleDrawerPinned` 六个函数、两个受控 effect
 * （钉选强制回到钉选面板、`editor` 兼容迁移）、一个动画卸载 timer 和三处
 * `localStorage` 读写里。同一条规则改动要同时改多处，且规则本身无法在无 React
 * 环境里测试。
 *
 * 现在：纯归约（`applyPanelIntent`）+ 派生视图（`selectPanelView`）承载全部规则与
 * 持久化编解码，React 侧只做 state 落地和 effect 执行。数据获取/持久化以意图列表
 * 返回，调用方不必从 state 变化反推该刷新什么。
 */
import type { DrawerPanel } from "../types";

export type ToolPanel = "files" | "git" | "browser";

/** 右侧工具栏可承载的面板；`editor` 不是独立工具 Tab，已并入文件面板 */
const TOOL_PANELS: readonly ToolPanel[] = ["files", "git", "browser"];

/**
 * 能被读回的面板值（含历史遗留的 `editor`）。
 * 旧记录里的 `sessions` 也在这里识别：历史会话面板已删除，读回时归一成 null，
 * 否则 localStorage 恢复的 drawer 会指向一个没有渲染分支的面板。
 */
const KNOWN_PANELS: readonly string[] = ["files", "browser", "editor", "git"];
const LEGACY_REMOVED_PANELS: readonly string[] = ["sessions"];

export function isToolPanel(
	panel: DrawerPanel | null | undefined,
): panel is ToolPanel {
	return panel != null && TOOL_PANELS.includes(panel as ToolPanel);
}

/**
 * `editor` 是历史面板值：编辑器并入「文件」Tab 后不再作为独立面板存在，
 * 但旧版写在 localStorage 里的记录仍会读到它，所以在这里统一折叠到 files。
 */
export function normalizePanel(panel: string | null | undefined): DrawerPanel | null {
	if (!panel) return null;
	if (panel === "editor") return "files";
	if (LEGACY_REMOVED_PANELS.includes(panel)) return null;
	return KNOWN_PANELS.includes(panel) ? (panel as DrawerPanel) : null;
}

export interface PanelState {
	/** 当前面板；null = 抽屉关闭 */
	panel: DrawerPanel | null;
	/** 折叠（Grid 列宽收起）状态；折叠时保留最后内容做收起动画 */
	collapsed: boolean;
	/** 钉选按项目隔离：钉选后该面板常驻，其他面板入口不生效 */
	pinnedByProject: Record<string, DrawerPanel>;
	/** 标题栏一键展开时恢复的工具 Tab */
	lastToolPanel: ToolPanel;
}

export const EMPTY_PANEL_STATE: PanelState = {
	panel: null,
	collapsed: false,
	pinnedByProject: {},
	lastToolPanel: "files",
};

/** 归约所需的环境事实：全部由调用方提供，纯函数不读全局 */
export interface PanelEnv {
	/** 当前项目 */
	activeProjectId: string | undefined;
	/** Git 功能开关；关闭时 Git 面板不可打开也不可恢复 */
	gitEnabled: boolean;
}

export type PanelIntent =
	| { type: "open-panel"; panel: ToolPanel }
	| { type: "toggle-header" }
	| { type: "close" }
	/** 隐藏但不在持久化里留痕：面板被弹层接管时的临时关闭 */
	| { type: "hide" }
	| { type: "collapse" }
	/** 拖拽分隔条：宽度跌破阈值时等价于收起 */
	| { type: "resize-collapse"; collapsed: boolean }
	| { type: "restore" }
	| { type: "toggle-pin" }
	| { type: "project-restored"; saved: StoredPanelState | null }
	/**
	 * Git 功能被关闭。`saved` 是该项目的持久化记录（由 host 读出）：
	 * 归约是纯函数，不知道自己没被恢复的 git 记录还躺在存储里，无法据此清盘。
	 */
	| { type: "git-disabled"; saved: StoredPanelState | null }
	/**
	 * 项目记录真的消失（删除项目 / 删 worktree / 关掉 worktree 模式都会连带删记录）。
	 * 按**集合**而不是单个 id 表达：调用方只需对比删除前后的项目列表，
	 * 不用各自重算「哪些 id 消失了」——那正是漏掉一条删除路径的成因。
	 */
	| { type: "projects-removed"; projectIds: readonly string[] };

/**
 * 数据获取与持久化需求，由归约结果返回。
 *
 * 以前这两件事在 App 的每个 handler 里各写一遍，钉选强制回到钉选面板那条路径
 * 更是完全绕过 handler（effect 直接改 drawer），因此漏刷新文件树。
 */
export type PanelEffect =
	| { type: "persist"; projectId: string; panel: DrawerPanel | null; pinned: boolean }
	| { type: "refresh-files"; projectId: string }
	/**
	 * 项目已被真正删除：清掉本项目名下**全部**持久化记录（面板 + 展开目录）。
	 * 面板记录用 persist(null) 清，展开目录没有对应的「空值写入」语义，单独成一个副作用，
	 * 否则被删项目的目录键会永远留在 localStorage。
	 */
	| { type: "forget-project"; projectId: string };

export interface PanelResult {
	state: PanelState;
	effects: PanelEffect[];
}

export function pinnedPanelOf(
	state: PanelState,
	projectId: string | undefined,
): DrawerPanel | undefined {
	return projectId ? state.pinnedByProject[projectId] : undefined;
}

function withoutPin(
	pinnedByProject: Record<string, DrawerPanel>,
	projectId: string,
): Record<string, DrawerPanel> {
	if (!(projectId in pinnedByProject)) return pinnedByProject;
	const { [projectId]: _removed, ...rest } = pinnedByProject;
	return rest;
}

/**
 * 展开某个工具面板。始终打开目标面板（“再点一次关闭”只属于已删除的 `openDrawer` 死代码）。
 * 钉选时只允许回到钉选面板；Git 功能关闭时 Git 面板不可打开。
 *
 */
function openPanel(
	state: PanelState,
	target: ToolPanel,
	env: PanelEnv,
): PanelResult {
	if (target === "git" && !env.gitEnabled) return { state, effects: [] };
	const pinned = pinnedPanelOf(state, env.activeProjectId);
	if (pinned && target !== pinned) return { state, effects: [] };

	const projectId = env.activeProjectId;
	const effects: PanelEffect[] = [];
	if (projectId) {
		// 打开文件面板时静默刷新一次目录：上次打开后文件可能已变，否则展示的是旧树。
		if (target === "files") effects.push({ type: "refresh-files", projectId });
		effects.push({ type: "persist", projectId, panel: target, pinned: Boolean(pinned) });
	}

	return {
		state: {
			...state,
			panel: target,
			collapsed: false,
			lastToolPanel: target,
		},
		effects,
	};
}

/**
 * 项目切换后恢复该项目上次的面板。
 *
 * `saved === null` 时必须明确清空：否则上一个项目的面板/钉选会串到没有记录的项目上。
 */
function restoreForProject(
	state: PanelState,
	saved: StoredPanelState | null,
	env: PanelEnv,
): PanelResult {
	const projectId = env.activeProjectId;
	if (!projectId) {
		return { state: { ...state, panel: null, collapsed: false }, effects: [] };
	}

	const panel = normalizePanel(saved?.panel ?? null);
	// Git 面板不能越过功能开关恢复，否则关掉 Git 后仍会展开一个无法操作的面板。
	const restored = panel !== null && (panel !== "git" || env.gitEnabled);
	if (!restored) {
		return {
			state: {
				...state,
				panel: null,
				collapsed: false,
				pinnedByProject: withoutPin(state.pinnedByProject, projectId),
			},
			// 存储里的 git 记录必须一起清掉：只丢掉内存状态的话，开关重新打开后
			// 该项目一切回来就会把面板复活（HEAD 靠每次都重读存储来避免这一点）。
			effects:
				panel === "git"
					? [{ type: "persist", projectId, panel: null, pinned: false }]
					: [],
		};
	}

	const pinnedByProject = saved?.pinned
		? { ...state.pinnedByProject, [projectId]: panel }
		: withoutPin(state.pinnedByProject, projectId);

	return {
		state: {
			...state,
			panel,
			collapsed: false,
			pinnedByProject,
			lastToolPanel: isToolPanel(panel) ? panel : state.lastToolPanel,
		},
		effects: [],
	};
}

/** 单一归约入口：所有面板状态变化都必须经过这里 */
export function applyPanelIntent(
	state: PanelState,
	intent: PanelIntent,
	env: PanelEnv,
): PanelResult {
	switch (intent.type) {
		case "open-panel":
			return openPanel(state, intent.panel, env);

		case "toggle-header": {
			// 关闭态：展开上次工具面板；展开态：折叠。钉选时折叠只收回内容，不关闭面板。
			if (!state.panel) {
				const preferred =
					state.lastToolPanel === "git" && !env.gitEnabled
						? "files"
						: state.lastToolPanel;
				return openPanel(state, preferred, env);
			}
			if (state.collapsed) return { state: { ...state, collapsed: false }, effects: [] };
			if (pinnedPanelOf(state, env.activeProjectId)) return { state, effects: [] };
			return { state: { ...state, collapsed: true }, effects: [] };
		}

		case "close": {
			if (pinnedPanelOf(state, env.activeProjectId)) return { state, effects: [] };
			return {
				state: { ...state, panel: null },
				effects: env.activeProjectId
					? [{ type: "persist", projectId: env.activeProjectId, panel: null, pinned: false }]
					: [],
			};
		}

		case "hide":
			// 钉选面板不让位：旧实现里 setDrawer(null) 会被钉选 effect 立刻拉回，
			// 净效果就是“面板不动”。把这条净效果写进归约，就不需要受控 effect 兜底。
			if (pinnedPanelOf(state, env.activeProjectId)) return { state, effects: [] };
			// 临时让位不落盘：调用方（弹层 diff / 浏览器面板关闭）不希望改持久化偏好。
			return { state: { ...state, panel: null }, effects: [] };

		case "collapse": {
			if (pinnedPanelOf(state, env.activeProjectId)) return { state, effects: [] };
			return { state: { ...state, collapsed: true }, effects: [] };
		}

		case "resize-collapse": {
			// 钉选后拖到阈值以下不能收起：钉选面板的最小宽度已由拖拽逻辑抬高，这里只防御。
			if (pinnedPanelOf(state, env.activeProjectId)) return { state, effects: [] };
			if (state.collapsed === intent.collapsed) return { state, effects: [] };
			return { state: { ...state, collapsed: intent.collapsed }, effects: [] };
		}

		case "restore":
			return { state: { ...state, collapsed: false }, effects: [] };

		case "toggle-pin": {
			const projectId = env.activeProjectId;
			const panel = state.panel;
			if (!projectId || !panel) return { state, effects: [] };
			const willPin = !pinnedPanelOf(state, projectId);
			return {
				state: {
					...state,
					pinnedByProject: willPin
						? { ...state.pinnedByProject, [projectId]: panel }
						: withoutPin(state.pinnedByProject, projectId),
				},
				effects: [{ type: "persist", projectId, panel, pinned: willPin }],
			};
		}

		case "project-restored":
			return restoreForProject(state, intent.saved, env);

		case "git-disabled": {
			// 关掉 Git 功能时同步移除所有项目的 Git 钉选，避免留下点不开的入口。
			const pinnedByProject = Object.fromEntries(
				Object.entries(state.pinnedByProject).filter(([, panel]) => panel !== "git"),
			);
			const closePanel = state.panel === "git";
			const projectId = env.activeProjectId;
			// 内存里没有 git 面板不代表存储里没有：面板可能已被 hide 收起，
			// 也可能因开关关闭而从未被恢复。这两种情况下记录仍会原样留着，
			// 开关重新打开后一切回该项目就复活了一个本该关掉的面板。
			const staleStoredGit = normalizePanel(intent.saved?.panel ?? null) === "git";
			return {
				state: {
					...state,
					panel: closePanel ? null : state.panel,
					pinnedByProject,
					// lastToolPanel 保留 "git"：toggle-header 在功能关闭期间已把它降到 files，
					// 若在这里改写，重新打开 Git 后标题栏按钮就再也不会回到 Git 面板。
				},
				effects:
					(closePanel || staleStoredGit) && projectId
						? [{ type: "persist", projectId, panel: null, pinned: false }]
						: [],
			};
		}

		case "projects-removed": {
			const removed = new Set(intent.projectIds);
			if (removed.size === 0) return { state, effects: [] };
			let pinnedByProject = state.pinnedByProject;
			for (const projectId of removed) {
				pinnedByProject = withoutPin(pinnedByProject, projectId);
			}
			return {
				state: { ...state, pinnedByProject },
				// 项目已删：清掉它的持久化记录，避免同 id 项目回来时带着旧面板与钉选。
				// 用 forget-project 而不是 persist(null)：面板键与展开目录键都要删，
				// 而「写空值」既表达不了展开目录，也会留下一份无主的空记录。
				effects: intent.projectIds.map((projectId) => ({
					type: "forget-project" as const,
					projectId,
				})),
			};
		}
	}
}

/** 渲染视图：折叠动画期间仍要显示上次内容，所以不能直接用 state.panel */
export interface PanelView {
	panel: DrawerPanel | null;
	collapsed: boolean;
	pinned: boolean;
	/** 折叠时为上次内容（收起动画期间），展开时等于 panel */
	contentPanel: DrawerPanel | null;
}

export function selectPanelView(
	state: PanelState,
	activeProjectId: string | undefined,
	renderedPanel: DrawerPanel | null,
): PanelView {
	return {
		panel: state.panel,
		collapsed: state.collapsed,
		pinned: Boolean(pinnedPanelOf(state, activeProjectId)),
		contentPanel: state.panel && !state.collapsed ? state.panel : renderedPanel,
	};
}

/**
 * 收起后延迟卸载内容的等待时长。
 * 与 CSS Grid 列宽过渡耦合：提前卸载会让文字先消失、再空壳收回。
 */
export const DRAWER_ANIMATION_MS = 120;

// ── 持久化编解码（localStorage） ──

export const PROJECT_DRAWER_KEY_PREFIX = "pid:project-drawer:";
export const PROJECT_EXPANDED_DIRS_KEY_PREFIX = "pid:project-expanded-dirs:";
const LEGACY_AGENT_DRAWER_KEY_PREFIX = "pid:agent-drawer:";
const LEGACY_AGENT_EXPANDED_DIRS_KEY_PREFIX = "pid:agent-expanded-dirs:";

/** 面板状态的最小存储契约：只存面板与钉选，折叠等瞬态不落盘 */
export interface StoredPanelState {
	panel: DrawerPanel | null;
	pinned: boolean;
}

/** 最小存储接口：单测注入内存实现，不依赖 DOM localStorage */
export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function readWithLegacyMigration(
	storage: StorageLike,
	key: string,
	legacyPrefix: string,
	legacyOwnerIds: readonly string[],
): string | null {
	const current = storage.getItem(key);
	if (current) return current;
	// 旧版按 agent 持久化；项目级键缺失时把该项目任一 agent 的值提升到项目级并删除旧键，
	// 避免同一份状态继续在多个 agent 之间分叉。
	for (const ownerId of legacyOwnerIds) {
		const legacyKey = legacyPrefix + ownerId;
		const value = storage.getItem(legacyKey);
		if (!value) continue;
		storage.setItem(key, value);
		storage.removeItem(legacyKey);
		return value;
	}
	return null;
}

export function loadStoredPanel(
	storage: StorageLike,
	projectId: string,
	legacyAgentIds: readonly string[] = [],
): StoredPanelState | null {
	try {
		const raw = readWithLegacyMigration(
			storage,
			PROJECT_DRAWER_KEY_PREFIX + projectId,
			LEGACY_AGENT_DRAWER_KEY_PREFIX,
			legacyAgentIds,
		);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as { panel?: unknown; pinned?: unknown };
		if (record.panel !== null && !KNOWN_PANELS.includes(record.panel as string)) {
			return null;
		}
		return {
			panel: normalizePanel(record.panel as string | null),
			pinned: record.pinned === true,
		};
	} catch {
		// localStorage 不可用或内容损坏：按“没有记录”处理，回到默认关闭态。
		return null;
	}
}

export function saveStoredPanel(
	storage: StorageLike,
	projectId: string,
	value: StoredPanelState,
): void {
	try {
		storage.setItem(PROJECT_DRAWER_KEY_PREFIX + projectId, JSON.stringify(value));
	} catch {
		/* localStorage 不可用（隐私模式/配额满）时静默忽略，不能打断面板交互 */
	}
}

export function loadExpandedDirs(
	storage: StorageLike,
	projectId: string,
	legacyAgentIds: readonly string[] = [],
): Set<string> {
	try {
		const raw = readWithLegacyMigration(
			storage,
			PROJECT_EXPANDED_DIRS_KEY_PREFIX + projectId,
			LEGACY_AGENT_EXPANDED_DIRS_KEY_PREFIX,
			legacyAgentIds,
		);
		if (!raw) return new Set();
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((item): item is string => typeof item === "string"));
	} catch {
		return new Set();
	}
}

export function saveExpandedDirs(
	storage: StorageLike,
	projectId: string,
	dirs: Iterable<string>,
): void {
	try {
		storage.setItem(PROJECT_EXPANDED_DIRS_KEY_PREFIX + projectId, JSON.stringify([...dirs]));
	} catch {
		/* ignore */
	}
}

/**
 * 项目被真正删除：删掉它名下全部持久化键。
 * 展开目录没有「写空即清」的语义（空数组与「从未展开过」无法区分），因此必须删除键本身；
 * 面板记录由 persist(null) 覆盖，这里一并删掉以免留下无主记录。
 */
export function forgetStoredProject(storage: StorageLike, projectId: string): void {
	for (const prefix of [PROJECT_DRAWER_KEY_PREFIX, PROJECT_EXPANDED_DIRS_KEY_PREFIX]) {
		try {
			storage.removeItem(prefix + projectId);
		} catch {
			/* localStorage 不可用时静默忽略，不能打断项目删除 */
		}
	}
}
