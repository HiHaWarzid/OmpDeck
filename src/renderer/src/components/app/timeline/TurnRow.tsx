/** 单轮时间线行与用户气泡：轮次内的工具/文本编排、复制与图片预览。 */
import {
	Fragment,
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";
import { toBlob } from "html-to-image";
import {
	type ToolGroupItem,
	type MessageItem,
	type ThinkingGroupItem,
	type AgentRunItem,
	sameAgentRunForRender,
	sameChatMessageForRender,
} from "../AppUtils";
import { computeThinkingTiming } from "../../../utils/thinkingTiming";
import {
	Check,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	X,
	Copy,
	Trash,
	Share,
	SquarePen,
	UserPen,
	GitFork,
} from "lucide-react";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { writeClipboard } from "../../../utils/clipboard";
import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import { parseRichInputChips, unwrapFileChipPath } from "../RichInput";
import { formatDuration, formatTime, stripAnsi, stripMarkdown, stripThinkingTags } from "../format";
import { AssistantText } from "./AssistantText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolGroupCard } from "../tools/ToolCards";
import type { DiffFileHandler } from "../types";

async function copyElementAsPng(element: HTMLElement) {
	// 截图复制依赖浏览器 ClipboardItem PNG 支持；失败时由调用方提示/回退，不影响文本复制。
	// 使用 toBlob 而非 toPng+fetch 避免 CSP 拒绝连接 data: URL。
	// 克隆节点 + 内边距 + 临时注入 body 的方式与分享为图片（handleMultiSelectCopy）保持一致，
	// 避免直接截图导致图片紧贴内容边缘、缺少留白。
	const clone = element.cloneNode(true) as HTMLElement;
	clone.style.padding = "24px";
	clone.style.background =
		getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
	// 将 clone 插入到原元素旁边，确保 CSS 样式正确继承（父层选择器、rem 等）
	if (element.parentElement) {
		element.parentElement.insertBefore(clone, element.nextSibling);
	}
	let blob: Blob | null = null;
	try {
		blob = await toBlob(clone, {
			cacheBust: true,
			pixelRatio: Math.min(2, window.devicePixelRatio || 1),
			backgroundColor:
				getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || undefined,
			filter: (node) =>
				!(node instanceof HTMLElement) ||
				(!node.classList.contains("turn-row-actions") &&
					!node.classList.contains("user-turn-actions") &&
					!node.classList.contains("copy-menu-popover")),
		});
	} finally {
		clone.remove();
	}
	if (!blob) return;
	await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}
function CopyMenu(props: {
	/** 纯文本内容按需派生（打开菜单/点击复制时才展开 markdown 语法），
	 *  避免流式期间每个 delta 都对增长中的正文跑一遍 remove-markdown。 */
	deriveText: () => string;
	markdown: string;
	targetRef: React.RefObject<HTMLElement | null>;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const closeTimerRef = useRef<number | null>(null);
	const clearCloseTimer = () => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};
	const scheduleClose = () => {
		// 操作栏由 hover/focus 控制显隐；离开后主动收起菜单，避免下次 hover 时复用旧 open 状态。
		clearCloseTimer();
		closeTimerRef.current = window.setTimeout(() => {
			setOpen(false);
			closeTimerRef.current = null;
		}, 180);
	};
	useEffect(() => clearCloseTimer, []);
	const copy = async (kind: "text" | "markdown" | "image") => {
		try {
			if (kind === "text") await writeClipboard(props.deriveText());
			if (kind === "markdown") await writeClipboard(props.markdown);
			if (kind === "image" && props.targetRef.current) await copyElementAsPng(props.targetRef.current);
			setCopied(kind);
			setOpen(false);
			showNotice(t("copy.success"), 1200);
			window.setTimeout(() => setCopied(null), 1800);
		} catch {
			setCopied(null);
			showNotice(t("copy.failed"), 2000);
		}
	};
	const toggleOpen = () => {
		clearCloseTimer();
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect) {
			setMenuStyle({
				position: "fixed",
				top: rect.bottom + 4,
				left: Math.min(window.innerWidth - 156, Math.max(8, rect.right - 148)),
			});
		}
		setOpen((value) => !value);
	};
	return (
		<div
			className={`copy-menu ${props.className ?? ""}`}
			onPointerEnter={clearCloseTimer}
			onPointerLeave={scheduleClose}
		>
			<button
				ref={triggerRef}
				className="copy-menu-trigger"
				type="button"
				onClick={toggleOpen}
				aria-expanded={open}
				title={t("common.copy")}
			>
				{copied ? <Check size={14} /> : <Copy size={14} />}
			</button>
			{open && (
				<div className="copy-menu-popover" style={menuStyle}>
					<button type="button" onClick={() => void copy("text")}>{t("copy.asText")}</button>
					<button type="button" onClick={() => void copy("markdown")}>{t("copy.asMarkdown")}</button>
					<button type="button" onClick={() => void copy("image")}>{t("copy.asImage")}</button>
				</div>
			)}
		</div>
	);
}
/**
 * 消息净化结果按对象身份缓存。
 *
 * 流式期间已定稿消息按引用复用（增量只替换尾部消息对象），若每次渲染都对整轮消息
 * 重跑 stripAnsi/stripThinkingTags，代价会随回答长度逐 delta 叠加成 O(n²)。
 * 用 WeakMap 以消息对象为键：对象被替换即自然失效，无需手动清理，也不阻止 GC。
 */
