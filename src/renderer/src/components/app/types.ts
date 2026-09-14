/** 组件层共享类型：DrawerPanel 等被多个模块引用的形状集中在此，避免模块之间互相 import 组件文件。 */
import type { WidgetLineItem } from "../../../../shared/types";

export type DrawerPanel = "files" | "sessions" | "browser" | "editor" | "git";
export type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	/** 工具执行前的文件原始内容，用于历史会话恢复时展示差异对比。 */
	originalContent?: string;
	/** 工具写入/编辑后的新文件内容，优先于从磁盘实时读取（历史会话恢复时磁盘可能已变化或文件已删除）。 */
	content?: string;
};
export type DiffFileHandler = (path: string, originalContent?: string, content?: string) => void;
export type ExtensionWidgetSection = {
	/** 原始 widget key，关闭合并卡时用于逐个 dismiss */
	key: string;
	label: string;
	lines: WidgetLine[];
};
/** widget 行元素：兼容老协议的 string 和新协议的 WidgetLineItem（结构化三态）。 */
export type WidgetLine = string | WidgetLineItem;
