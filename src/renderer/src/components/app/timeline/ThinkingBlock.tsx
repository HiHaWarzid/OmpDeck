/** 时间线思考块与等待指示器。 */
import { memo, useEffect, useState } from "react";
import { ChevronDown, Brain } from "lucide-react";
import { t } from "../../../i18n";
import { formatDuration, stripAnsi } from "../format";

/** 思考过程卡片：默认展开显示完整推理文本（与 TodoWrite 一致），可手动折叠。 */
export const ThinkingBlock = memo(function ThinkingBlock(props: {
	text: string;
	startedAt?: number;
	endedAt?: number;
	showThinking?: boolean;
}) {
	// 默认展开：用户要求思考与 todo 卡片一致，直接展示完整推理；
	// 点击标题行可折叠为单行摘要。流式期间同样展开，推理过程实时可见。
	const [expanded, setExpanded] = useState(true);
	// 流式思考进行中（有起点、未正常结束）时每秒刷新计时
	const [, setTick] = useState(0);
	useEffect(() => {
		// endedAt 早于 startedAt 视为残留数据（新一轮思考已开始而旧结束标记未清），
		// 仍按进行中实时计时，与下方 duration 的兜底逻辑保持一致。
		if (props.startedAt == null) return;
		if (props.endedAt != null && props.endedAt >= props.startedAt) return;
		const timer = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [props.startedAt, props.endedAt]);
	if (!props.showThinking || !props.text.trim()) return null;
	const previewLen = 220;
	const needsTruncate = props.text.length > previewLen;
	const previewText =
		expanded || !needsTruncate
			? props.text
			: `${props.text.slice(0, previewLen)}...`;
	// 计算思考耗时：有 endedAt 用 endedAt，流式进行中用当前时间实时计时
	const durationMs =
		props.startedAt != null
			? (props.endedAt != null && props.endedAt >= props.startedAt
				? props.endedAt
				: Date.now()) - props.startedAt
			: null;
	const durationText = durationMs != null && durationMs >= 0 ? formatDuration(durationMs) : null;
	// 单行摘要：流式中（有起点未结束）取最新一行并标记流式态（扫光动画）；
	// 结束后显示第一行并静止。多段思考按最后一段的最后一行取。
	const isStreamingThinking =
		props.startedAt != null &&
		(props.endedAt == null || props.endedAt < props.startedAt);
	const foldedLine = (() => {
		const clean = stripAnsi(props.text).trim();
		if (!clean) return "";
		if (isStreamingThinking) {
			const lastLine = clean.split("\n").filter(Boolean).pop() ?? "";
			return lastLine;
		}
		return clean.split("\n").find((l) => l.trim()) ?? clean;
	})();
	return (
		<section
			className={`thinking-card${expanded ? " expanded" : ""}${isStreamingThinking ? " thinking-card--streaming" : ""}`}
		>
			<button
				className="thinking-card-trigger"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				<Brain size={15} />
				<span>{t("thinking.title")}</span>
				<ChevronDown
					size={15}
					className={`thinking-card-chevron${expanded ? " open" : ""}`}
				/>
				{!expanded && foldedLine && (
					<span className="thinking-card-subtitle" title={props.text}>
						{foldedLine}
					</span>
				)}
				{durationText && <small>{durationText}</small>}
			</button>
			{expanded && <div className="thinking-card-content">{previewText}</div>}
		</section>
	);
});
/**
 * 流式响应指示器（三点脉动动画 + 状态文案），在 agent 运行/流式期间显示。
 *
 * 状态优先级：
 *  1. 工具执行中 → "正在工具调用"（琥珀色）
 *  2. 有思考文本 / 流式回答中 → "正在回应"
 *  3. 过渡等待 → 只显示三点动画，无标签
 *
 * 注意：原来的 "正在思考" 状态已合并到 "正在回应"，不再单独展示。
 */
export function RespondingIndicator(props: {
	thinking?: string;
	showThinking?: boolean;
	isExecutingTool?: boolean;
	isStreaming?: boolean;
}) {
	const { isExecutingTool, isStreaming, thinking, showThinking } = props;

	let kind: "executing" | "responding" | "waiting";
	let label: string;

	if (isExecutingTool) {
		kind = "executing";
		label = t("thinking.executing");
	} else if ((showThinking && thinking && thinking.length > 0) || isStreaming) {
		// 有思考文本或流式回答中统一显示“正在回应”
		kind = "responding";
		label = t("thinking.responding");
	} else {
		// 过渡等待：只显示三点动画
		kind = "waiting";
		label = "...";
	}

	return (
		<div className="responding-indicator" data-kind={kind}>
			<span className="responding-indicator-dots" aria-hidden="true">
				<span />
				<span />
				<span />
			</span>
			{/* 标签始终渲染，waiting 态通过 CSS visibility:hidden 隐藏，保持容器宽度稳定 */}
			<span className="responding-indicator-label">{label}</span>
		</div>
	);
}
