/** 组件层共享类型：DrawerPanel 等被多个模块引用的形状集中在此，避免模块之间互相 import 组件文件。 */
import type { WidgetLineItem } from "../../../../shared/types";

/** 右侧面板；历史值 "editor" 已并入 files，仅存在于旧版 localStorage 记录里 */
export type DrawerPanel = "files" | "browser" | "git";
/**
 * 一条工具调用的 diff 素材：路径 + 执行前/后的文本。
 *
 * 三个字段都活着：`path` 用于索引与匹配，`originalContent`/`content` 用于打开 diff。
 * 归类时用到的 toolName 与运行状态不保留——没有消费者读它们，留着只会诱使别人去「同步」。
 */
export type DiffTarget = {
	path: string;
	/** 工具执行前的文件原始内容；空串表示新建（write/create 没有执行前内容）。 */
	originalContent: string;
	/** 工具写入/编辑后的新文件内容。 */
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
