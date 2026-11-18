/**
 * 编辑器 tab 的账本：tab 列表、活跃 tab、访问序号是**一个**值。
 *
 * 为什么收成一个 module：这段逻辑此前是 App 里的两份 useState（`editorTabs` /
 * `activeTabId`）加一个 `editorTabAccessSequenceRef`。不变式只有一句——「活跃 tab
 * 必定属于 tab 列表，且淘汰永不删掉刚打开/刚选中的那一个」——却靠在 `setEditorTabs`
 * 的 updater 内部调用 `setActiveTabId()` 维持（渲染期 setState），而 `closeEditorTab`
 * 又从闭包读 `activeTabId`，它喂的 updater 可能更晚才执行，于是「关掉活跃 tab 该选
 * 哪个邻居」取决于点击时的快照而不是执行时的账本。淘汰侧的两份预算（条数 + 正文
 * 字节）与 LRU 挑选同样埋在组件体里，没有一条测试能触达。
 *
 * 收进 module 后，三件事变成结构而非纪律：
 *
 * - 单一值：`{ tabs, activeId, seq }` 一起进出，活跃 tab 不可能指向不在列表里的 id
 *   （`selectTab` 对未知 id 直接不动）；
 * - 淘汰只看账本：`openTab` 在同一处做 LRU 挑选，被保护的 tab 按 id 排除，
 *   预算与条数共用一次循环；
 * - 纯函数：不依赖 React 与 window，无需 UUID 也能测——`id` 由调用方给，
 *   `crypto.randomUUID` 留在 App 侧，模块只负责记录。
 */

/** 同时保留的 tab 条数上限。 */
export const EDITOR_TAB_LIMIT = 5;
/** 正文预算（按 UTF-16 码元 × 2 字节估算）。超过后按 LRU 淘汰，直到回到预算内。 */
export const EDITOR_TAB_TEXT_BUDGET = 24 * 1024 * 1024;

export type EditorTab = {
	id: string;
	filePath: string;
	mode: "view" | "diff";
	originalContent: string;
	modifiedContent?: string;
	/** 历史提交 Diff 必须只读，不能把旧快照误保存回当前工作区。 */
	allowSave: boolean;
	/** 同一文件在不同提交中可以有多个历史 Diff，使用该 key 避免互相覆盖。 */
	tabKey?: string;
	/** 历史 Diff 在标签中追加短 hash，便于区分同一路径的不同提交。 */
	label?: string;
	/** Git Diff 覆盖在 Git drawer 上，不允许切换成 Editor drawer 破坏原面板状态。 */
	preserveDrawer?: boolean;
	/** 仅用于内存淘汰，不改变 tab 的可见排列顺序。 */
	lastAccess: number;
};

export type EditorTabLedger = {
	tabs: readonly EditorTab[];
	activeId: string | null;
	/** 最近一次发出的访问序号；每次打开/切换递增，`lastAccess` 取同一值。 */
	seq: number;
};

export const EMPTY_EDITOR_TAB_LEDGER: EditorTabLedger = { tabs: [], activeId: null, seq: 0 };

/** 一个打开请求：命中 `(filePath, tabKey)` 的既有 tab 会被就地更新而不是新开一条。 */
export type OpenTabRequest = {
	/** 新 tab 的 id。命中既有 tab 时忽略，保留原 id（关闭回调按 id 定位）。 */
	id: string;
	filePath: string;
	mode: EditorTab["mode"];
	originalContent?: string;
	modifiedContent?: string;
	allowSave?: boolean;
	tabKey?: string;
	label?: string;
	preserveDrawer?: boolean;
};

/** 当前活跃 tab；账本是唯一事实源，不存在「id 在、tab 不在」的中间态。 */
export function activeTabOf(ledger: EditorTabLedger): EditorTab | null {
	return ledger.tabs.find((tab) => tab.id === ledger.activeId) ?? null;
}

function textBytes(tab: EditorTab): number {
	return (tab.originalContent.length + (tab.modifiedContent?.length ?? 0)) * 2;
}

