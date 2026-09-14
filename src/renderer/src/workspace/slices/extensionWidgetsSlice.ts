import type { WidgetLineItem } from "../../../../shared/types";
import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * extensionWidgets 切片（批次 5d 迁入）：条目（= 活体 agent tab）的扩展 widget 表。
 *
 * 对应 App 原根级 `Record<agentId, Record<widgetKey, WidgetLine[]>>` + 裸 setter：
 * 每次 `setWidget` 都把整张 record 写回根 state，任何 agent 推 widget 都会唤醒
 * 整个 App；**且 agent 关闭后对应键永不裁剪**（同一区域的 dismissal 记录早有裁剪，
 * widget 表却被漏掉，长会话里累积成泄漏）。
 *
 * 迁进 store 后：键 = 条目键，条目 dispose 即整块回收——裁剪路径与 messages /
 * 运行态切片完全一致（成员同步 effect 的 leave），不需要单独写清理逻辑。
 * 读取按 (key, slice) 精确订阅：后台 agent 推 widget 不再唤醒根组件。
 *
 * 行元素类型：与 timeline 侧渲染用的 `WidgetLine` 同构（string 老协议 / WidgetLineItem 新协议），
 * 这里按 workspace 层的分层约定只依赖 shared/types，不反向 import 组件模块。
 */
export type ExtensionWidgetLine = string | WidgetLineItem;

/** widgetKey → 行数组；键不存在 = 该 widget 未设置。 */
export type ExtensionWidgetState = Record<string, ExtensionWidgetLine[]>;

/** 共享空表：条目 join 时的初值，避免每个条目各造一份。冻结防误写。 */
const EMPTY_WIDGET_STATE: ExtensionWidgetState = Object.freeze({});

export type ExtensionWidgetAction = {
	type: "extensionWidgets/set";
	widgetKey: string;
	lines: ExtensionWidgetLine[];
};

export const extensionWidgetActions = {
	/**
	 * 落存一个 widget 的内容。空数组 = 清除该 widget（与原实现的 `delete` 语义一致，
	 * 扩展用空 lines 表达"撤下这块 widget"）。
	 */
	set: (widgetKey: string, lines: ExtensionWidgetLine[]): ExtensionWidgetAction => ({
		type: "extensionWidgets/set",
		widgetKey,
		lines,
	}),
};

export const extensionWidgetsSlice = {
	name: "extensionWidgets",

	seed(_kind: EntryKind): ExtensionWidgetState {
		return EMPTY_WIDGET_STATE;
	},

	reduce(state: ExtensionWidgetState, action: WorkspaceAction): ExtensionWidgetState {
		if (action.type !== "extensionWidgets/set") return state; // 非本切片动作：原引用
		const { widgetKey, lines } = action as Extract<
			ExtensionWidgetAction,
			{ type: "extensionWidgets/set" }
		>;
		if (lines.length === 0) {
			// 无键可删：空转（返回原引用，不唤醒订阅者）
			if (!(widgetKey in state)) return state;
			const next = { ...state };
			delete next[widgetKey];
			return next;
		}
		// 同引用即无变更：扩展重复推送同一数组时不替换、不通知
		if (state[widgetKey] === lines) return state;
		return { ...state, [widgetKey]: lines };
	},
};