const sanitizedMessageTextCache = new WeakMap<ChatMessage, string>();
function sanitizedMessageText(message: ChatMessage): string {
	const cached = sanitizedMessageTextCache.get(message);
	if (cached !== undefined) return cached;
	const next = stripThinkingTags(stripAnsi(message.text)).trim();
	sanitizedMessageTextCache.set(message, next);
	return next;
}
/**
 * 从用户消息文本中提取 pi 展开后的 <skill name="..." location="...">...</skill> 块。
 * pi 在发送 /skill:name 时会把 skill 内容展开成该 XML 块注入用户消息，
 * 这里在展示层把它们识别出来，渲染成 skill 徽标，并把原始 XML 从正文里剥除。
 * 返回 { skills, text }：skills 为 skill 名列表，text 为移除 skill 块后的正文。
 */
function extractSkillBlocks(text: string): { skills: string[]; text: string } {
	const skills: string[] = [];
	// 非贪婪匹配 skill 块；name/location 属性顺序与引号样式兼容 pi 实际输出
	const re = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/gi;
	const cleaned = text.replace(re, (_m, name: string) => {
		if (name) skills.push(name);
		return "";
	});
	return { skills, text: cleaned.trim() };
}
/** 将消息文本中的 @path / /command 渲染为行内 chip（聊天区展示用，与输入框 chip 视觉一致）。
 * 可通过 onOpenFile 回调使 chip 可点击跳转。 */
function renderChipText(text: string, onOpenFile?: (path: string) => void, validCommandNames?: Set<string>, validFilePaths?: Set<string>): ReactNode[] {
	const chips = parseRichInputChips(text, validCommandNames, validFilePaths);
	if (chips.length === 0) return [text];
	const nodes: ReactNode[] = [];
	let cursor = 0;
	for (const chip of chips) {
		if (chip.start > cursor) {
			nodes.push(text.slice(cursor, chip.start));
		}
		const clickable = onOpenFile && chip.kind === "file";
		nodes.push(
			<span
				key={`chip-${chip.start}`}
				className={`input-chip input-chip--${chip.kind}${clickable ? " clickable" : ""}`}
				data-type={chip.kind}
				data-raw={chip.raw}
				title={chip.raw}
				onClick={clickable ? () => onOpenFile(unwrapFileChipPath(chip.raw)) : undefined}
			>
				<span className="input-chip__icon">
					{chip.kind === "file" ? "@" : "/"}
				</span>
				<span className="input-chip__label">{chip.label}</span>
			</span>,
		);
		cursor = chip.end;
	}
	if (cursor < text.length) {
		nodes.push(text.slice(cursor));
	}
	return nodes;
}
/** 一轮 AI 回答的扁平容器：左侧竖线聚合，内含思考/工具/正文/文件摘要。
 *  替代旧的 AgentRun + ChatBubble 助手分支 + RunActivity 三层结构。 */
