/** 扩展/任务 widget 卡片：渲染扩展上报的 widget 行与折叠状态。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Circle, CircleDot, X } from "lucide-react";
import { t } from "../../../i18n";
import type { WidgetLineItem } from "../../../../../shared/types";
import type { ExtensionWidgetSection, WidgetLine } from "../types";
import { MERGED_TASK_WIDGET_KEY, PLAN_WIDGET_KEY, TODO_WIDGET_KEY } from "./widgetKeys";

/** 单个 extension widget 卡片：可折叠标题栏 + 内容行，支持手动关闭 */
// widgetKey 由扩展定义且跨重启稳定,可按 widgetKey 持久化折叠状态。
const EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX =
	"pid:extension-widget-collapsed:";
/**
 * 渲染 widget 单行内容。
 * - string：老协议，将 ✓ 标记高亮为绿色（兼容旧扩展）
 * - WidgetLineItem：新协议，按 status 渲染三态图标 + content，in_progress 加粗
 */
function renderWidgetLine(line: WidgetLine): ReactNode {
	if (typeof line === "string") {
		const parts = line.split(/(✓)/g);
		if (parts.length <= 1) return line;
		return parts.map((part, i) =>
			part === "✓" ? (
				<span key={i} className="widget-check-done">
					✓
				</span>
			) : (
				part
			),
		);
	}
	// 结构化行：三态图标 + content，与 ToolCard 展开态清单视觉一致
	const icon =
		line.status === "completed" ? (
			<Check size={13} strokeWidth={2.4} className="widget-todo-icon widget-todo-icon--done" aria-label={t("todo.statusCompleted")} />
		) : line.status === "in_progress" ? (
			<CircleDot size={13} strokeWidth={2.2} className="widget-todo-icon widget-todo-icon--active" aria-label={t("todo.statusInProgress")} />
		) : (
			<Circle size={13} strokeWidth={1.8} className="widget-todo-icon widget-todo-icon--pending" aria-label={t("todo.statusPending")} />
		);
	return (
		<span className={`widget-todo-line widget-todo-line--${line.status}`} title={line.content}>
			<span className="widget-todo-line-icon" aria-hidden="true">{icon}</span>
			<span className="widget-todo-line-text">{line.content}</span>
		</span>
	);
}
/** 计算 widget 行数组的进度摘要（已完成/总数）。仅对 WidgetLineItem[] 有意义，string[] 返回 null。 */
function summarizeWidgetLinesProgress(lines: WidgetLine[]): { done: number; total: number } | null {
	const items = lines.filter((l): l is WidgetLineItem => typeof l !== "string");
	if (items.length === 0 || items.length !== lines.length) return null;
	return {
		done: items.filter((i) => i.status === "completed").length,
		total: items.length,
	};
}
export function ExtensionWidgetCard(props: {
	widgetKey: string;
	lines: WidgetLine[];
	onClose: () => void;
	/** 会话唯一标识，用于避免 Todo 等同名 widget 在不同 agent 间共享折叠状态。 */
	sessionIdOrPath?: string;
	/**
	 * 可选分区：Todo + Plan 合并成一张卡时，用分区标题区分来源，
	 * 而不是并排两张卡。有 sections 时优先渲染分区，忽略顶层 lines。
	 */
	sections?: ExtensionWidgetSection[];
	/** 合并卡标题旁的摘要，如 “TODO 3 · Plan 2”；TODO 分区可内部派生进度 */
	meta?: string;
}) {
	const storageKey = props.sessionIdOrPath
		? `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.sessionIdOrPath}:${props.widgetKey}`
		: `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.widgetKey}`;
	// 将非人类可读的 widget key 映射为友好展示名
	const widgetLabel =
		({
			[TODO_WIDGET_KEY]: t("app.widgetTodo"),
			[PLAN_WIDGET_KEY]: t("app.widgetPlan"),
			[MERGED_TASK_WIDGET_KEY]: t("app.widgetTodos"),
		} as Record<string, string>)[props.widgetKey] ?? props.widgetKey;
	const [expanded, setExpanded] = useState(() => {
		if (typeof window === "undefined") return true;
		const stored = localStorage.getItem(storageKey);
		return stored !== null ? stored === "true" : true;
	});
	const prevStorageKeyRef = useRef(storageKey);

	// 切换 agent/session 时只读取对应 key，不把上一 agent 的状态写到新 key。
	useEffect(() => {
		if (prevStorageKeyRef.current === storageKey) return;
		prevStorageKeyRef.current = storageKey;
		const stored = localStorage.getItem(storageKey);
		setExpanded(stored !== null ? stored === "true" : true);
	}, [storageKey]);

	const handleToggleExpanded = useCallback(() => {
		setExpanded((prev) => {
			const next = !prev;
			localStorage.setItem(storageKey, String(next));
			return next;
		});
	}, [storageKey]);

	const sections = props.sections?.filter((s) => s.lines.length > 0) ?? [];
	const useSections = sections.length > 0;
	// 多分区时用 Tab 切换；activeTabIndex 在当前渲染周期持久。
	const [activeTabIndex, setActiveTabIndex] = useState(0);
	const activeSection = sections[activeTabIndex];

	// header 摘要：优先用外部 meta（合并卡的 "TODO 3 · Plan 2"）；
	// 单 TODO 卡时从 lines 内部派生进度 "3/5"，让用户不展开就能看到完成度
	const effectiveMeta = (() => {
		if (props.meta) return props.meta;
		if (props.widgetKey === TODO_WIDGET_KEY) {
			const progress = summarizeWidgetLinesProgress(props.lines);
			if (progress && progress.total > 0) return `${progress.done}/${progress.total}`;
		}
		return undefined;
	})();

	return (
		<div className="extension-widget-card" data-widget-key={props.widgetKey}>
			<div className="extension-widget-card-header">
				<button
					className="extension-widget-card-trigger"
					onClick={handleToggleExpanded}
					aria-expanded={expanded}
				>
					<ChevronDown
						size={14}
						className={`extension-widget-card-chevron${expanded ? " open" : ""}`}
					/>
					<span className="extension-widget-card-title">{widgetLabel}</span>
					{effectiveMeta ? (
						<span className="extension-widget-card-meta">{effectiveMeta}</span>
					) : null}
				</button>
				<button
					className="extension-widget-card-close"
					onClick={(e) => {
						e.stopPropagation();
						props.onClose();
					}}
					title={t("common.close")}
					aria-label={t("common.close")}
				>
					<X size={12} strokeWidth={2} />
				</button>
			</div>
			{expanded && (
				<div className="extension-widget-card-content">
					{/* 多分区：Tab 切换 */}
					{useSections && sections.length > 1 && (
						<div className="extension-widget-tabs" role="tablist">
							{sections.map((section, i) => (
								<button
									key={section.key}
									role="tab"
									aria-selected={i === activeTabIndex}
									className={`extension-widget-tab${i === activeTabIndex ? " active" : ""}`}
									onClick={() => setActiveTabIndex(i)}
								>
									{section.label}
								</button>
							))}
						</div>
					)}
					{/* 分区内容：多分区时只显示当前 tab，单分区直接展开 */}
					{useSections && activeSection
						? activeSection.lines.map((line, index) => (
								<div
									key={`${activeSection.key}-${index}`}
									className="extension-widget-card-line"
								>
									{renderWidgetLine(line)}
								</div>
						  ))
						: props.lines.map((line, index) => (
								<div key={index} className="extension-widget-card-line">
									{renderWidgetLine(line)}
								</div>
						  ))}
				</div>
			)}
		</div>
	);
}
