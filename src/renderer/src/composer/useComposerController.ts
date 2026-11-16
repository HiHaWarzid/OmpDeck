/**
 * useComposerController — composer 深模块的 React 薄适配层。
 *
 * 接口面（对 App）只有三件事：
 * 1. selector：草稿派生的布尔/模式、建议框状态、历史导航状态；
 * 2. 事件入口：RichInput 的 onChange/onKeyDown/onPaste/onDrop 等直接转发到这里；
 * 3. 命令：writeDraft / insertPathRefs / appendRestoredDrafts / submit / submitFollowUp。
 *
 * 实现拥有全部规则（bang 识别、光标意图、建议索引、历史合并与导航、发送路线），
 * 规则本身在 composerModule.ts 里；本文件只负责「状态放哪、DOM 怎么读写」。
 * 草稿/图片/历史的存储仍由调用方的 owner 持有（useAgentLifecycle + composerSlice），
 * 这里通过 ports 读写，不引入第二个 store。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ComposerAgentMode,
	FileTreeNode,
	ImageContent,
	PiCommand,
	RestoredQueuedMessage,
	SessionSummary,
} from "../../../shared/types";
import {
	decideComposerSubmit,
	expandPromptTemplates,
	getComposerEnterIntent,
	getComposerHistoryLineBounds,
	type PromptTemplateInfo,
	type SendShortcut,
} from "../composerBehavior";
import {
	applySuggestion,
	buildSuggestionItems,
	detectTrigger,
	type SuggestionItem,
} from "../components/app/composer/composerSuggestions";
import {
	formatFilePathRef,
	getCaretOffset,
	getRichInputCaretCoords,
} from "../components/app/RichInput";
import {
	clampSuggestionIndex,
	collectRestoredDraft,
	detectBangMode,
	IDLE_PROMPT_HISTORY_NAVIGATION,
	insertTextAtCaret,
	isImagePath,
	prependDraftText,
	recordPromptHistory,
	resolveComposerSendRoute,
	cancelPromptHistoryNavigation,
	shouldRecordPrompt,
	stepPromptHistoryNavigation,
	stepSuggestionIndex,
	streamingBehaviorForRoute,
	type ComposerBangMode,
	type PromptHistoryNavigation,
	type StreamingBehavior,
} from "./composerModule";
import { dataUrlToImageContent, processImageFile } from "./imageAttachments";

/** 草稿存储的读写缝：实现仍由 useAgentLifecycle 持有（ref/state 双写是它的内部细节）。 */
export type ComposerDraftPort = {
	get(agentId: string): string;
	set(agentId: string, value: string | ((current: string) => string)): string;
	/** RichInput 原生输入：仅在 chips 形态或空/非空翻转时同步 state。 */
	setNative(agentId: string, value: string): string;
	/** 只写 live ref（发送前的 DOM 直读同步 / 失败回填暂存）。 */
	stage(agentId: string, text?: string | null): void;
};

