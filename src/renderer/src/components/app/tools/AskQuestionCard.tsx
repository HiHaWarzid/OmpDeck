/** 提问卡片：单条 ask_question 卡片与批量提问的内联回答条。 */
import { memo, useEffect, useRef, useState } from "react";
import { getComposerEnterIntent } from "../../../composerBehavior";
import { AlertTriangle, Check, ClipboardList, MessageCircle, X } from "lucide-react";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import type {
	AgentUiAskAnswer,
	AgentUiAskQuestion,
	ChatMessage,
} from "../../../../../shared/types";

/**
 * 内联提问卡片：渲染 Extension UI 请求（select/confirm/input/editor）作为 system 消息。
 * 用于实时会话中模型通过 ask_question 扩展向用户发起交互。
 */
export const AskQuestionCard = memo(function AskQuestionCard(props: {
	message: ChatMessage;
	onRespond?: (response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) => void;
}) {
	const meta = props.message.meta as Record<string, unknown> | undefined;
	const uiRequest = meta?.uiRequest as Record<string, unknown> | undefined;
	const status = String(meta?.status ?? "pending");
	const response = meta?.response as Record<string, unknown> | undefined;
	const answered = status === "answered" && response && !response.cancelled;
	const cancelled = status === "cancelled" || status === "error";

	const [inputValue, setInputValue] = useState("");
	const [cancelling, setCancelling] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// 编辑器输入 ref
	const editorRef = useRef<HTMLTextAreaElement>(null);

	// 当 prefill 变化时同步到 inputValue
	useEffect(() => {
		if (uiRequest?.prefill) setInputValue(String(uiRequest.prefill));
	}, [uiRequest?.prefill]);

	const handleSelect = (value: string) => {
		props.onRespond?.({ value });
	};

	const handleConfirm = (value: boolean) => {
		props.onRespond?.({ confirmed: value });
	};

	const handleInputSubmit = () => {
		if (inputValue.trim()) {
			props.onRespond?.({ value: inputValue });
		}
	};

	const handleCancel = () => {
		// 消息流内卡片取消也给 toast，与 composer 内联栏行为一致。
		const method = String(uiRequest?.method ?? "input");
		const cancelHint =
			method === "confirm"
				? t("ask.cancelConfirmHint")
				: method === "input"
					? t("ask.cancelInputHint")
					: method === "editor"
						? t("ask.cancelEditorHint")
						: t("ask.cancelHint");
		showNotice(cancelHint);
		setCancelling(true);
		props.onRespond?.({ cancelled: true });
	};

	// 已回答/取消的卡片：信息已在 ToolCard 的 _askCard 中展示，此处不再重复渲染
	if (answered || cancelled) {
		return null;
	}

	// pending 卡片：显示交互界面
	const cancellingLabel = t("ask.cancelling");
	const method = String(uiRequest?.method ?? "input");
	const title = String(uiRequest?.title ?? "");
	const placeholder = String(uiRequest?.placeholder ?? "");
	const options = uiRequest?.options as string[] | undefined;

	// 时间线内 pending 单问：复用 ask-inline-bar 控件语言，与输入区单问/批量题卡一致。
	return (
		<article className="ask-inline-bar ask-inline-bar--timeline" data-message-id={props.message.id}>
			<div className="ask-inline-bar-header">
				<MessageCircle size={14} />
				<span>{title || t("ask.defaultTitle")}</span>
				<span className="ask-inline-bar-cancel-hint">
					{cancelling ? t("ask.cancelling") : t("ask.waiting")}
				</span>
				<button
					className="ask-inline-bar-close"
					onClick={handleCancel}
					disabled={cancelling}
					title={t("common.cancel")}
					aria-label={t("common.cancel")}
				>
					<X size={14} />
				</button>
			</div>
			<div className="ask-inline-bar-body">
				{method === "select" && options && options.length > 0 && (
					<div className="ask-inline-bar-options">
						{/* 过滤掉 Pi 自带的 "✎ 自行输入..." 选项，自定义输入由其它路径承接 */}
						{options
							.filter((opt) => !opt.startsWith("✎"))
							.map((opt, i) => (
								<button
									key={i}
									className="ask-inline-bar-option"
									onClick={() => handleSelect(opt)}
									disabled={cancelling}
								>
									<span className="ask-inline-bar-option-marker">{opt}</span>
								</button>
							))}
					</div>
				)}
				{method === "confirm" && (
					<div className="ask-inline-bar-options ask-inline-bar-options-confirm">
						<button
							className="ask-inline-bar-option ask-inline-bar-option-yes"
							onClick={() => handleConfirm(true)}
							disabled={cancelling}
						>
							{t("common.true")}
						</button>
						<button
							className="ask-inline-bar-option ask-inline-bar-option-no"
							onClick={() => handleConfirm(false)}
							disabled={cancelling}
						>
							{t("common.false")}
						</button>
					</div>
				)}
				{(method === "input" || method === "editor") && (
					<div
						className={`ask-inline-bar-input-area${method === "editor" ? " ask-inline-bar-input-area--plan-revise" : ""}`}
					>
						{method === "editor" ? (
							<textarea
								ref={editorRef}
								className="ask-inline-bar-input ask-inline-bar-textarea"
								placeholder={placeholder || t("ask.editorPlaceholder")}
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								disabled={cancelling}
								rows={3}
							/>
						) : (
							<textarea
								ref={inputRef}
								className="ask-inline-bar-input ask-inline-bar-textarea"
								placeholder={placeholder || t("ask.inputPlaceholder")}
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								onKeyDown={(e) => {
								// 与主输入框一致：IME 确认候选词的回车不触发提交
								if (getComposerEnterIntent(e, "enter-send") === "send") {
									e.preventDefault();
									handleInputSubmit();
								}
								}}
								disabled={cancelling}
								rows={2}
							/>
						)}
						<div className="ask-inline-bar-input-actions">
							<button
								className="ask-inline-bar-submit-btn"
								onClick={handleInputSubmit}
								disabled={!inputValue.trim() || cancelling}
								title={t("ask.submit")}
							>
								{t("ask.submit")}
							</button>
						</div>
					</div>
				)}
			</div>
		</article>
	);
});
/**
 * 批量 ask 内联栏：Tab 标签页问卷 + Submit 审阅防误提。
 * 扩展通过一次 input envelope 下发全部问题，桌面端在此处渲染完整的 Tab 交互。
 */
