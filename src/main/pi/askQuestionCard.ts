/**
 * ask_question 工具卡片解析 -- 把 pi 的 ask_question 工具调用结果转换为前端 ToolCard 用的 _askCard。
 *
 * 从 messageTimeline 提取的纯函数模块，聚焦 ask_question 专属逻辑：
 *   - tryParseBatchAskEnvelope: 识别扩展塞入 input title 的批量问卷 JSON envelope
 *   - extractAskQuestionDetails: 从 toolResult/args 中提取 ask_question 详情
 *   - buildAskCard: 把 details 转成 _askCard 结构，处理 aborted 状态
 *
 * 依赖方向：无外部依赖，纯函数。
 */

/**
 * 识别批量 ask_question envelope：扩展把 questions JSON 塞进 input 的 title，
 * 桌面端识别后渲染 Tab 问卷，而不是把整段 JSON 当普通输入题。
 */
export function tryParseBatchAskEnvelope(title: string): {
	review?: boolean;
	questions: Array<Record<string, unknown>>;
} | null {
	const raw = title?.trim();
	if (!raw || raw[0] !== "{") return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed?.__piDeckBatchAsk !== 1) return null;
		if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
		return {
			review: parsed.review === true,
			questions: parsed.questions as Array<Record<string, unknown>>,
		};
	} catch {
		return null;
	}
}

/**
 * 从 ask_question 工具调用的 result/args 中提取问题详情。
 * pi RPC 返回格式可能为 result.details 嵌套 或 result 顶层（无 details 包装），
 * 也可能从 args.questions 提取（当 result 只有 answer 字符串时）。
 */
export function extractAskQuestionDetails(
	toolName: string,
	result: unknown,
	args: unknown,
): Record<string, unknown> | undefined {
	if (toolName !== "ask_question") return undefined;

	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		const rDetails = r.details as Record<string, unknown> | undefined;
		if (rDetails?.question || Array.isArray(rDetails?.answers) || Array.isArray(rDetails?.questions)) {
			return rDetails;
		}
		if (r.question || Array.isArray(r.answers) || Array.isArray(r.questions)) {
			return r;
		}
	}

	let parsedArgs: unknown = args;
	if (typeof args === "string") {
		try {
			parsedArgs = JSON.parse(args);
		} catch {
			parsedArgs = undefined;
		}
	}
	if (parsedArgs && typeof parsedArgs === "object") {
		const a = parsedArgs as Record<string, unknown>;
		if (Array.isArray(a.questions) && a.questions.length > 0) {
			const answerValue =
				typeof result === "string"
					? result
					: (result as Record<string, unknown>)?.value ?? (result as Record<string, unknown>)?.answer ?? null;
			return {
				questions: a.questions,
				answers: answerValue != null ? [{ id: (a.questions[0] as Record<string, unknown>)?.id ?? "default", value: answerValue, label: String(answerValue) }] : [],
				cancelled: false,
			};
		}
		if (a.question) {
			const answerValue =
				typeof result === "string"
					? result
					: (result as Record<string, unknown>)?.value ?? (result as Record<string, unknown>)?.answer ?? null;
			return {
				question: a.question,
				type: a.type,
				options: a.options,
				answer: answerValue,
				answered: answerValue !== null && answerValue !== undefined,
				answerLabel: answerValue != null ? String(answerValue) : undefined,
			};
		}
	}
	return undefined;
}

/**
 * 把 ask_question details 转成前端 ToolCard 用的 _askCard。
 * aborted 参数由调用方传入（live 路径传 runtime.abortedDuringAsk，历史路径传 false），
 * 用于在用户中途取消时隐藏答案。
 *
 * 支持两种格式：
 *   - 批量问卷（questions/answers 数组）→ 渲染为多题卡片
 *   - 单问题（question 字段）→ 渲染为单题卡片
 */
export function buildAskCard(
	askDetails: Record<string, unknown> | undefined,
	aborted: boolean,
): Record<string, unknown> | undefined {
	if (!askDetails) return undefined;

	if (Array.isArray(askDetails.questions) || Array.isArray(askDetails.answers)) {
		const questions = Array.isArray(askDetails.questions) ? askDetails.questions : [];
		const answers = Array.isArray(askDetails.answers) ? askDetails.answers : [];
		const cancelled = aborted || askDetails.cancelled === true;
		const items = questions.map((q: Record<string, unknown>, i: number) => {
			const a = answers.find((x: Record<string, unknown>) => x?.id === q?.id) ?? answers[i];
			const value = cancelled ? null : (a as Record<string, unknown>)?.value ?? null;
			const hasAnswer = value !== null && value !== undefined;
			return {
				id: String(q?.id ?? (a as Record<string, unknown>)?.id ?? `q${i + 1}`),
				question: String(q?.question ?? (a as Record<string, unknown>)?.id ?? ""),
				type: String((a as Record<string, unknown>)?.type ?? q?.type ?? "input"),
				answered: !cancelled && hasAnswer,
				answer: value,
				answerLabel: cancelled ? undefined : (a as Record<string, unknown>)?.label ?? (hasAnswer ? String(value) : undefined),
				options: q?.options,
				wasCustom: (a as Record<string, unknown>)?.wasCustom === true,
			};
		});
		// 无 questions 但有 answers（如旧版会话）：把 answers 直接当 items
		if (items.length === 0 && answers.length > 0) {
			for (const a of answers as Array<Record<string, unknown>>) {
				const value = cancelled ? null : a?.value ?? null;
				const hasAnswer = value !== null && value !== undefined;
				items.push({
					id: String(a?.id ?? "q"),
					question: String(a?.id ?? ""),
					type: String(a?.type ?? "input"),
					answered: !cancelled && hasAnswer,
					answer: value,
					answerLabel: cancelled ? undefined : a?.label ?? (hasAnswer ? String(value) : undefined),
					options: undefined,
					wasCustom: a?.wasCustom === true,
				});
			}
		}
		const anyAnswered = items.some((it: { answered: boolean }) => it.answered);
		const first = items[0] as { answer: unknown; answerLabel: unknown } | undefined;
		return {
			question: `问卷（${items.length} 题）`,
			type: "batch",
			answered: !cancelled && anyAnswered,
			answer: first?.answer ?? null,
			answerLabel: first?.answerLabel,
			options: undefined,
			cancelled,
			items,
		};
	}

	if (askDetails.question) {
		const rawAnswer = aborted ? null : askDetails.answer;
		const hasAnswer = rawAnswer !== null && rawAnswer !== undefined && rawAnswer !== "";
		const answered = aborted
			? false
			: typeof askDetails.answered === "boolean"
				? askDetails.answered
				: hasAnswer;
		return {
			question: askDetails.question,
			type: askDetails.type,
			answered,
			answer: aborted ? null : askDetails.answer,
			answerLabel: aborted ? undefined : (askDetails.answerLabel as string | undefined) ?? (hasAnswer ? String(rawAnswer) : undefined),
			options: askDetails.options,
		};
	}
	return undefined;
}