export const TurnRow = memo(function TurnRow(props: {
	run: AgentRunItem;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	isStreaming?: boolean;
	/** 流式思考的开始时间（App 侧 streamingThinkingStartedAt[agentId]）。双来源优先级：
	 *  message.thinkingStartedAt（消息落库，最精确）→ 本 prop（agent 级流式开始）→ run.startedAt。 */
	streamingThinkingStartedAt?: number;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
	onDeleteMessage?: (messageId: string) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	/** Agent 正在处理请求或流式输出中时禁用编辑/删除等操作按钮 */
	agentRunning?: boolean;
	/** 打开多选分享弹框 */
	onEnterMultiSelect?: () => void;
}) {
	const { run } = props;
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 激活编辑时自动滚动到编辑区（避免 textarea 超出可视区域）
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);
	const isComplete = run.endedAt > 0;
	const duration = isComplete && run.startedAt > 0 ? run.endedAt - run.startedAt : 0;
	const showDuration = isComplete && duration > 0;

	// 收集本轮所有 assistant 消息（按 run.items 的时序保持原始顺序）
	const assistantMessages = useMemo(
		() =>
			run.items.filter(
				(item): item is MessageItem =>
					item.kind === "message" && item.message.role === "assistant",
			),
		[run.items],
	);
	const allImages = useMemo(() => {
		const images: ImageContent[] = [];
		for (const item of assistantMessages) {
			if (item.message.images) images.push(...item.message.images);
		}
		return images;
	}, [assistantMessages]);
	// 合并后的完整文本仅用于编辑/复制/删除等操作栏，不用于展示
	const mergedText = assistantMessages
		.map((item) => sanitizedMessageText(item.message))
		.filter(Boolean)
		.join("\n\n");

	/** 找出 message 在 run.items 中的位置，分离「执行过程」（最后一条 assistant message 之前的所有条目）。
	 *  执行过程包含 thinking-group、tool-group 以及中间穿插的 assistant 消息，
	 *  默认折叠并以概要形式展示，用户可展开查看细节。最后一条 assistant 消息作为最终回答始终可见。 */
	const lastAssistantIndex = (() => {
		for (let i = run.items.length - 1; i >= 0; i--) {
			if (run.items[i].kind === "message" && (run.items[i] as MessageItem).message.role === "assistant") {
				return i;
			}
		}
		return -1;
	})();
	// 执行过程 = 除最终回答外的所有条目（最终回答在折叠区外始终可见，不能再进折叠详情）。
	// 边界：lastAssistantIndex === 0（如「思考+直接回答」的无工具回合）时，若取 run.items 全量，
	// 最终回答会被同时渲染进折叠详情和下方正文，展开后出现两份；filter 排除它本身，
	// 同时保留最终回答之后可能存在的尾部 tool/thinking 条目（slice 方案会将其丢弃）。
	const executionItems = lastAssistantIndex >= 0
		? (run.items as (ThinkingGroupItem | ToolGroupItem | MessageItem)[]).filter(
			(_, index) => index !== lastAssistantIndex,
		)
		: (run.items as (ThinkingGroupItem | ToolGroupItem | MessageItem)[]);
	const finalMessageItem = lastAssistantIndex >= 0 ? (run.items[lastAssistantIndex] as MessageItem) : null;

	const toolCount = executionItems.filter((i) => i.kind === "tool-group").length;
	const thinkingCount = executionItems.filter((i) => i.kind === "thinking-group").length;
	const interReplyCount = executionItems.filter(
		(i) => i.kind === "message" && i.message.role === "assistant",
	).length;

	// 最终回答文本，用于判断自然完成 vs 手动中断。
	// 提前定义以在 useEffect 中使用（auto-collapse 逻辑需要判断是否有最终文本回答）。
	const finalTxt = finalMessageItem
		? sanitizedMessageText(finalMessageItem.message)
		: "";

	// 执行过程默认展开（agent 处理中），输出完毕后自动折叠。
	// 使用 agentRunning 而非 isStreaming：后者在多步工具调用之间会短暂 flicker 为 false，
	// 导致过早折叠工具输出；agentRunning 在整个 agent 处理生命周期内始终为 true。
	const [executionExpanded, setExecutionExpanded] = useState(
		!isComplete || Boolean(props.agentRunning),
	);
	useEffect(() => {
		if (props.agentRunning) {
			setExecutionExpanded(true);
		} else if (isComplete) {
			setExecutionExpanded(false);
		}
	}, [isComplete, props.agentRunning]);

	const rowRef = useRef<HTMLElement | null>(null);
	// 最终回答的思考文本与标记，在 useMemo 之前提取（useMemo 本身是 hook，
	// 必须放在所有 early return 之前，否则 agentRunning 切换到 true 时
	// 会因少执行一个 hook 而触发 "Rendered fewer hooks" 报错。）
	const finalThinkingTxt = finalMessageItem?.message.thinking?.trim()
		? stripAnsi(finalMessageItem.message.thinking)
		: null;
	const hasFinalThinking = Boolean(finalThinkingTxt && props.showThinking);
	// 将最终消息的思考插入执行过程（放在工具之前），确保时序正确：思考→工具→文本
	const executionItemsWithFinalThinking = useMemo(() => {
		const items = [...executionItems];
		if (hasFinalThinking && finalThinkingTxt && props.showThinking) {
			// 单一计时链（computeThinkingTiming）：startedAt 为 message.thinkingStartedAt →
			// streamingThinkingStartedAt → run.startedAt，endedAt 为 thinkingEndedAt →
			// timestamp；run.endedAt 是模块签名外的显式尾部回退（见 thinkingTiming 变化报告）。
			const timing = computeThinkingTiming(
				finalMessageItem?.message,
				props.streamingThinkingStartedAt,
				run.startedAt,
				Date.now(),
			);
			const thinkingItem: ThinkingGroupItem = {
				kind: "thinking-group",
				id: `final-thinking-${finalMessageItem?.message.id ?? run.id}`,
				messages: finalMessageItem?.message ? [finalMessageItem.message] : [],
				text: finalThinkingTxt,
				startedAt: timing.startedAt ?? run.startedAt,
				endedAt: timing.endedAt ?? run.endedAt,
			};
			items.push(thinkingItem);
		}
		return items;
	}, [executionItems, hasFinalThinking, finalThinkingTxt, props.showThinking,
		props.streamingThinkingStartedAt,
		finalMessageItem?.message.id, finalMessageItem?.message.timestamp,
		finalMessageItem?.message, run.id, run.startedAt, run.endedAt,
	]);

	// 统计（在 early return 之前，确保 hook 数量一致）
	const totalThinkingCount = executionItemsWithFinalThinking.filter((i) => i.kind === "thinking-group").length;
	const totalToolCount = executionItemsWithFinalThinking.filter((i) => i.kind === "tool-group").length;
	const totalInterReplyCount = executionItemsWithFinalThinking.filter(
		(i) => i.kind === "message" && i.message.role === "assistant",
	).length;
	const summaryParts: string[] = [];
	if (totalToolCount > 0) summaryParts.push(`${totalToolCount}个工具`);
	if (totalThinkingCount > 0) summaryParts.push(`${totalThinkingCount}次思考`);
	if (totalInterReplyCount > 0) summaryParts.push(`${totalInterReplyCount}次回答`);
	const summaryText = summaryParts.length > 0 ? `执行过程: ${summaryParts.join(" ")}` : "";
	const hasFoldableContent = executionItemsWithFinalThinking.length > 0 || run.items.some((i) => i.kind !== "message");

	// 本轮没有任何可渲染内容时不输出空容器
	const hasContent =
		assistantMessages.length > 0 ||
		run.items.some(item => item.kind === "thinking-group") ||
		run.items.some(item => item.kind === "tool-group") ||
		allImages.length > 0;
	if (!hasContent) return null;

	/** 渲染执行过程中的一个条目（thinking-group / tool-group / assistant message）。 */
	const renderExecutionItem = (item: ThinkingGroupItem | ToolGroupItem | MessageItem) => {
		if (item.kind === "thinking-group") {
			if (!props.showThinking) return null;
			return (
				<ThinkingBlock
					key={item.id}
					text={item.text}
					startedAt={item.startedAt}
					endedAt={item.endedAt}
					showThinking={props.showThinking}
				/>
			);
		}
		if (item.kind === "tool-group") {
			return <ToolGroupCard key={item.id} group={item} onDiffFile={props.onDiffFile} />;
		}
		if (item.kind === "message" && item.message.role === "assistant") {
			const txt = sanitizedMessageText(item.message);
			if (!txt) return null;
			return (
				<AssistantText
					key={item.message.id}
					text={txt}
					images={allImages}
					onPreviewImage={props.onPreviewImage}
					onOpenExternal={props.onOpenExternal}
					onOpenFile={props.onOpenFile}
					isStreaming={props.isStreaming ?? false}
				/>
			);
		}
		return null;
	};

	// Streaming 模式：agent 仍在执行中，按时间顺序渲染所有条目，
	// 不把最后一条 assistant 回答分离到最底部，避免新的思考和工具出现在已回答文本之上。
	if (props.agentRunning) {
		const allItems = run.items as (ThinkingGroupItem | ToolGroupItem | MessageItem)[];
		// 对最后一条 assistant 消息提取 thinking 作为独立的 thinking-group，
		// 在时间线上插在回答文本之前（与已完成回合的 finalThinking 逻辑一致）。
		const chronologicalItems = (() => {
			if (allItems.length === 0) return allItems;
			const last = allItems[allItems.length - 1];
			if (
				last?.kind === "message" &&
				last.message.role === "assistant" &&
				props.showThinking &&
				last.message.thinking?.trim()
			) {
				const streamingThinkingTiming = computeThinkingTiming(
					last.message,
					props.streamingThinkingStartedAt,
					run.startedAt,
					Date.now(),
				);
				const thinkingBlock: ThinkingGroupItem = {
					kind: "thinking-group",
					id: `streaming-thinking-${last.message.id}`,
					messages: [last.message],
					text: stripAnsi(last.message.thinking),
					// 与已完成分支同一计时链：computeThinkingTiming + run.endedAt 显式尾部回退。
					startedAt: streamingThinkingTiming.startedAt ?? run.startedAt,
					endedAt: streamingThinkingTiming.endedAt ?? run.endedAt,
				};
				return [...allItems.slice(0, -1), thinkingBlock, last];
			}
			return allItems;
		})();

		return (
			<article ref={rowRef} className="turn-row" data-message-id={run.id}>
				<div className="turn-row-body">
					<div className="turn-row-meta">
						<span className="turn-row-agent">omp</span>
						<time>{formatTime(run.endedAt)}</time>
					</div>
					{/* 按时间顺序渲染所有条目，最新的活动在底部 */}
					{chronologicalItems.map(renderExecutionItem)}
				</div>
			</article>
		);
	}



	// 没有助手指令消息的情况：整轮只含工具/思考，用执行过程折叠渲染
	if (lastAssistantIndex === -1) {
		return (
			<article ref={rowRef} className="turn-row" data-message-id={run.id}>
				<div className="turn-row-body">
					<div className="turn-row-meta">
						<span className="turn-row-agent">omp</span>
						<time>{formatTime(run.endedAt)}</time>
						{showDuration && (
							<span className="turn-row-duration">{formatDuration(duration)}</span>
						)}
					</div>
					{/* 执行过程概要（含工具/思考），默认折叠 */}
					{hasFoldableContent && summaryText && (
						<div className="execution-summary">
							<button
								type="button"
								className="execution-summary-toggle"
								onClick={() => setExecutionExpanded((prev) => !prev)}
								aria-expanded={executionExpanded}
								title={executionExpanded ? t("common.collapse") : t("common.expand")}
							>
								{executionExpanded ? (
									<ChevronDown size={14} aria-hidden="true" />
								) : (
									<ChevronRight size={14} aria-hidden="true" />
								)}
								<span>{summaryText}</span>
							</button>
							{executionExpanded && (
								<div className="execution-summary-details">
									{executionItemsWithFinalThinking.map(renderExecutionItem)}
									<button
										type="button"
										className="execution-summary-collapse"
										onClick={() => setExecutionExpanded(false)}
										title={t("common.collapse")}
									>
										<ChevronUp size={12} aria-hidden="true" />
										<span>{t("common.collapse")}</span>
									</button>
								</div>
							)}
						</div>
					)}
				</div>
			</article>
		);
	}

	return (
		<article ref={rowRef} className="turn-row" data-message-id={run.id}>
			<div className="turn-row-body">
				<div className="turn-row-meta">
					<span className="turn-row-agent">omp</span>
					<time>{formatTime(run.endedAt)}</time>
					{showDuration && (
						<span className="turn-row-duration">{formatDuration(duration)}</span>
					)}
				</div>
				{/* 执行过程概要（含工具/思考/中间回答），置于最终回答之前以保持调用顺序。 */}
				{hasFoldableContent && summaryText && (
					<div className="execution-summary">
						<button
							type="button"
							className="execution-summary-toggle"
							onClick={() => setExecutionExpanded((prev) => !prev)}
							aria-expanded={executionExpanded}
							title={executionExpanded ? t("common.collapse") : t("common.expand")}
						>
							{executionExpanded ? (
								<ChevronDown size={14} aria-hidden="true" />
							) : (
								<ChevronRight size={14} aria-hidden="true" />
							)}
							<span>{summaryText}</span>
						</button>
						{executionExpanded && (
							<div className="execution-summary-details">
								{executionItemsWithFinalThinking.map(renderExecutionItem)}
								<button
									type="button"
									className="execution-summary-collapse"
									onClick={() => setExecutionExpanded(false)}
									title={t("common.collapse")}
								>
									<ChevronUp size={12} aria-hidden="true" />
									<span>{t("common.collapse")}</span>
								</button>
							</div>
						)}
					</div>
				)}
				{/* 最终回答（始终可见）；最终思考已融入执行过程折叠区 */}
				{finalMessageItem && (
					<Fragment key={finalMessageItem.message.id}>
						{editing ? (
							<div className="turn-row-edit-area" ref={editAreaRef}>
								<div className="edit-area-indicator">{t("common.edit")}</div>
								<textarea
									className="turn-row-edit-textarea"
									value={editText}
									onChange={(e) => setEditText(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
											e.preventDefault();
											const targetId = assistantMessages.at(-1)?.message.id;
											if (targetId && props.onEditMessage) {
												props.onEditMessage(targetId, editText);
												setEditing(false);
											}
										}
										if (e.key === "Escape") setEditing(false);
									}}
									autoFocus
								/>
								<div className="turn-row-edit-actions">
									<button className="turn-row-edit-btn primary" onClick={() => {
										const targetId = assistantMessages.at(-1)?.message.id;
										if (targetId && props.onEditMessage) {
											props.onEditMessage(targetId, editText);
											setEditing(false);
										}
									}}>{t("common.save")}</button>
									<button className="turn-row-edit-btn" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
								</div>
							</div>
						) : finalTxt ? (
							<AssistantText
								text={finalTxt}
								images={allImages}
								onPreviewImage={props.onPreviewImage}
								onOpenExternal={props.onOpenExternal}
								onOpenFile={props.onOpenFile}
								isStreaming={props.isStreaming ?? false}
							/>
						) : null}
					</Fragment>
				)}
				{/* 操作栏 */}
				{mergedText && !editing && (
					<div className="turn-row-actions">
						<CopyMenu deriveText={() => stripMarkdown(mergedText)} markdown={mergedText} targetRef={rowRef} />
						<button
							className="turn-row-action-btn"
							onClick={props.onEnterMultiSelect}
						title={t("app.multiSelectEnter")}
						>
							<Share size={14} />
						</button>
						{!props.isStreaming && !props.agentRunning && assistantMessages.at(-1)?.message.id && (
							<>
								<button
									className="turn-row-action-btn"
									onClick={() => {
										setEditText(mergedText);
										setEditing(true);
									}}
								title={t("common.edit")}
								>
									<SquarePen size={14} />
								</button>
								<button
									className="turn-row-action-btn"
									onClick={() => {
										const targetId = assistantMessages.at(-1)?.message.id;
										if (targetId && props.onDeleteMessage) {
											props.onDeleteMessage(targetId);
										}
									}}
									title={t("common.delete")}
								>
									<Trash size={14} />
								</button>
							</>
						)}
					</div>
				)}
			</div>
		</article>
	);
}, (previous, next) =>
	sameAgentRunForRender(previous.run, next.run) &&
	previous.showThinking === next.showThinking &&
	previous.isStreaming === next.isStreaming &&
	previous.agentRunning === next.agentRunning &&
	previous.streamingThinkingStartedAt === next.streamingThinkingStartedAt,
);
/** 用户消息：右对齐气泡 + 附件 + hover 显隐操作栏（复制/编辑/删除/重发/修改输入框）。
 * 编辑分两种：原地编辑（修改 JSONL + 重载会话）和修改输入框（放回 composer 不自动发送）。 */