export const BatchAskInlineBar = memo(function BatchAskInlineBar(props: {
	uiRequest: {
		requestId: string;
		title: string;
		batchQuestions?: Array<{
			id: string;
			type: "select" | "confirm" | "input" | "editor";
			question: string;
			options?: Array<string | { label: string; value?: string; description?: string }>;
			allowOther?: boolean;
			placeholder?: string;
			prefill?: string;
		}>;
		batchReview?: boolean;
	};
	activeAgentId?: string;
	onCancel: () => void;
	onSubmit: (answersJson: string) => void;
}) {
	const { uiRequest } = props;
	const questions = uiRequest.batchQuestions ?? [];
	const totalQ = questions.length;

	// 逐题临时答案
	const [answers, setAnswers] = useState<Record<string, string | boolean | null>>(
		() => {
			const init: Record<string, string | boolean | null> = {};
			for (const q of questions) init[q.id] = null;
			return init;
		},
	);
	const [answeredLookup, setAnsweredLookup] = useState<Record<string, boolean>>({});
	const [currentTab, setCurrentTab] = useState(0);
	const [inputValues, setInputValues] = useState<Record<string, string>>({});

	// 当前题目
	const currentQ = questions[currentTab];

	const isReviewTab = currentTab === totalQ;

	// 更新答案
	const setAnswer = (id: string, value: string | boolean | null) => {
		setAnswers((prev) => ({ ...prev, [id]: value }));
		setAnsweredLookup((prev) => ({
			...prev,
			[id]: value !== null && value !== undefined,
		}));
	};

	const answeredCount = Object.values(answeredLookup).filter(Boolean).length;
	const allAnswered = answeredCount >= totalQ;

	// 提交：序列化为扩展能解析的 JSON
	const handleSubmit = () => {
		const result = questions.map((q) => ({
			id: q.id,
			type: q.type,
			value: answers[q.id] ?? null,
			label:
				typeof answers[q.id] === "boolean"
					? answers[q.id]
						? "是"
						: "否"
					: String(answers[q.id] ?? ""),
			wasCustom: false,
		}));
		props.onSubmit(JSON.stringify({ answers: result }));
	};

	// 未提醒：去审阅 tab
	const goToReview = () => setCurrentTab(totalQ);

	if (totalQ === 0) {
		return (
			<div className="ask-inline-bar">
				<div className="ask-inline-bar-header">
					<MessageCircle size={14} />
					<span>{uiRequest.title || t("ask.batchTitle", { count: "0" })}</span>
					<button className="ask-inline-bar-close" onClick={props.onCancel} aria-label={t("common.cancel")}>
						<X size={14} />
					</button>
				</div>
				<div className="ask-inline-bar-question">{t("ask.cancelled")}</div>
			</div>
		);
	}

	return (
		<div className="ask-inline-bar ask-inline-bar--batch">
			{/* 标题行：进度 + 取消提示 + 关闭 */}
			<div className="ask-inline-bar-header">
				<MessageCircle size={14} />
				<span>{uiRequest.title || t("ask.batchTitle", { count: String(totalQ) })}</span>
				<span className="ask-inline-bar-batch-progress">
					{t("ask.batchProgress", { done: String(answeredCount), total: String(totalQ) })}
				</span>
				<span className="ask-inline-bar-cancel-hint">{t("ask.cancelBatchHint")}</span>
				<button
					className="ask-inline-bar-close"
					onClick={props.onCancel}
					title={t("ask.cancelBatchHint")}
					aria-label={t("common.cancel")}
				>
					<X size={14} />
				</button>
			</div>

			{/* 顶部 Tab 条 */}
			<div className="ask-batch-tabs" role="tablist">
				{questions.map((q, i) => {
					const isActive = i === currentTab;
					const isAnswered = answeredLookup[q.id] === true;
					return (
						<button
							key={q.id}
							role="tab"
							aria-selected={isActive}
							className={`ask-batch-tab${isActive ? " active" : ""}${isAnswered ? " answered" : ""}`}
							onClick={() => setCurrentTab(i)}
						>
							<span className="ask-batch-tab-num">{i + 1}</span>
							<span className="ask-batch-tab-label">{q.question.slice(0, 16)}</span>
							{isAnswered && <Check size={10} className="ask-batch-tab-check" />}
						</button>
					);
				})}
				{/* Submit 审阅 Tab */}
				{uiRequest.batchReview && (
					<button
						key="__review__"
						role="tab"
						aria-selected={isReviewTab}
						className={`ask-batch-tab ask-batch-tab--review${isReviewTab ? " active" : ""}`}
						onClick={goToReview}
					>
						<ClipboardList size={12} />
						<span className="ask-batch-tab-label">{t("ask.batchReviewTab")}</span>
					</button>
				)}
			</div>

			{/* 题目内容区 */}
			<div className="ask-inline-bar-body">
				{isReviewTab ? (
					/* Submit 审阅 Tab */
					<div className="ask-batch-review">
						<div className="ask-batch-review-title">
							<ClipboardList size={16} />
							{t("ask.batchReviewTitle")}
						</div>
						<div className="ask-batch-review-hint">{t("ask.batchReviewHint")}</div>
						<div className="ask-batch-review-list">
							{questions.map((q, i) => {
								const val = answers[q.id];
								const isAns = answeredLookup[q.id] === true;
								return (
									<div key={q.id} className="ask-batch-review-item">
										<span className="ask-batch-review-num">{i + 1}</span>
										<span className="ask-batch-review-q">{q.question}</span>
										<span className={`ask-batch-review-a${isAns ? " answered" : " unanswered"}`}>
											{isAns
												? typeof val === "boolean"
													? val
														? "✅ " + t("common.true")
														: "❌ " + t("common.false")
													: String(val)
												: "—"}
										</span>
									</div>
								);
							})}
						</div>
						{!allAnswered && (
							<div className="ask-batch-review-warning">
								<AlertTriangle size={14} />
								{t("ask.batchIncomplete")}
							</div>
						)}
						<button
							className="ask-batch-submit-all-btn"
							disabled={!allAnswered}
							onClick={handleSubmit}
						>
							{t("ask.batchSubmitAll")}
						</button>
					</div>
				) : currentQ ? (
					<div className="ask-batch-question">
						<div className="ask-batch-question-header">
							<span className="ask-batch-question-num">
								{t("common.details")} {currentTab + 1}/{totalQ}
							</span>
						</div>
						<div className="ask-inline-bar-question">{currentQ.question}</div>
						<div className="ask-batch-question-body">
							{currentQ.type === "confirm" ? (
								<div className="ask-inline-bar-options ask-inline-bar-options-confirm">
									<button
										className={`ask-inline-bar-option ask-inline-bar-option-yes${answers[currentQ.id] === true ? " selected" : ""}`}
										onClick={() => setAnswer(currentQ.id, true)}
									>
										{t("common.true")}
									</button>
									<button
										className={`ask-inline-bar-option ask-inline-bar-option-no${answers[currentQ.id] === false ? " selected" : ""}`}
										onClick={() => setAnswer(currentQ.id, false)}
									>
										{t("common.false")}
									</button>
								</div>
							) : currentQ.type === "select" && currentQ.options && currentQ.options.length > 0 ? (
								<>
									<div className="ask-inline-bar-options">
										{currentQ.options.map((opt, i) => {
											const optLabel =
												typeof opt === "string" ? opt : opt.label ?? String(opt.value ?? "");
											const optVal =
												typeof opt === "string" ? opt : String(opt.value ?? optLabel);
											const isSelected = answers[currentQ.id] === optVal;
											return (
												<button
													key={i}
													className={`ask-inline-bar-option${isSelected ? " selected" : ""}`}
													onClick={() => setAnswer(currentQ.id, optVal)}
												>
													<span className="ask-inline-bar-option-marker">{optLabel}</span>
												</button>
											);
										})}
									</div>
									{currentQ.allowOther !== false && (
										<div className="ask-inline-bar-custom-input">
											<input
												className="ask-inline-bar-custom-field"
												placeholder={currentQ.placeholder || t("ask.customPlaceholder")}
												value={inputValues[currentQ.id] ?? ""}
												onChange={(e) =>
													setInputValues((prev) => ({
														...prev,
														[currentQ.id]: e.target.value,
													}))
												}
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														const v = (e.target as HTMLInputElement).value.trim();
														if (v) setAnswer(currentQ.id, v);
													}
												}}
											/>
											<button
												className="ask-inline-bar-submit-btn"
												onClick={() => {
													const v = inputValues[currentQ.id]?.trim();
													if (v) setAnswer(currentQ.id, v);
												}}
											>
												{t("common.submit")}
											</button>
										</div>
									)}
								</>
							) : currentQ.type === "editor" ? (
								<div className="ask-batch-editor-area">
									<textarea
										className="ask-inline-bar-input ask-batch-textarea"
										placeholder={currentQ.placeholder || t("ask.editorPlaceholder")}
										value={inputValues[currentQ.id] ?? (currentQ.prefill ?? "")}
										onChange={(e) =>
											setInputValues((prev) => ({
												...prev,
												[currentQ.id]: e.target.value,
											}))
										}
										onBlur={(e) => {
											if (e.target.value.trim()) setAnswer(currentQ.id, e.target.value);
										}}
									/>
								</div>
							) : (
								<div className="ask-inline-bar-input-area">
									<input
										className="ask-inline-bar-input"
										placeholder={currentQ.placeholder || t("ask.inputPlaceholder")}
										value={inputValues[currentQ.id] ?? ""}
										onChange={(e) =>
											setInputValues((prev) => ({
												...prev,
												[currentQ.id]: e.target.value,
											}))
										}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												const v = (e.target as HTMLInputElement).value.trim();
												if (v) setAnswer(currentQ.id, v);
											}
										}}
									/>
									<button
										className="ask-inline-bar-submit-btn"
										onClick={() => {
											const v = inputValues[currentQ.id]?.trim();
											if (v) setAnswer(currentQ.id, v);
										}}
									>
										{t("common.submit")}
									</button>
								</div>
							)}
						</div>

						{/* 底部分页按钮 */}
						<div className="ask-batch-nav">
							{currentTab > 0 && (
								<button
									className="ask-batch-nav-btn"
									onClick={() => setCurrentTab(currentTab - 1)}
								>
									{t("ask.batchPrev")}
								</button>
							)}
							<div className="ask-batch-nav-spacer" />
							{currentTab < totalQ - 1 ? (
								<button
									className="ask-batch-nav-btn primary"
									onClick={() => setCurrentTab(currentTab + 1)}
								>
									{t("ask.batchNext")}
								</button>
							) : (
								<button className="ask-batch-nav-btn primary" onClick={goToReview}>
									{t("ask.batchGoReview")}
								</button>
							)}
						</div>
					</div>
				) : (
					<div className="ask-inline-bar-question">{t("ask.cancelled")}</div>
				)}
			</div>
		</div>
	);
});