export type ComposerControllerOptions = {
	activeAgentId: string | null | undefined;
	/** 活跃条目 ref（App 侧类型为 string | undefined，只读使用）。 */
	activeAgentIdRef: { readonly current: string | null | undefined };
	textareaRef: React.RefObject<HTMLDivElement | null>;
	/** 当前渲染的草稿（受控镜像），事件处理里另用 draftPort.get 取实时值。 */
	draft: string;
	draftPort: ComposerDraftPort;
	/** 当前条目的附件图片（渲染镜像）。 */
	images: readonly ImageContent[];
	/** 按条目键写入附件（恢复草稿需要显式 agentId）。 */
	setImagesForAgent: (
		agentId: string,
		value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]),
	) => void;
	/** 当前条目追加附件（粘贴/拖拽）。 */
	appendImages: (images: ImageContent[]) => void;
	/** 当前条目清空附件。 */
	clearImages: () => void;
	/** 该 agent 的提示历史（最新在前）。 */
	historyFor: (agentId: string) => readonly string[];
	/** 历史记录的持久化键（sessionPath 优先）。 */
	historyKeyOf: (agentId: string) => string;
	/** 写回历史：key + 新列表（内部用 recordPromptHistory 生成）。 */
	updateHistory: (
		key: string,
		update: (existing: readonly string[] | undefined) => string[],
	) => void;
	commands: PiCommand[];
	files: FileTreeNode[];
	sessions: SessionSummary[];
	promptTemplates: PromptTemplateInfo[];
	agentMode: ComposerAgentMode;
	sendShortcut: SendShortcut;
	agentStarting: boolean;
	/** 当前条目是否忙碌（决定运行中发送走 steer）。 */
	busy: boolean;
	latchBusyDraft: (agentId: string) => void;
	clearBusyDraft: (agentId: string) => void;
	/** 主进程投递：行为（steer/followUp/undefined）由本模块判定后传入。 */
	submitSnapshot: (
		agentId: string,
		message: string,
		images: ImageContent[] | undefined,
		behavior: StreamingBehavior,
		agentMode: ComposerAgentMode,
		templateDescription?: string,
	) => Promise<boolean | "unknown">;
	compact: (agentId: string, prompt?: string) => Promise<void>;
	addUncertain: (agentId: string, text: string) => void;
	/** 空模板拦截的用户提示（文案由调用方按 i18n 组装）。 */
	notifyEmptyTemplate: (templateName: string) => void;
	resetConversationScroll: () => void;
	followConversationScroll: () => void;
	closeSendBehaviorMenu: () => void;
	resetComposerHeight: () => void;
	/** 系统剪贴板里复制的本地文件路径（资源管理器复制）。 */
	readClipboardPaths: () => string[];
	/** File → 本地路径（Electron webUtils）。 */
	filePathOf: (file: File) => string | null;
	readImageBase64: (path: string) => Promise<{ content: string; truncated: boolean }>;
	pickFiles: () => Promise<string[]>;
	/** 图片被拒时的提示（超限/不支持的类型）。 */
	notifyImageRejected: (reason: "too-large" | "unsupported-type") => void;
};

/** 事件入口 + 命令 + selector：App 只消费这个对象。 */
export type ComposerController = {
	bangMode: ComposerBangMode;
	hasText: boolean;
	cursor: number;
	caretRef: React.RefObject<number | null>;
	suggestionsOpen: boolean;
	suggestionItems: SuggestionItem[];
	suggestionIndex: number;
	suggestionAnchorStyle: React.CSSProperties | undefined;
	/** 外部草稿写入（set_editor_text 等）后同步 bang/非空标志。 */
	onDraftTextChange: (text: string) => void;
	onFocus: () => void;
	onBlur: () => void;
	onChange: (value: string, cursor: number) => void;
	onCursorChange: (cursor: number) => void;
	onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
	onPaste: (event: React.ClipboardEvent) => void;
	onDrop: (event: React.DragEvent) => void;
	onDragOver: (event: React.DragEvent) => void;
	setSuggestionIndex: (index: number) => void;
	pickSuggestion: (value: string) => void;
	/** 用户主动拒绝当前建议查询（ESC/关闭按钮）。focus 用于还焦到输入框。 */
	dismissSuggestions: (options?: { focus?: boolean }) => void;
	/** 程序化写草稿并指定落点光标（统一 3 条外部写路径的光标意图）。 */
	writeDraft: (
		text: string,
		options?: { agentId?: string; caret?: number | "end"; focus?: boolean },
	) => void;
	insertPathRefs: (paths: string[]) => void;
	appendRestoredDrafts: (agentId: string, messages: readonly RestoredQueuedMessage[]) => void;
	attachFile: () => Promise<void>;
	submit: () => Promise<void>;
	submitFollowUp: () => Promise<void>;
};

