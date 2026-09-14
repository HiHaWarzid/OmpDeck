/** 提问卡片：单条 ask_question 卡片与批量提问的内联回答条。 */
import { memo, useEffect, useRef, useState } from "react";
import { getComposerEnterIntent } from "../../../composerBehavior";
import { AlertTriangle, Check, ClipboardList, MessageCircle, X } from "lucide-react";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import type { ChatMessage } from "../../../../../shared/types";

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