type NativeAskDraft = {
	selected: string[];
	custom: string;
	/** 多选题目显式选择「一个都不选」：与「还没答」区分。 */
	none: boolean;
	/** 用户是否动过本题；多选清空后仍视为已答（空选择是合法回答）。 */
	touched: boolean;
};

/**
 * omp 原生 ask 内联问答条（method: "ask"）。
 *
 * 与 batch_ask 的区别：问题/选项/推荐项/多选都是 pi 的结构化字段，回答必须走
 * `answers` 数组（按问题 id 一一对应），不能降级成 select/input。单选一题时点选项
 * 直接提交（对齐 TUI 的即时选择）；多题时单选项自动跳到下一道未答题，最后统一提交。
 */
export const NativeAskInlineBar = memo(function NativeAskInlineBar(props: {
	questions: AgentUiAskQuestion[];
	timeout?: number;
	onSubmit: (answers: AgentUiAskAnswer[]) => void;
	onCancel: () => void;
}) {
	const [drafts, setDrafts] = useState<NativeAskDraft[]>(() =>
		props.questions.map(() => ({ selected: [], custom: "", none: false, touched: false })),
	);
	const [currentIndex, setCurrentIndex] = useState(0);
	const [submitted, setSubmitted] = useState(false);
	// 选项预览跟随当前题目的推荐项/悬停项；切题时回到推荐项，避免显示上一题的预览。
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);

	const total = props.questions.length;
	const currentQuestion = props.questions[Math.min(currentIndex, Math.max(total - 1, 0))];
	const currentDraft = drafts[Math.min(currentIndex, Math.max(total - 1, 0))];

	// 切题后默认预览推荐项；没有推荐项时不主动展示预览，避免凭空挤占高度。
	useEffect(() => {
		setPreviewIndex(currentQuestion?.recommended ?? null);
	}, [currentQuestion?.id, currentQuestion?.recommended]);
	const previewOption =
		previewIndex !== null ? currentQuestion?.options[previewIndex] : undefined;
	const previewText = previewOption?.preview?.trim();

	const isAnswered = (draft: NativeAskDraft) =>
		draft.none || draft.touched || draft.selected.length > 0 || draft.custom.trim().length > 0;
	const allAnswered = drafts.length === total && drafts.every(isAnswered);
	const answeredCount = drafts.filter(isAnswered).length;

	const buildAnswers = (from: NativeAskDraft[]): AgentUiAskAnswer[] =>
		props.questions.map((question, index) => {
			const draft = from[index];
			const customInput = draft.custom.trim();
			return {
				id: question.id,
				selectedOptions: draft.none ? [] : draft.selected,
				...(customInput ? { customInput } : {}),
			};
		});

	const submit = (from: NativeAskDraft[]) => {
		if (submitted) return;
		if (!from.every(isAnswered)) return;
		setSubmitted(true);
		props.onSubmit(buildAnswers(from));
	};

	/** 多选题/多题流程：跳到下一道未答题（没有则停在最后一题等待手动提交）。 */
	const advance = (from: NativeAskDraft[], fromIndex: number) => {
		for (let offset = 1; offset <= total; offset += 1) {
			const index = (fromIndex + offset) % total;
			if (!isAnswered(from[index])) {
				setCurrentIndex(index);
				return;
			}
		}
		if (fromIndex < total - 1) setCurrentIndex(fromIndex + 1);
	};

	if (!currentQuestion || !currentDraft) return null;

	const selectOption = (label: string) => {
		const next = drafts.slice();
		const current = next[currentIndex];
		if (currentQuestion.multi) {
			const selected = current.selected.includes(label)
				? current.selected.filter((value) => value !== label)
				: [...current.selected, label];
			next[currentIndex] = { ...current, selected, none: false, touched: true };
			setDrafts(next);
			return;
		}
		next[currentIndex] = {
			selected: [label],
			custom: "",
			none: false,
			touched: true,
		};
		setDrafts(next);
		if (total === 1) {
			submit(next);
			return;
		}
		advance(next, currentIndex);
	};

	const updateCustom = (value: string) => {
		const next = drafts.slice();
		const current = next[currentIndex];
		next[currentIndex] = {
			...current,
			custom: value,
			// 单选与自定义互斥（pi 的解析器只接受二者之一）；多选允许选项+补充文本。
			selected: currentQuestion.multi ? current.selected : [],
			none: false,
			touched: value.trim().length > 0 || current.selected.length > 0,
		};
		setDrafts(next);
	};

	const submitCustom = () => {
		if (!currentDraft.custom.trim()) return;
		if (total === 1) {
			submit(drafts);
			return;
		}
		advance(drafts, currentIndex);
	};

	const chooseNone = () => {
		const next = drafts.slice();
		next[currentIndex] = { selected: [], custom: "", none: true, touched: true };
		setDrafts(next);
		if (total === 1) submit(next);
	};

	return (
		<div className="ask-inline-bar ask-inline-bar--native" aria-label={t("ask.nativeTitle")}>
			<div className="ask-inline-bar-header">
				<MessageCircle size={14} aria-hidden="true" />
				<span>{t("ask.nativeTitle")}</span>
				{total > 1 ? (
					<span className="ask-inline-bar-batch-progress">
						{t("ask.batchProgress", { done: String(answeredCount), total: String(total) })}
					</span>
				) : null}
				<span className="ask-inline-bar-cancel-hint">{t("ask.cancelBatchHint")}</span>
				<button
					className="ask-inline-bar-close"
					title={t("common.close")}
					onClick={props.onCancel}
					disabled={submitted}
				>
					<X size={14} aria-hidden="true" />
				</button>
			</div>

			{total > 1 ? (
				<div className="ask-batch-tabs" role="tablist" aria-label={t("ask.nativeTitle")}>
					{props.questions.map((question, index) => (
						<button
							key={question.id}
							type="button"
							role="tab"
							aria-selected={index === currentIndex}
							className={[
								"ask-batch-tab",
								index === currentIndex ? "active" : "",
								isAnswered(drafts[index]) ? "answered" : "",
							]
								.filter(Boolean)
								.join(" ")}
							onClick={() => setCurrentIndex(index)}
						>
							{index + 1}. {question.header || question.question}
						</button>
					))}
				</div>
			) : null}

			<div className="ask-inline-bar-question">
				{currentQuestion.header ? (
					<span className="ask-batch-question-num">{currentQuestion.header}</span>
				) : null}
				{currentQuestion.question}
				{currentQuestion.multi ? (
					<span className="ask-native-multi-hint">{t("ask.nativeMultiHint")}</span>
				) : null}
			</div>

			<div className="ask-inline-bar-body">
				{currentQuestion.options.length > 0 ? (
					<div
						className="ask-inline-bar-options ask-native-options"
						role="listbox"
						aria-multiselectable={currentQuestion.multi || undefined}
						aria-label={currentQuestion.question}
					>
						{currentQuestion.options.map((option, optionIndex) => {
							const selected = currentDraft.selected.includes(option.label);
							const recommended = currentQuestion.recommended === optionIndex;
							return (
								<button
									key={`${option.label}-${optionIndex}`}
									type="button"
									role="option"
									aria-selected={selected}
									className={`ask-inline-bar-option ask-native-option${selected ? " selected" : ""}`}
									onClick={() => selectOption(option.label)}
									onMouseEnter={() => setPreviewIndex(optionIndex)}
									onFocus={() => setPreviewIndex(optionIndex)}
									disabled={submitted}
								>
									<span className="ask-inline-bar-option-marker">{option.label}</span>
									{recommended ? (
										<span className="ask-native-option-badge">{t("ask.nativeRecommended")}</span>
									) : null}
									{option.description ? (
										<span className="ask-native-option-desc">{option.description}</span>
									) : null}
								</button>
							);
						})}
					</div>
				) : null}

				{/* omp ask 的 option.preview：TUI 里用于并排/侧栏展示详细方案，桌面端放在选项下方滚动预览。 */}
				{previewText ? (
					<div className="ask-native-preview" aria-live="polite">
						<div className="ask-native-preview-label">
							{t("ask.nativePreview")}
							{previewOption?.label ? ` · ${previewOption.label}` : ""}
						</div>
						<pre className="ask-native-preview-body">{previewText}</pre>
					</div>
				) : null}

				<div className="ask-native-custom">
					<textarea
						className="ask-batch-textarea ask-native-custom-field"
						value={currentDraft.custom}
						placeholder={t("ask.nativeCustomPlaceholder")}
						rows={2}
						disabled={submitted}
						onChange={(event) => updateCustom(event.target.value)}
					/>
					{currentDraft.custom.trim() ? (
						<button
							type="button"
							className="ask-batch-nav-btn primary"
							onClick={submitCustom}
							disabled={submitted}
						>
							{t("ask.nativeCustomSubmit")}
						</button>
					) : null}
					{currentQuestion.multi ? (
						<button
							type="button"
							className="ask-batch-nav-btn"
							onClick={chooseNone}
							disabled={submitted}
						>
							{t("ask.nativePickNone")}
						</button>
					) : null}
				</div>

				{props.timeout && props.timeout > 0 ? (
					<div className="ask-native-timeout-hint">{t("ask.nativeTimeoutHint")}</div>
				) : null}
			</div>

			<div className="ask-batch-nav">
				{total > 1 && currentIndex > 0 ? (
					<button
						className="ask-batch-nav-btn"
						onClick={() => setCurrentIndex(currentIndex - 1)}
						disabled={submitted}
					>
						{t("ask.batchPrev")}
					</button>
				) : null}
				<div className="ask-batch-nav-spacer" />
				{total > 1 && currentIndex < total - 1 ? (
					<button
						className="ask-batch-nav-btn primary"
						onClick={() => setCurrentIndex(currentIndex + 1)}
						disabled={submitted}
					>
						{t("ask.batchNext")}
					</button>
				) : null}
				<button
					className="ask-batch-submit-all-btn"
					onClick={() => submit(drafts)}
					disabled={submitted || !allAnswered}
				>
					{t("ask.nativeSubmitAnswers")}
				</button>
			</div>
		</div>
	);
});
