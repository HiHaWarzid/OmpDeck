/**
 * 当前会话的交互时间线：消息分页、滚动跟随、大纲跳转、多选导出都在这里。
 *
 * 从 App 根抽出的原因：流式期间 transcript 每 50ms 产生一次增量，如果 App 根订阅
 * `transcript` 切片，9k 行的根组件会跟着整树重渲染（侧栏、输入框、抽屉全被唤醒）。
 * 现在根只订阅布局/运行态，消息相关订阅和派生链都留在本组件内。
 */
import {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ForwardedRef,
	type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import type { AgentRuntimeState, AgentTab, ChatMessage, ImageContent } from "../../../../shared/types";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { writeClipboard } from "../../utils/clipboard";
import { pickTimelineAnchorIndex } from "../../utils/timelineAnchor";
import { isAgentExactlyRunning, isAgentIdle, isAgentStarting, isAgentStreaming } from "../../utils/agentRuntimeState";
import { isPendingAgentId } from "../../hooks/useAgentSessions";
import { useMessagePagination } from "../../hooks/useMessagePagination";
import { useWorkspaceSlice } from "../../workspace/hooks";
import { Button } from "../ui/Button";
import { EmptyState } from "./brand/Brand";
import { MultiSelectModal } from "./modals/MultiSelectModal";
import { MessageListContent } from "./MessageListContent";
import { buildStreamState } from "./streamStateSelector";
import { buildOutline, getMultiSelectImageCaptureIds, groupToolMessages, type OutlineItem } from "./AppUtils";
import { stripMarkdown } from "./format";

type AskResponse = {
	value?: string | boolean | null;
	cancelled?: boolean;
	confirmed?: boolean;
};

export type ConversationPaneHandle = {
	/** 大纲/搜索跳转：目标未在当前分页窗口时先扩窗，再滚动定位。 */
	jumpToMessage: (id: string) => void;
	/** 回到最新消息：复位分页窗口并滚到底部。 */
	scrollToBottom: () => void;
	/** 发送消息后只在用户仍贴底时滚动，避免用户回看历史时被抢走位置。 */
	scrollToBottomIfFollowing: () => void;
	/** 发送前强制恢复贴底跟随并立即滚到底部。 */
	resetAndScrollToBottom: () => void;
};

export type ConversationPaneProps = {
	activeAgentId?: string;
	activeAgent?: AgentTab;
	/** 当前项目 id：仅用于 memo 失效，保证 onCreateAgent 等闭包随项目切换更新。 */
	activeProjectId?: string;
	runtimeState?: AgentRuntimeState;
	isAgentBusy: boolean;
	cancellingUi: boolean;
	activeUiAskRequestId?: string;
	showThinking: boolean;
	forkingMessageId: string | null;
	validCommandNames: Set<string>;
	validFilePaths: Set<string>;
	hasProject: boolean;
	terminalRowHeight: number;
	composerOffsetHeight: number;

	onCreateAgent: () => void;
	onPreviewImage: (image: ImageContent) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: (path: string, originalContent?: string, content?: string) => void;
	onEditMessage: (messageId: string, newText: string) => void;
	onDeleteMessage: (messageId: string) => void;
	onForkMessage: (message: ChatMessage) => void;
	onOpenExternal: (url: string) => void;
	onRespondAsk: (requestId: string, response: AskResponse) => void;
};

const EMPTY_MESSAGES: ChatMessage[] = Object.freeze([]) as unknown as ChatMessage[];

function ConversationPaneImpl(
	props: ConversationPaneProps,
	ref: ForwardedRef<ConversationPaneHandle>,
) {
	const {
		activeAgentId,
		activeAgent,
		runtimeState,
		isAgentBusy,
		cancellingUi,
		activeUiAskRequestId,
		showThinking,
		forkingMessageId,
		validCommandNames,
		validFilePaths,
		hasProject,
		terminalRowHeight,
		composerOffsetHeight,
		onCreateAgent,
		onPreviewImage,
		onOpenFile,
		onDiffFile,
		onEditMessage,
		onDeleteMessage,
		onForkMessage,
		onOpenExternal,
		onRespondAsk,
	} = props;

	// 当前会话消息：订阅留在本组件，根不再跟进 50ms 流式增量。
	const transcript = useWorkspaceSlice(activeAgentId, "transcript");
	const activeMessages = transcript?.messages ?? EMPTY_MESSAGES;

	const [multiSelectOpen, setMultiSelectOpen] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);
	/** 用 ref 同步 autoScroll，供 ResizeObserver 回调读取最新值，避免响应式时序间隙导致滚动抢跑。 */
	const autoScrollRef = useRef(true);
	autoScrollRef.current = autoScroll;
	/** 标记当前滚动是否由程序触发（ResizeObserver / scrollToBottom 等），
	 *  用于在 scroll 事件中区分用户手动滚动，防止竞态误关 autoScroll。 */
	const programmaticScrollRef = useRef(false);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);
	const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
	const loadMoreAnchorRef = useRef<{ id: string; top: number } | null>(null);
	const timelineRef = useRef<HTMLElement | null>(null);

	// 历史首屏控制在 50 条，避免打开旧会话时同步解析过多 Markdown/KaTeX。
	// 窗口上限（默认 200 条）在 hook 内：超过后从顶部上收，避免长会话把上千条消息全量渲染进 DOM。
	const {
		visibleMessages: paginatedMessages,
		hasMore: hasMoreMessages,
		messagesAbove: messagesAboveWindow,
		messagesBelow: messagesBelowWindow,
		loadMore: loadMoreMessages,
		loadUntilIncluded: loadMessagesUntilIncluded,
		jumpToLatest: jumpMessagesToLatest,
		isLoading: isLoadingMoreMessages,
	} = useMessagePagination({
		messages: activeMessages,
		initialPageSize: 50,
		pageSize: 50,
		enabled: activeMessages.length > 50,
		resetKey: activeAgentId ?? undefined,
		// 贴底跟随：autoScroll=false（用户在看历史）时冻结窗口，新消息不再塞进 DOM 顶走阅读位置。
		followTail: autoScroll,
	});

	const renderedRuns = useMemo(
		() => groupToolMessages(paginatedMessages),
		[paginatedMessages],
	);

	const isAwaitingAssistant = Boolean(
		activeAgent &&
			!cancellingUi &&
			isAgentStreaming(activeAgent, runtimeState) &&
			activeMessages.at(-1)?.role !== "assistant",
	);

	/** 正在流式追加的最后一条 assistant 消息的 id（agent 处于运行/流式状态时才有值）。 */
	const streamingMessageId = useMemo(() => {
		if (!activeAgent || !isAgentExactlyRunning(activeAgent)) return undefined;
		if (!runtimeState?.isStreaming) return undefined;
		for (let i = activeMessages.length - 1; i >= 0; i--) {
			const m = activeMessages[i];
			if (m.role === "user") break;
			// 跳过纯 thinking / 工具消息，定位最后一条有实际正文的 assistant 消息
			if (m.role === "assistant" && (m.text || "").trim()) return m.id;
		}
		return undefined;
	}, [activeAgent, runtimeState, activeMessages]);

	const streamState = useMemo(
		() =>
			buildStreamState({
				streamingMessageId,
				agentRunning: isAgentBusy,
				statusRunning: isAgentExactlyRunning(activeAgent),
				isAwaitingAssistant,
				showThinking,
				isExecutingTool: runtimeState?.isExecutingTool,
				isStreaming: runtimeState?.isStreaming,
				cancellingUi,
				activeUiAskRequestId,
			}),
		[
			streamingMessageId,
			isAgentBusy,
			activeAgent,
			isAwaitingAssistant,
			showThinking,
			runtimeState?.isExecutingTool,
			runtimeState?.isStreaming,
			cancellingUi,
			activeUiAskRequestId,
		],
	);

	function highlightMessageElement(el: HTMLElement) {
		el.classList.remove("message-jump-highlight");
		// 强制 reflow 以便重复跳转同一条消息时仍能重新触发动画。
		void el.offsetWidth;
		el.classList.add("message-jump-highlight");
		window.setTimeout(() => el.classList.remove("message-jump-highlight"), 2000);
	}

	/**
	 * 记录一个"视口内的稳定行"的 id 与视口坐标，供翻页/滑窗后恢复滚动位置使用。
	 * 选取规则与原因见 `utils/timelineAnchor.ts`。
	 */
	function captureTimelineAnchor(): { id: string; top: number } | null {
		const timeline = timelineRef.current;
		if (!timeline) return null;
		const rows = Array.from(timeline.querySelectorAll<HTMLElement>("[data-message-id]")).map((row) => {
			const rect = row.getBoundingClientRect();
			return { id: row.dataset.messageId ?? "", rectTop: rect.top, rectBottom: rect.bottom };
		});
		const index = pickTimelineAnchorIndex(rows, timeline.getBoundingClientRect().top);
		const picked = index >= 0 ? rows[index] : undefined;
		if (!picked?.id) return null;
		return { id: picked.id, top: picked.rectTop };
	}

	const scrollToBottom = useCallback(() => {
		const timeline = timelineRef.current;
		if (!timeline) return;
		// 回看历史时窗口可能冻结在旧位置，最新消息尚未渲染：先把窗口复位到尾部，再滚到底。
		// 复位后 DOM 会变高，由 ResizeObserver（programmaticScrollRef/autoScroll）二次校准到真正的底部。
		jumpMessagesToLatest();
		programmaticScrollRef.current = true;
		autoScrollRef.current = true;
		setAutoScroll(true);
		setShowScrollToBottom(false);
		timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
	}, [jumpMessagesToLatest]);

	const scrollToBottomIfFollowing = useCallback(() => {
		const timeline = timelineRef.current;
		if (!timeline || !autoScrollRef.current) return;
		programmaticScrollRef.current = true;
		timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
	}, []);

	const resetAndScrollToBottom = useCallback(() => {
		setAutoScroll(true);
		autoScrollRef.current = true;
		programmaticScrollRef.current = true;
		const timeline = timelineRef.current;
		if (timeline) timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
	}, []);

	// 点击“加载更多历史消息”：先记录窗口首条消息的视口位置，再触发分页加载，
	// 渲染后的 effect 按该锚点位移补偿 scrollTop，保持视图稳定。
	// 用元素位移而不是高度差：窗口到上限后翻页是“顶部加、底部收”，高度差 ≠ 视图位移。
	function handleLoadMoreMessages() {
		loadMoreAnchorRef.current = captureTimelineAnchor();
		loadMoreMessages();
	}

	// 会话定位跳转：若目标消息已在当前分页内则直接滚动定位；
	// 否则先扩展分页窗口把它包含进来，交给 pendingJumpId effect 在渲染后定位。
	const jumpToMessage = useCallback(
		(id: string) => {
			const el = timelineRef.current?.querySelector(
				`[data-message-id="${CSS.escape(id)}"]`,
			) as HTMLElement | null;
			if (el) {
				el.scrollIntoView({ behavior: "smooth", block: "start" });
				highlightMessageElement(el);
				return;
			}
			const index = activeMessages.findIndex((m) => m.id === id);
			if (index < 0) return;
			loadMessagesUntilIncluded(index);
			setPendingJumpId(id);
		},
		[activeMessages, loadMessagesUntilIncluded],
	);

	useImperativeHandle(
		ref,
		() => ({
			jumpToMessage,
			scrollToBottom,
			scrollToBottomIfFollowing,
			resetAndScrollToBottom,
		}),
		[jumpToMessage, scrollToBottom, scrollToBottomIfFollowing, resetAndScrollToBottom],
	);

	// 切换 Agent 时重置滚动状态，确保回到该 Agent 时自动滚到底部。
	// 历史命令已由当前分支按 Agent 隔离，不恢复 dev 旧的全局 commandHistory 持久化。
	useEffect(() => {
		setAutoScroll(true);
		autoScrollRef.current = true;
		setShowScrollToBottom(false);
		const frame = requestAnimationFrame(() => {
			const timeline = timelineRef.current;
			if (timeline) {
				programmaticScrollRef.current = true;
				timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [activeAgentId]);

	// 监听用户滚动，判断是否需要显示"移动到最新"按钮。
	useEffect(() => {
		const timeline = timelineRef.current;
		if (!timeline) return;

		const handleScroll = () => {
			const { scrollTop, scrollHeight, clientHeight } = timeline;
			const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

			// 程序触发的滚动（ResizeObserver / scrollToBottom 等）只允许开启 autoScroll，
			// 不允许关闭。防止竞态：scrollTo(bottom) 后、scroll 事件触发前，scrollHeight
			// 可能已大幅变化（思考块折叠、代码块/工具输出出现），导致误判为"用户滚离了底部"。
			if (programmaticScrollRef.current) {
				programmaticScrollRef.current = false;
				if (isAtBottom) {
					setAutoScroll(true);
					autoScrollRef.current = true;
					setShowScrollToBottom(false);
				}
				// 非底部也不关 autoScroll — 交给后续事件重新判断。
				return;
			}

			if (isAtBottom) {
				setAutoScroll(true);
				autoScrollRef.current = true;
				setShowScrollToBottom(false);
			} else {
				setAutoScroll(false);
				// 同步更新 ref，确保 ResizeObserver 回调在 React 状态更新生效前读到最新值，
				// 避免用户已滚到上方但 DOM 增长触发的 observer 因闭包旧值抢滚动到底部。
				autoScrollRef.current = false;
				setShowScrollToBottom(true);
			}
		};

		// 初始化时检查一次
		handleScroll();

		timeline.addEventListener("scroll", handleScroll);
		return () => timeline.removeEventListener("scroll", handleScroll);
	}, [activeAgentId]);

	// 用 ResizeObserver 监控消息列表内容的 DOM 高度变化，自动滚动到底部。
	// 流式回答时最后一条 assistant 消息原地增长但 messages.length 不变，
	// 依赖 length 的 effect 不会及时触发；通过 ResizeObserver 准确感知容器扩张。
	// autoScroll 在依赖中确保开关变化时重建 observer（同时触发一次初始滚动）。
	// activeAgent?.status 让 agent 从 starting→idle/errored 时重建 observer
	// 并触发一次滚动，解决状态切换后才出现 .message-list 时不会自动滚到底部的问题。
	useEffect(() => {
		const timeline = timelineRef.current;
		if (!timeline) return;
		const messageList = timeline.querySelector(".message-list");
		if (!messageList) return;

		// 使用 ref 而非闭包值，防止 DOM 变化与 React 状态更新之间的时序间隙造成滚动抢跑：
		// 用户已滚到上方（autoScroll=false），但状态更新尚未生效，observer 闭包中的 autoScroll 仍为 true。
		// rAF 合并：流式期间内容每 50ms 增长触发一次 observer，同一帧内多次触发只执行一次
		// scrollTo，避免每次 token 都做同步布局读取 + 滚动（虚拟显卡上这是滚动卡顿源）。
		let scrollFrame = 0;
		const scrollIfNeeded = () => {
			if (scrollFrame) return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = 0;
				if (!autoScrollRef.current) return;
				programmaticScrollRef.current = true;
				timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
			});
		};
		// 重建 observer 时先主动滚一次，处理 autoScroll 从 false→true 但列表高度未变的场景。
		scrollIfNeeded();

		const resizeObserver = new ResizeObserver(scrollIfNeeded);
		resizeObserver.observe(messageList);

		return () => {
			if (scrollFrame) cancelAnimationFrame(scrollFrame);
			resizeObserver.disconnect();
		};
	}, [activeAgentId, autoScroll, activeAgent?.status, activeMessages.length]);

	// 加载更多历史消息/滑窗后恢复滚动位置：翻页会在窗口顶部插入内容（滑窗还会在底部收起内容），
	// 浏览器保持 scrollTop 不变会让正在看的内容上下跳动。这里按锚点消息的视口位移做补偿，
	// 让同一批消息停在原来的位置。用 useLayoutEffect 在绘制前同步补偿，避免中间帧抖动。
	useLayoutEffect(() => {
		const anchor = loadMoreAnchorRef.current;
		if (!anchor) return;
		loadMoreAnchorRef.current = null;
		const el = timelineRef.current;
		if (!el) return;
		const target = el.querySelector(
			`[data-message-id="${CSS.escape(anchor.id)}"]`,
		) as HTMLElement | null;
		if (!target) return;
		const delta = target.getBoundingClientRect().top - anchor.top;
		if (delta !== 0) el.scrollTop += delta;
	}, [paginatedMessages]);

	// 会话定位跳转到尚未加载的消息时，先通过 loadMessagesUntilIncluded 扩展分页窗口；
	// 该消息被渲染进 DOM 后，在此 effect 中真正滚动定位并短暂高亮，提示用户落点。
	useEffect(() => {
		if (!pendingJumpId) return;
		const el = timelineRef.current?.querySelector(
			`[data-message-id="${CSS.escape(pendingJumpId)}"]`,
		) as HTMLElement | null;
		if (!el) return;
		el.scrollIntoView({ behavior: "smooth", block: "start" });
		highlightMessageElement(el);
		setPendingJumpId(null);
	}, [pendingJumpId, paginatedMessages.length]);

	// 多选分享：图片只克隆已勾选的可见消息，避免截到整屏会话或被滚动容器裁掉。
	const handleMultiSelectCopy = useCallback(
		async (selectedIds: Set<string>, kind: "text" | "markdown" | "image") => {
			if (kind === "image") {
				try {
					const { toBlob: toBlobImg } = await import("html-to-image");
					const source = document.querySelector(".message-list") as HTMLElement | null;
					if (!source) return;

					const captureIds = getMultiSelectImageCaptureIds(renderedRuns, selectedIds);
					const clone = source.cloneNode(true) as HTMLElement;
					for (const item of Array.from(clone.children)) {
						if (!(item instanceof HTMLElement)) continue;
						const id = item.dataset.messageId;
						if (!id || !captureIds.has(id)) item.remove();
					}
					clone.classList.add("multi-select-image-export");
					clone.style.width = `${Math.max(source.clientWidth, source.scrollWidth)}px`;
					clone.style.padding = "24px";
					clone.style.background = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
					document.body.appendChild(clone);
					let blob: Blob | null = null;
					try {
						blob = await toBlobImg(clone, {
							pixelRatio: Math.min(2, window.devicePixelRatio || 1),
							backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || undefined,
							filter: (node) =>
								!(node instanceof HTMLElement) ||
								(!node.classList.contains("turn-row-actions") &&
									!node.classList.contains("user-turn-actions") &&
									!node.classList.contains("copy-menu-popover")),
						});
					} finally {
						clone.remove();
					}
					if (blob) {
						await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
						showNotice(t("copy.asImageCopied"));
					}
				} catch {
					showNotice(t("copy.failed"));
				}
				setMultiSelectOpen(false);
				return;
			}

			const selected = activeMessages
				.filter((m) => selectedIds.has(m.id))
				.sort((a, b) => a.timestamp - b.timestamp);
			if (selected.length === 0) return;

			const separator = "\n\n---\n\n";
			const content =
				kind === "text"
					? selected
							.map((m) => {
								let text = m.text;
								text = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
								text = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
								text = text.replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>/gi, "");
								return stripMarkdown(text);
							})
							.join(separator)
					: selected.map((m) => m.text).join(separator);

			await writeClipboard(content);
			showNotice(kind === "text" ? t("copy.asTextCopied") : t("copy.asMarkdownCopied"));
			setMultiSelectOpen(false);
		},
		[activeMessages, renderedRuns],
	);

	const handleEnterMultiSelect = useCallback(() => {
		setMultiSelectOpen(true);
	}, []);

	return (
		<>
			<section className="message-timeline" ref={timelineRef}>
				{/* 加载更多历史消息按钮：计数取"窗口上方未渲染的条数"，滑窗后仍准确。 */}
				{hasMoreMessages && activeAgent && activeAgent.status !== "starting" && (
					<div className="timeline-load-more">
						<Button
							buttonSize="sm"
							variant="secondary"
							onClick={handleLoadMoreMessages}
							loading={isLoadingMoreMessages}
						>
							{t("app.loadMoreHistory", { count: messagesAboveWindow })}
						</Button>
					</div>
				)}

				{/* Agent 启动时显示骨架屏；消息尚未到达时继续展示，避免闪空。
				    Agent 状态已是 idle 时不再显示，即使消息还未到达，避免 "正在启动 Agent" 在启动完成后仍卡住。 */}
				{isAgentStarting(activeAgent) ||
				(!isAgentIdle(activeAgent) &&
					Boolean(activeAgent) &&
					activeMessages.length === 0 &&
					!isPendingAgentId(activeAgent!.id)) ? (
					<div className="history-loading">
						<div className="history-loading-placeholder">
							<div className="skeleton-bubble" />
							<div className="skeleton-line" />
							<div className="skeleton-line" />
							<div className="skeleton-line" />
						</div>
						<div className="history-loading-placeholder">
							<div className="skeleton-line" />
							<div className="skeleton-line" />
							<div className="skeleton-line" />
						</div>
						<div className="history-loading-placeholder">
							<div className="skeleton-line" />
							<div className="skeleton-line" />
						</div>
						<span style={{ paddingTop: "16px", alignSelf: "center", fontSize: "var(--font-size-small)" }}>
							{t("app.agentStarting")}
						</span>
					</div>
				) : null}
				{!activeAgent && <EmptyState hasProject={hasProject} onCreate={onCreateAgent} />}
				{activeAgent && activeAgent.status !== "starting" && activeMessages.length > 0 ? (
					<MessageListContent
						renderedRuns={renderedRuns}
						streamState={streamState}
						activeAgentId={activeAgentId}
						forkingMessageId={forkingMessageId}
						validCommandNames={validCommandNames}
						validFilePaths={validFilePaths}
						onPreviewImage={onPreviewImage}
						onOpenFile={onOpenFile}
						onDiffFile={onDiffFile}
						onEditMessage={onEditMessage}
						onDeleteMessage={onDeleteMessage}
						onForkMessage={onForkMessage}
						onEnterMultiSelect={handleEnterMultiSelect}
						onOpenExternal={onOpenExternal}
						onRespondAsk={onRespondAsk}
					/>
				) : null}

				{multiSelectOpen && (
					<MultiSelectModal
						renderedRuns={renderedRuns}
						onClose={() => setMultiSelectOpen(false)}
						onCopy={handleMultiSelectCopy}
					/>
				)}
			</section>

			{/* 回看历史时窗口冻结，较新的消息没有渲染进 DOM（否则每条流式增量都会顶走阅读位置）：
			    用「还有 N 条新消息」入口替代单纯的回到最新箭头，位置与箭头一致（悬浮在输入框上方，
			    不随滚动内容飘走），让用户知道下方仍在新消息并一键回到最新。 */}
			{messagesBelowWindow > 0 ? (
				<div
					className="timeline-newer-strip"
					// 与 scroll-to-bottom-btn 同一锚点：由 composer 实际高度 + 终端高度决定 bottom。
					style={{ bottom: Math.max(24, terminalRowHeight + composerOffsetHeight + 18) }}
				>
					<Button
						buttonSize="sm"
						variant="secondary"
						className="timeline-newer-btn"
						onClick={scrollToBottom}
						title={t("app.jumpToNewest")}
					>
						<ChevronDown size={14} aria-hidden="true" />
						{t("app.newerMessagesHint", { count: messagesBelowWindow })}
					</Button>
				</div>
			) : showScrollToBottom ? (
				<button
					className="scroll-to-bottom-btn"
					// 按钮脱离滚动容器后，由 composer 实际高度 + 终端高度决定 bottom，避免输入框增高或终端打开时遮挡。
					style={{ bottom: Math.max(24, terminalRowHeight + composerOffsetHeight + 18) }}
					onClick={scrollToBottom}
					title={t("app.scrollToBottom")}
				>
					<ChevronDown size={18} />
				</button>
			) : null}
		</>
	);
}