/**
 * 按 LRU 淘汰到预算内。
 *
 * `protectedId` 是本次打开/切换的 tab：即使它自己就超预算也保留，否则用户点开的
 * 文件会立刻被自己挤掉。条数下限同样留 1，保证「打开」永远有可见结果。
 */
function trim(tabs: EditorTab[], protectedId: string): readonly EditorTab[] {
	const next = [...tabs];
	let bytes = next.reduce((sum, tab) => sum + textBytes(tab), 0);
	while (next.length > 1 && (next.length > EDITOR_TAB_LIMIT || bytes > EDITOR_TAB_TEXT_BUDGET)) {
		const candidates = next.filter((tab) => tab.id !== protectedId);
		if (candidates.length === 0) break;
		// 相等时取左侧（更早那条），避免同一毫秒内连续打开导致淘汰顺序不稳定。
		const oldest = candidates.reduce((left, right) => (left.lastAccess <= right.lastAccess ? left : right));
		const index = next.findIndex((tab) => tab.id === oldest.id);
		const [removed] = next.splice(index, 1);
		if (removed) bytes -= textBytes(removed);
	}
	return next;
}

/** 打开或切换 tab：命中既有 tab 时就地更新并按该 id 淘汰，否则追加新 tab。 */
export function openTab(ledger: EditorTabLedger, request: OpenTabRequest): EditorTabLedger {
	const seq = ledger.seq + 1;
	const existing = ledger.tabs.find((tab) => tab.filePath === request.filePath && tab.tabKey === request.tabKey);
	if (existing) {
		const updated: EditorTab = {
			...existing,
			mode: request.mode,
			originalContent: request.originalContent ?? "",
			modifiedContent: request.modifiedContent,
			allowSave: request.allowSave ?? true,
			tabKey: request.tabKey,
			label: request.label,
			preserveDrawer: request.preserveDrawer ?? false,
			lastAccess: seq,
		};
		return {
			tabs: trim(
				ledger.tabs.map((tab) => (tab.id === existing.id ? updated : tab)),
				existing.id,
			),
			activeId: existing.id,
			seq,
		};
	}
	const created: EditorTab = {
		id: request.id,
		filePath: request.filePath,
		mode: request.mode,
		originalContent: request.originalContent ?? "",
		modifiedContent: request.modifiedContent,
		allowSave: request.allowSave ?? true,
		tabKey: request.tabKey,
		label: request.label,
		preserveDrawer: request.preserveDrawer ?? false,
		lastAccess: seq,
	};
	return { tabs: trim([...ledger.tabs, created], created.id), activeId: created.id, seq };
}

/** 切换活跃 tab。未知 id 视为无效点击，账本原样返回。 */
export function selectTab(ledger: EditorTabLedger, tabId: string): EditorTabLedger {
	if (!ledger.tabs.some((tab) => tab.id === tabId)) return ledger;
	const seq = ledger.seq + 1;
	return {
		tabs: ledger.tabs.map((tab) => (tab.id === tabId ? { ...tab, lastAccess: seq } : tab)),
		activeId: tabId,
		seq,
	};
}

/**
 * 关闭 tab：关掉活跃 tab 时选它在**剩余列表里的同位置**邻居（右移一位取最近的），
 * 关掉最后一个时活跃 tab 归空，让上层收起编辑器。
 */
export function closeTab(ledger: EditorTabLedger, tabId: string): EditorTabLedger {
	const index = ledger.tabs.findIndex((tab) => tab.id === tabId);
	if (index < 0) return ledger;
	const tabs = ledger.tabs.filter((tab) => tab.id !== tabId);
	if (tabs.length === 0) return { tabs, activeId: null, seq: ledger.seq };
	if (tabId !== ledger.activeId) return { tabs, activeId: ledger.activeId, seq: ledger.seq };
	const neighbor = tabs[Math.min(index, tabs.length - 1)];
	return { tabs, activeId: neighbor.id, seq: ledger.seq };
}

/** 清空账本（返回文件列表、关闭弹窗、切换项目等「整块退出编辑器」的入口）。 */
export function resetTabs(): EditorTabLedger {
	return EMPTY_EDITOR_TAB_LEDGER;
}