export const UserBubble = memo(function UserBubble(props: {
	message: ChatMessage;
	onPreviewImage: (image: ImageContent) => void;
	onOpenFile?: (path: string) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	/** 从该用户消息 fork 新会话；需 message.meta.entryId，忙碌时不展示入口 */
	onForkMessage?: (message: ChatMessage) => void;
	validCommandNames?: Set<string>;
	validFilePaths?: Set<string>;
	/** Agent 正在处理请求或流式输出中时禁用编辑/删除等操作按钮 */
	agentRunning?: boolean;
	/** fork 进行中：仅当前消息禁用按钮，避免连点重复 fork */
	forking?: boolean;
	/** 打开多选分享弹框 */
	onEnterMultiSelect?: () => void;
}) {
	const { message } = props;
	// 空闲时始终展示 fork 入口；entryId 解析放到点击时做（meta 缺失时会走 getForkMessages 回退）。
	// 忙碌中与编辑/删除一致隐藏，避免半完成回合上 fork。
	const canFork = Boolean(props.onForkMessage) && !props.agentRunning;
	const rowRef = useRef<HTMLElement | null>(null);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 激活编辑时自动滚动到编辑区
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);
	// 提取 pi 展开后的 <skill> 块：渲染为 skill 徽标，并从正文里剥除 XML
	const { skills, text: bodyText } = extractSkillBlocks(stripAnsi(message.text));
	const cleanText = bodyText;
	// 投递策略标签：steer(下次调用前插入) / followUp(停止后排队)
	const deliveryBehavior = message.meta?.streamingBehavior as
		| "steer"
		| "followUp"
		| undefined;
	const deliveryLabel =
		deliveryBehavior === "steer"
			? t("app.messageDeliverySteer")
			: deliveryBehavior === "followUp"
				? t("app.messageDeliveryFollowUp")
				: null;
	/** 原地编辑不影响输入框；先提交给确认弹窗。 */
	const handleSaveEdit = () => {
		if (props.onEditMessage && editText.trim()) {
			props.onEditMessage(message.id, editText);
			setEditing(false);
		}
	};
	/** 编辑后重发：放回 composer 输入框，由用户自行修改后发送。 */
	const handleEditAndResend = () => {
		document.querySelector<HTMLTextAreaElement>(".composer-box textarea")?.focus();
		window.dispatchEvent(
			new CustomEvent("user-message-edit", { detail: { text: message.text } }),
		);
	};
	return (
		<article ref={rowRef} className="user-turn" data-message-id={message.id}>
			{skills.length > 0 && (
				<div className="user-turn-skills">
					{skills.map((name) => (
						<span key={name} className="user-turn-skill-badge" title={`/${name}`}>
							<span className="user-turn-skill-icon">/</span>
							{name}
						</span>
					))}
				</div>
			)}
			{message.images && message.images.length > 0 && (
				<div className="user-turn-attachments">
					{message.images.map((img, index) => (
						<img
							key={index}
							src={`data:${img.mimeType};base64,${img.data}`}
							alt={t("app.imageAlt", { index: index + 1 })}
							className="user-turn-attachment"
							onClick={() => props.onPreviewImage(img)}
						/>
					))}
				</div>
			)}
			{cleanText && !editing && (
				<div className="user-turn-bubble">
					<div className="user-turn-text">
						{renderChipText(cleanText, props.onOpenFile, props.validCommandNames, props.validFilePaths)}
					</div>
				</div>
			)}
			{editing && (
				<div className="user-turn-edit-area" ref={editAreaRef}>
					<div className="edit-area-indicator">{t("common.edit")}</div>
					<textarea
						className="message-edit-textarea"
						value={editText}
						onChange={(e) => setEditText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								handleSaveEdit();
							}
							if (e.key === "Escape") setEditing(false);
						}}
						autoFocus
					/>
					<div className="message-edit-actions">
						<button className="message-edit-btn primary" onClick={handleSaveEdit}>
							{t("common.save")}
						</button>
						<button className="message-edit-btn" onClick={() => setEditing(false)}>
							{t("common.cancel")}
						</button>
					</div>
				</div>
			)}
			<div className="user-turn-meta">
				{deliveryLabel && (
					<span
						className={`user-turn-delivery${
							deliveryBehavior === "followUp" ? " follow-up" : " steer"
						}`}
						title={
							deliveryBehavior === "followUp"
								? t("app.messageDeliveryFollowUpTitle")
								: t("app.messageDeliverySteerTitle")
						}
					>
						{deliveryLabel}
					</span>
				)}
				<time>{formatTime(message.timestamp)}</time>
			</div>
			<div className="user-turn-actions">
				<CopyMenu deriveText={() => stripMarkdown(cleanText)} markdown={message.text} targetRef={rowRef} />
				<button
					className="user-turn-action-btn"
					onClick={props.onEnterMultiSelect}
					title={t("app.multiSelectEnter")}
						>
							<Share size={14} />
						</button>
				{!editing && !props.agentRunning && (
					<>
						{canFork && (
							<button
								type="button"
								className="user-turn-action-btn"
								disabled={props.forking}
								onClick={() => props.onForkMessage?.(message)}
								title={t("app.forkFromMessageTitle")}
								aria-label={t("app.forkFromMessage")}
							>
								<GitFork size={14} strokeWidth={1.8} aria-hidden="true" />
							</button>
						)}
						<button className="user-turn-action-btn" onClick={() => {
							setEditText(cleanText);
							setEditing(true);
						}} title={t("common.edit")}>
							<SquarePen size={14} />
						</button>
						<button
							className="user-turn-action-btn"
					onClick={handleEditAndResend}
							title={t("app.editAndResendTitle")}
						>
							<UserPen size={14} />
						</button>
						<button
							className="user-turn-action-btn"
							onClick={() => props.onDeleteMessage?.(message.id)}
							title={t("common.delete")}
						>
							<Trash size={14} />
						</button>

					</>
				)}
			</div>
		</article>
	);
}, (previous, next) =>
	sameChatMessageForRender(previous.message, next.message) &&
	previous.agentRunning === next.agentRunning &&
	previous.forking === next.forking &&
	previous.validCommandNames === next.validCommandNames &&
	previous.validFilePaths === next.validFilePaths,
);
export function ImagePreviewModal(props: {
	image: ImageContent;
	onClose: () => void;
}) {
	return (
		<div className="image-preview-modal" onClick={props.onClose}>
			<button
				className="image-preview-close"
				onClick={props.onClose}
				aria-label={t("app.imagePreviewClose")}
			>
				<X size={20} strokeWidth={2.4} />
			</button>
			<img
				src={`data:${props.image.mimeType};base64,${props.image.data}`}
				alt={t("app.imagePreviewAlt")}
				onClick={(event) => event.stopPropagation()}
			/>
		</div>
	);
}