export const ConversationPane = memo(
	forwardRef<ConversationPaneHandle, ConversationPaneProps>(ConversationPaneImpl),
	(previous, next) =>
		previous.activeAgentId === next.activeAgentId &&
		previous.activeProjectId === next.activeProjectId &&
		previous.activeAgent === next.activeAgent &&
		previous.runtimeState === next.runtimeState &&
		previous.isAgentBusy === next.isAgentBusy &&
		previous.cancellingUi === next.cancellingUi &&
		previous.activeUiAskRequestId === next.activeUiAskRequestId &&
		previous.showThinking === next.showThinking &&
		previous.forkingMessageId === next.forkingMessageId &&
		previous.validCommandNames === next.validCommandNames &&
		previous.validFilePaths === next.validFilePaths &&
		previous.hasProject === next.hasProject &&
		previous.terminalRowHeight === next.terminalRowHeight &&
		previous.composerOffsetHeight === next.composerOffsetHeight,
);

/** 会话大纲宿主：自己订阅 transcript，避免 App 根因消息增量重渲染。 */
export function ConversationOutlineHost(props: {
	activeAgentId?: string;
	children: (items: Array<{ id: string; role: string; title: string; time: string }>) => ReactNode;
}) {
	const transcript = useWorkspaceSlice(props.activeAgentId, "transcript");
	const messages = transcript?.messages;
	const stableItemsRef = useRef<OutlineItem[]>(EMPTY_OUTLINE);
	const items = useMemo(() => {
		if (!messages) return EMPTY_OUTLINE;
		const next = buildOutline(messages);
		const previous = stableItemsRef.current;
		// 历史 user 消息未变时复用旧数组，避免下游 ConversationOutline
		// 在每个流式 delta 上都被重建（即使只有 assistant 文本增长）。
		if (
			previous.length === next.length &&
			next.every((item, index) => item === previous[index])
		) {
			return previous;
		}
		stableItemsRef.current = next;
		return next;
	}, [messages]);
	return <>{props.children(items)}</>;
}

const EMPTY_OUTLINE: OutlineItem[] = [];