export function useComposerController(options: ComposerControllerOptions): ComposerController {
	const {
		activeAgentId,
		activeAgentIdRef,
		textareaRef,
		draft,
		draftPort,
		images,
		commands,
		files,
		sessions,
		promptTemplates,
		agentMode,
		sendShortcut,
		agentStarting,
		busy,
	} = options;

	const [cursor, setCursor] = useState(0);
	// RichInput 受控重渲染后应恢复到的纯文本偏移（建议选中/历史回填/路径插入）。
	const caretRef = useRef<number | null>(null);
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [suggestionIndex, setSuggestionIndex] = useState(0);
	/**
	 * 用户主动 ESC/关闭建议面板后置 true：这条 @/& 查询被拒绝，之后无论继续
	 * 打字还是移动光标，面板都不再为它弹出；仅当用户再次输入新的 @/& 时复位。
	 */
	const suggestionsDismissedRef = useRef(false);
	/**
	 * 「↓ + Enter」要求「Enter 时 ArrowDown 仍按住」：KeyboardEvent 不携带其它键状态，
	 * 只能自己记录按下/抬起。失焦时复位，避免切走再回来误判组合键。
	 */
	const arrowDownHeldRef = useRef(false);
	const [historyNavigation, setHistoryNavigation] = useState<PromptHistoryNavigation>(
		IDLE_PROMPT_HISTORY_NAVIGATION,
	);
	// 仅跟踪输入框派生的布尔量，避免每键触发整棵 App 树重渲染。
	const [hasText, setHasText] = useState(false);
	const [bangMode, setBangMode] = useState<ComposerBangMode>("none");

	/** 草稿文本变化后的标志同步（普通按键 / 程序化写入 / 外部 set_editor_text 共用）。 */
	const onDraftTextChange = useCallback((text: string) => {
		const nextHasText = text.trim().length > 0;
		setHasText((previous) => (previous !== nextHasText ? nextHasText : previous));
		const nextBang = detectBangMode(text);
		setBangMode((previous) => (previous !== nextBang ? nextBang : previous));
	}, []);

	// ArrowDown 只用于判定「↓ + Enter」组合键，不拦截事件本身；
	// 在 window 上监听 keyup/blur，保证输入框失焦或按键在别处释放时状态不会卡住。
	useEffect(() => {
		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.key === "ArrowDown") arrowDownHeldRef.current = false;
		};
		const handleBlur = () => {
			arrowDownHeldRef.current = false;
		};
		window.addEventListener("keyup", handleKeyUp);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("keyup", handleKeyUp);
			window.removeEventListener("blur", handleBlur);
		};
	}, []);

	// 切 agent 时重置历史导航：index/savedPrompt 属于上一个会话，跨会话复用会错位。
	useEffect(() => {
		setHistoryNavigation(IDLE_PROMPT_HISTORY_NAVIGATION);
	}, [activeAgentId]);

	// 建议项只在面板打开时计算：关闭态返回空数组，避免每键跑一遍全量命令/文件匹配。
	const suggestionItems = useMemo(
		() =>
			suggestionsOpen
				? buildSuggestionItems(draft, cursor, commands, files, sessions)
				: [],
		[suggestionsOpen, draft, cursor, commands, files, sessions],
	);

	// 建议项数量变化时回到第一项：新查询/过滤结果变了，旧索引可能越界或指错条目。
	useEffect(() => {
		setSuggestionIndex(0);
	}, [suggestionItems.length]);

	/** 菜单锚定位置（屏幕坐标），仅在建议面板打开时计算。 */
	const suggestionAnchorStyle = useMemo<React.CSSProperties | undefined>(() => {
		if (!suggestionsOpen) return undefined;
		const root = textareaRef.current;
		if (!root) return undefined;
		const coords = getRichInputCaretCoords(root, cursor);
		if (!coords) return undefined;

		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const menuW = Math.min(520, vw - 120);
		const menuH = 380;
		const gap = 8;

		// 水平：光标左对齐，超出则右贴边
		let left = coords.left;
		if (left + menuW > vw - 16) left = Math.max(16, vw - menuW - 16);

		// 垂直：优先光标下方，空间不够则上方
		const belowTop = coords.top + gap;
		const aboveBottom = coords.top - gap;
		if (belowTop + menuH <= vh - 16) {
			return { top: belowTop, left, bottom: "auto", transform: "none" };
		}
		if (aboveBottom - menuH >= 0) {
			return { top: "auto", bottom: vh - aboveBottom, left, transform: "none" };
		}
		return { top: "auto", bottom: 16, left, transform: "none" };
	}, [suggestionsOpen, cursor, textareaRef]);

	function focusComposer() {
		requestAnimationFrame(() => {
			textareaRef.current?.focus();
		});
	}

	/**
	 * 用户主动拒绝当前 @/& 建议：只关面板、不动输入。
	 * 此后该查询不再唤起面板，直到用户再次按下新的触发键。
	 */
	function dismissSuggestions({ focus = false }: { focus?: boolean } = {}) {
		setSuggestionsOpen(false);
		suggestionsDismissedRef.current = true;
		if (focus) focusComposer();
	}

	/**
	 * 程序化写草稿的统一入口（光标意图收敛点）。
	 * - 非活跃 agent 的写入只更新草稿，不动光标/焦点（后台条目不能被抢焦点）；
	 * - caret 缺省为 "end"：历史回填、fork、set_editor_text 都把光标放到末尾；
	 * - focus=false 用于不希望抢焦点的程序写入。
	 */
	function writeDraft(
		text: string,
		{ agentId, caret = "end", focus = true }: {
			agentId?: string;
			caret?: number | "end";
			focus?: boolean;
		} = {},
	) {
		const targetAgentId = agentId ?? activeAgentIdRef.current ?? null;
		if (!targetAgentId) return;
		draftPort.set(targetAgentId, text);
		if (targetAgentId !== (activeAgentIdRef.current ?? null)) return;
		const caretPos = caret === "end" ? text.length : caret;
		setCursor(caretPos);
		caretRef.current = caretPos;
		if (focus) focusComposer();
	}

	/** 将本地路径以 @path 引用插入到光标处（引用按钮/粘贴/拖拽共用）。 */
	function insertPathRefs(paths: string[]) {
		if (paths.length === 0) return;
		const targetAgentId = activeAgentIdRef.current;
		const editor = textareaRef.current;
		const caretPos = editor ? getCaretOffset(editor) : cursor;
		const liveDraft = draftPort.get(targetAgentId ?? "");
		// 含空格路径写成 @"C:\Users\a b\file.txt"；工作区目录追加尾斜杠，避免 @src 被当成智能体。
		const refText = paths
			.map((path) => {
				const cleaned = path.replace(/[/\\]+$/, "");
				const normalized = cleaned.replace(/\\/g, "/");
				const isDirectory =
					/[/\\]$/.test(path) ||
					files.some(
						(node) =>
							node.type === "directory" &&
							(node.path === cleaned ||
								node.path === path ||
								node.relativePath === normalized),
					);
				return formatFilePathRef(path, { isDirectory });
			})
			.join(" ");
		const inserted = insertTextAtCaret(liveDraft, caretPos, refText);
		writeDraft(inserted.text, { caret: inserted.cursor });
	}

	/** 把恢复/撤回的队列草稿拼到输入框前面，光标落到末尾（与撤回编辑交互一致）。 */
	function appendRestoredDrafts(agentId: string, messages: readonly RestoredQueuedMessage[]) {
		const { text: restoredText, images: restoredImages } = collectRestoredDraft(messages);
		if (!restoredText && restoredImages.length === 0) return;
		const nextPrompt = prependDraftText(draftPort.get(agentId), restoredText);
		draftPort.set(agentId, nextPrompt);
		if (restoredImages.length > 0) {
			options.setImagesForAgent(agentId, (current) => [...restoredImages, ...current]);
		}
		if (activeAgentIdRef.current !== agentId) return;
		setCursor(nextPrompt.length);
		caretRef.current = nextPrompt.length;
		requestAnimationFrame(() => {
			const editor = textareaRef.current;
			editor?.focus();
			if (editor) editor.scrollTop = editor.scrollHeight;
		});
	}

	function handleFocus() {
		// 仅当光标处存在 @ / 触发器时才打开建议框，避免聚焦即弹空菜单。
		// ESC/手动关闭后（dismissed）：面板保持关闭，直到用户再次按下触发键。
		if (suggestionsDismissedRef.current) {
			setSuggestionsOpen(false);
			return;
		}
		setSuggestionsOpen(detectTrigger(draft, cursor) !== null);
	}

	function handleChange(newValue: string, nextCursor: number) {
		const targetAgentId = activeAgentIdRef.current;
		if (targetAgentId) {
			draftPort.setNative(targetAgentId, newValue);
			// busyDraft：内容清空即释放；忙碌且有内容则锁定分段发送控件。
			if (!newValue.trim()) options.clearBusyDraft(targetAgentId);
			else if (busy) options.latchBusyDraft(targetAgentId);
		}
		if (suggestionsOpen) setCursor(nextCursor);
		const nextSuggestionsOpen = detectTrigger(newValue, nextCursor) !== null;
		// 用 dismissed ref 而非 suggestionsOpen 闭包判定：ESC 后首个 input
		// 可能早于 React 重渲染到达，闭包仍是旧值。
		if (!suggestionsDismissedRef.current) {
			if (nextSuggestionsOpen !== suggestionsOpen) setSuggestionsOpen(nextSuggestionsOpen);
		}
		// 历史导航中手动编辑内容 = 退出导航（否则下次 ↓ 会把编辑结果替换掉）。
		if (historyNavigation.navigating) {
			const history = options.historyFor(targetAgentId ?? "");
			if (newValue !== history[historyNavigation.index]) {
				setHistoryNavigation(IDLE_PROMPT_HISTORY_NAVIGATION);
			}
		}
	}

	function handleCursorChange(nextCursor: number) {
		if (suggestionsOpen) setCursor(nextCursor);
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
		if (
			event.key === "ArrowDown" &&
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			!(event.nativeEvent as KeyboardEvent).isComposing
		) {
			arrowDownHeldRef.current = true;
		}
		// ESC 关闭后 suppressed：用户再次按下 @/& 触发键 = 明确开始一条新查询。
		// IME 合成中（key 为 Process/Dead）与普通字符编辑不算；只认触发键本身。
		if (
			suggestionsDismissedRef.current &&
			!event.nativeEvent.isComposing &&
			event.keyCode !== 229 &&
			(event.key === "@" || event.key === "&" || event.key === "/")
		) {
			suggestionsDismissedRef.current = false;
		}
		if (suggestionsOpen && suggestionItems.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSuggestionIndex((previous) =>
					stepSuggestionIndex(previous, suggestionItems.length, 1),
				);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setSuggestionIndex((previous) =>
					stepSuggestionIndex(previous, suggestionItems.length, -1),
				);
				return;
			}
			if (event.key === "Enter") {
				// IME 确认也会发 Enter（keyCode=229 / isComposing），不放行到建议选中。
				if ((event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229) return;
				event.preventDefault();
				const selected =
					suggestionItems[clampSuggestionIndex(suggestionIndex, suggestionItems.length)];
				if (selected?.disabled) return;
				if (selected) pickSuggestion(selected.value);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				// 只关面板、不动输入：@/& 及已输入内容全部保留。
				dismissSuggestions({ focus: true });
				return;
			}
		}

		// 历史命令导航只在单行边界生效，避免多行编辑时抢走光标移动。
		// 普通输入只更新 live ref、不触发重渲染，因此必须读实时草稿，
		// 不能用闭包里的 rendered prompt，否则会丢掉中间继续输入的部分。
		const editor = event.currentTarget;
		const liveDraft = draftPort.get(activeAgentIdRef.current ?? "");
		const { isFirstLine, isLastLine } = getComposerHistoryLineBounds(
			liveDraft,
			getCaretOffset(editor),
		);
		const history = options.historyFor(activeAgentIdRef.current ?? "");

		if (event.key === "ArrowUp" && isFirstLine) {
			const step = stepPromptHistoryNavigation({
				state: historyNavigation,
				direction: "up",
				history,
				draft: liveDraft,
			});
			if (step) {
				event.preventDefault();
				setHistoryNavigation(step.state);
				// 光标回到首行行首：多行历史条目否则会把光标留在末尾，下一次 ↑ 不再命中历史导航。
				if (step.text !== undefined) writeDraft(step.text, { caret: 0 });
				return;
			}
		}
		if (event.key === "ArrowDown" && isLastLine) {
			const step = stepPromptHistoryNavigation({
				state: historyNavigation,
				direction: "down",
				history,
				draft: liveDraft,
			});
			if (step) {
				event.preventDefault();
				setHistoryNavigation(step.state);
				if (step.text !== undefined) writeDraft(step.text);
				return;
			}
		}

		if (event.key === "Escape") {
			// 面板已关（或空面板）时的兜底 ESC。
			// 历史导航中 ESC = 整体撤回成原始输入，不属于「拒绝某条 @ 查询」，
			// 因此不启动 dismissed 抑制。
			const step = cancelPromptHistoryNavigation(historyNavigation);
			if (step) {
				setSuggestionsOpen(false);
				setHistoryNavigation(step.state);
				if (step.text !== undefined) writeDraft(step.text, { caret: 0 });
			} else {
				dismissSuggestions();
			}
		}
		// 「↓ + Enter」：跳过 steer，直接把这条消息排到下一轮。
		// 放在建议面板/历史导航分支之后，避免抢占它们的 Enter/ArrowDown 语义。
		if (
			event.key === "Enter" &&
			arrowDownHeldRef.current &&
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			!(event.nativeEvent as KeyboardEvent).isComposing &&
			event.keyCode !== 229
		) {
			event.preventDefault();
			// 连按 Enter 时 keyup 还没到达：立刻清掉，防止重复排队。
			arrowDownHeldRef.current = false;
			void submitFollowUp();
			return;
		}
		const enterIntent = getComposerEnterIntent(event, sendShortcut);
		if (enterIntent === "send") {
			event.preventDefault();
			void submit();
		}
		// newline：RichInput 内部会在 Enter 未被上层 preventDefault 时插入 \n，这里不做处理。
	}

	/** 选中建议项：以光标为锚替换触发符..光标这一段，并恢复光标到插入项之后。 */
	function pickSuggestion(value: string) {
		const editor = textareaRef.current;
		const caretPos = editor ? getCaretOffset(editor) : cursor;
		const result = applySuggestion(
			draftPort.get(activeAgentIdRef.current ?? ""),
			caretPos,
			value,
		);
		writeDraft(result.text, { caret: result.cursor });
		setSuggestionsOpen(false);
	}

	/* ── 粘贴 / 拖拽：本地路径 → @引用，位图 → 附件 ───────────────────── */

	/** 逐张读取本地图片文件为附件；单张失败不阻断其余，截断数据直接跳过。 */
	async function appendImagesFromPaths(paths: string[]) {
		for (const path of paths) {
			try {
				const { content: dataUrl, truncated } = await options.readImageBase64(path);
				if (!dataUrl || truncated) continue;
				options.appendImages([dataUrlToImageContent(dataUrl, "image/png")]);
			} catch {
				// 单张失败不阻断其余
			}
		}
	}

	function attachPathsAsRefsOrImages(paths: string[]) {
		const imagePaths = paths.filter(isImagePath);
		const nonImagePaths = paths.filter((path) => !isImagePath(path));
		// 非图片：插入完整 @绝对路径 引用；图片文件：按附件附加（不是 @path 引用）。
		if (nonImagePaths.length > 0) insertPathRefs(nonImagePaths);
		if (imagePaths.length > 0) void appendImagesFromPaths(imagePaths);
	}

	function handlePaste(event: React.ClipboardEvent) {
		const items = Array.from(event.clipboardData.items);

		// 1) 资源管理器复制/剪切的文件：ClipboardEvent 通常没有 kind=file，
		//    需通过 preload 同步读取 Electron clipboard（FileNameW / CF_HDROP 等）。
		//    必须先判定文件路径：复制图片文件时剪贴板常同时带路径 + 缩略图。
		const clipboardPaths = options.readClipboardPaths();
		if (clipboardPaths.length > 0) {
			event.preventDefault();
			attachPathsAsRefsOrImages(clipboardPaths);
			return;
		}

		// 2) 兜底：剪贴板里若有 File 对象，用 webUtils 解析本地路径。
		const fileItems = items.filter((item) => item.kind === "file");
		if (fileItems.length > 0) {
			const droppedFiles = fileItems
				.map((item) => item.getAsFile())
				.filter((file): file is File => Boolean(file));
			const paths = droppedFiles
				.map((file) => options.filePathOf(file))
				.filter((path): path is string => Boolean(path));
			if (paths.length > 0) {
				event.preventDefault();
				attachPathsAsRefsOrImages(paths);
				return;
			}
		}

		// 3) 纯位图粘贴（截图等，无本地路径）：读取并附加到消息。
		//    preventDefault 必须在任何 await 之前同步调用，否则浏览器先插入默认内容。
		const imageItems = items.filter((item) => item.type.startsWith("image/"));
		if (imageItems.length > 0) {
			event.preventDefault();
			void (async () => {
				for (const item of imageItems) {
					const file = item.getAsFile();
					if (!file) continue;
					const image = await processImageFile(file, options.notifyImageRejected);
					if (image) options.appendImages([image]);
				}
			})();
		}
	}

	async function handleDrop(event: React.DragEvent) {
		event.preventDefault();
		const droppedFiles = Array.from(event.dataTransfer.files);
		if (droppedFiles.length === 0) return;

		// 优先：有本地路径 → 与「引用文件」一致，插入 @path（含图片文件，不上传内容）。
		const paths = droppedFiles
			.map((file) => options.filePathOf(file))
			.filter((path): path is string => Boolean(path));
		if (paths.length > 0) {
			insertPathRefs(paths);
			return;
		}

		// 兜底：无路径的图片数据（非资源管理器文件拖入）。
		for (const file of droppedFiles) {
			if (!file.type.startsWith("image/")) continue;
			const image = await processImageFile(file, options.notifyImageRejected);
			if (image) options.appendImages([image]);
		}
	}

	function handleDragOver(event: React.DragEvent) {
		event.preventDefault();
	}

	/** 打开系统原生文件选择器，把选中路径以 @path 引用插入到草稿。 */
	async function attachFile() {
		try {
			const paths = await options.pickFiles();
			insertPathRefs(paths);
		} catch {
			// 用户取消或出错时不作处理
		}
	}

	/* ── 发送 ──────────────────────────────────────────────────────── */

	/** 发送成功后把该条 prompt 记入历史并退出导航（历史记录最新在前）。 */
	function recordSentPrompt(agentId: string, message: string) {
		if (!shouldRecordPrompt(message)) return;
		const key = options.historyKeyOf(agentId);
		options.updateHistory(key, (existing) => recordPromptHistory(existing, message));
	}

	/** 隐藏历史导航状态：发送后从「最新一条」重新开始。 */
	function resetHistoryNavigation() {
		setHistoryNavigation(IDLE_PROMPT_HISTORY_NAVIGATION);
	}

	async function submit() {
		const targetAgentId = activeAgentId;
		// 发送前从 DOM 直读文本：contentEditable 的 IME 组合期间 handleInput 可能被锁，
		// live ref 会落后于 DOM。
		if (targetAgentId) {
			const domText = (textareaRef.current?.textContent ?? "").replace(/\u200B/g, "");
			if (domText) draftPort.stage(targetAgentId, domText);
		}
		const message = draftPort.get(targetAgentId ?? "");
		const imagesSnapshot = images;
		const { message: expandedMessage, description: templateDescription, emptyTemplateName } =
			expandPromptTemplates(message, promptTemplates);
		// 发送判定表：只定路线、不做副作用（与 followUp 入口共用同一张表）。
		const decision = decideComposerSubmit({
			isOverride: false,
			agentStarting,
			hasTarget: Boolean(targetAgentId),
			message,
			imageCount: imagesSnapshot.length,
			emptyTemplateName,
		});
		if (decision.action === "ignore") return;
		const agentId = targetAgentId as string; // ignore 已排除无 target
		// 先清 live ref：后续 await 期间再有 Enter 不会重复读到同一份消息。
		draftPort.stage(agentId);
		const imagesToSend = imagesSnapshot.length > 0 ? [...imagesSnapshot] : undefined;

		if (decision.action === "compact") {
			// 与底栏「压缩」按钮同一实现：走 agents.compact RPC 而不是把命令当 prompt 发模型；
			// 压缩绕过队列、不写历史。
			draftPort.set(agentId, "");
			options.setImagesForAgent(agentId, []);
			setSuggestionsOpen(false);
			// 清空 contentEditable 显示（只清 ref 时 DOM 可能残留 /compact 文本）。
			if (textareaRef.current) textareaRef.current.textContent = "";
			await options.compact(agentId, decision.compactPrompt || undefined);
			return;
		}
		if (decision.action === "block-empty-template") {
			// 拦截位置必须在写历史/清输入之前：空模板不是一次真实发送，
			// 不应进历史，更不能吞掉用户输入。
			options.notifyEmptyTemplate(decision.templateName);
			return;
		}

		recordSentPrompt(agentId, message);
		resetHistoryNavigation();
		options.resetConversationScroll();
		// 发送前快照已保留，这里立即清空 composer；运行中发送会走 omp 官方 steer 队列。
		draftPort.set(agentId, "");
		options.clearImages();
		// 发送清空：上一轮的建议框抑制随文本一起作废，新输入从头开始。
		suggestionsDismissedRef.current = false;
		options.clearBusyDraft(agentId);
		setSuggestionsOpen(false);
		options.closeSendBehaviorMenu();
		options.resetComposerHeight();

		const behavior = streamingBehaviorForRoute(
			resolveComposerSendRoute({
				agentId,
				activeAgentId,
				busy,
			}),
		);
		const accepted = await options.submitSnapshot(
			agentId,
			expandedMessage,
			imagesToSend,
			behavior,
			agentMode,
			templateDescription,
		);
		if (accepted === "unknown") {
			// 写 stdin 后超时/断开：omp 可能已收下，重试会重复执行，只能挂本地未知提示。
			options.addUncertain(agentId, message);
			return;
		}
		if (!accepted) {
			// 首条失败：恢复到发送前的草稿之前（不预写 live ref，避免重复拼接）。
			draftPort.set(agentId, (current) => prependDraftText(current, message));
			if (imagesToSend) {
				options.setImagesForAgent(agentId, (current) => [...imagesToSend, ...current]);
			}
			return;
		}
		// 用户消息已提交，仍贴底则跟随；后续增长交给消息列表的 ResizeObserver。
		options.followConversationScroll();
	}

	async function submitFollowUp() {
		const targetAgentId = activeAgentId;
		const message = draftPort.get(targetAgentId ?? "");
		// 跟随发送同样走判定表：不做命令展开（commandRoutes=false），原样走 busy/直发。
		const decision = decideComposerSubmit({
			isOverride: false,
			agentStarting,
			hasTarget: Boolean(targetAgentId),
			message,
			imageCount: images.length,
			commandRoutes: false,
		});
		if (decision.action === "ignore") return;
		const agentId = targetAgentId as string; // ignore 已排除无 target
		// 在任何 await 之前清掉实时草稿，防止双击/连按 Enter 读取同一份消息。
		draftPort.stage(agentId);
		const imagesToSend = images.length > 0 ? [...images] : undefined;
		options.resetConversationScroll();
		draftPort.set(agentId, "");
		options.clearImages();
		recordSentPrompt(agentId, message);
		resetHistoryNavigation();
		options.clearBusyDraft(agentId);
		setSuggestionsOpen(false);
		options.closeSendBehaviorMenu();
		options.resetComposerHeight();

		const accepted = await options.submitSnapshot(
			agentId,
			message,
			imagesToSend,
			streamingBehaviorForRoute(
				resolveComposerSendRoute({ explicit: "followUp", agentId, activeAgentId, busy }),
			),
			agentMode,
		);
		if (accepted === "unknown") {
			options.addUncertain(agentId, message);
			return;
		}
		if (!accepted) {
			draftPort.stage(agentId, message);
			draftPort.set(agentId, (current) => prependDraftText(current, message));
			if (imagesToSend) {
				options.setImagesForAgent(agentId, (current) => [...imagesToSend, ...current]);
			}
			return;
		}
		options.followConversationScroll();
	}

	return {
		bangMode,
		hasText,
		cursor,
		caretRef,
		suggestionsOpen,
		suggestionItems,
		suggestionIndex,
		suggestionAnchorStyle,
		onDraftTextChange,
		onFocus: handleFocus,
		onBlur: () => setSuggestionsOpen(false),
		onChange: handleChange,
		onCursorChange: handleCursorChange,
		onKeyDown: handleKeyDown,
		onPaste: handlePaste,
		onDrop: handleDrop,
		onDragOver: handleDragOver,
		setSuggestionIndex,
		pickSuggestion,
		dismissSuggestions,
		writeDraft,
		insertPathRefs,
		appendRestoredDrafts,
		attachFile,
		submit,
		submitFollowUp,
	};
}
