/** 会话状态与 composer 工具条：状态行、能力芯片与输入区工具栏。 */
import { memo, type ReactNode } from "react";
import { X, FoldVertical } from "lucide-react";
import { t } from "../../../i18n";
import { Badge } from "../../ui/Badge";
import type { AgentRuntimeState, ComposerAgentMode } from "../../../../../shared/types";
import { THINKING_LEVELS } from "./thinkingLevels";
import { formatCompact } from "../format";

export const SessionStatus = memo(function SessionStatus(props: {
	state?: AgentRuntimeState;
}) {
	const state = props.state;
	if (!state) return null;
	// 会话头部状态用轻量 Badge，与左右分栏/新会话按钮同一套素雅边框语言，
	// 避免各 chip 自定义高度/圆角造成头部控件参差。
	return (
		<div className="session-status">
			{state.contextPercent != null && (
				<Badge variant="outline" badgeSize="sm" className="ctx-chip">
					{t("app.ctx")}:{" "}
					{state.contextPercent?.toFixed?.(1) ??
						state.contextPercent}
					% / {formatCompact(state.contextWindow)}
					{state.inputTokens != null && (
						<>{" "}↑ {formatCompact(state.inputTokens)}</>
					)}
					{state.outputTokens != null && (
						<>{" "}↓ {formatCompact(state.outputTokens)}</>
					)}
				</Badge>
			)}
			{(state.cacheHitPercent != null || state.cacheTotal != null) && (
				<Badge variant="outline" badgeSize="sm" className="cache-chip">
					{state.cacheHitPercent != null && (
						<>{t("app.cacheHit")}: {state.cacheHitPercent?.toFixed?.(0) ?? state.cacheHitPercent}%</>
					)}
					{state.cacheHitPercent != null && state.cacheTotal != null && " "}
					{state.cacheTotal != null && (
						<>{t("app.cache")}: {formatCompact(state.cacheTotal)}</>
					)}
				</Badge>
			)}
			{state.cost != null && (
				<Badge
					variant="outline"
					badgeSize="sm"
					className="cost-chip"
					title={t("app.totalCost")}
				>
					${state.cost.toFixed(3)}
				</Badge>
			)}
		</div>
	);
});
/**
 * Composer 底栏状态 chips（模型 / 思考级别 / 上下文压缩）。
 * 从巨型 App() 抽出并 memo：activeRuntimeState 在纯文本流式期间引用稳定
 * （主进程仅在工具边沿推送 runtimeState），流式 token 不应让这些按钮重渲染。
 * 回调类 prop 由比较器忽略（App 侧函数声明每次重执行重建，但内容不变时无需渲染）。
 */
export const ComposerStatusChips = memo(
	function ComposerStatusChips(props: {
		state?: AgentRuntimeState;
		activeAgentId?: string;
		isAgentBusy: boolean;
		isAgentStarting: boolean;
		compacting: boolean;
		onOpenModelPicker: () => void;
		onOpenThinkingPicker: () => void;
		onCompact: () => void;
	}) {
		const {
			state,
			activeAgentId,
			isAgentBusy,
			isAgentStarting,
			compacting,
			onOpenModelPicker,
			onOpenThinkingPicker,
			onCompact,
		} = props;
		return (
			<div className="composer-bottom-center">
				<button
					type="button"
					className="composer-bar-btn model"
					disabled={isAgentBusy || isAgentStarting}
					onClick={onOpenModelPicker}
					title={t("app.modelPickerTitle")}
				>
					{state?.modelName
						? `${state.provider ? `${state.provider}/` : ""}${state.modelName}`
						: t("app.model") + ": —"}
				</button>
				{state?.thinkingLevel && (
					<button
						type="button"
						className="composer-bar-btn thinking"
						disabled={isAgentBusy || isAgentStarting}
						onClick={onOpenThinkingPicker}
						title={t("app.thinkingPickerTitle")}
					>
						{(() => {
							const level = THINKING_LEVELS.find((l) => l.value === state.thinkingLevel);
							return level ? t(level.labelKey) : state.thinkingLevel;
						})()}
					</button>
				)}
				{/* 上下文压缩：与 /compact 同一路径。
				    仅在占用达到阈值后显示，避免会话过小仍点压缩触发 Nothing to compact。
				    阈值与旧 ComposerToolbar 一致（>30%）；压缩进行中始终保留入口。 */}
				{(() => {
					const contextPercent =
						state?.contextPercent != null ? Number(state.contextPercent) : null;
					const isCompactingNow = compacting || Boolean(state?.isCompacting);
					// 30% 以下几乎总会被 pi 拒绝；70%/90% 用色阶提示紧迫度，而不是常驻抢眼按钮。
					// 压缩进行中即使百分比短暂缺失也保留入口，避免状态闪断。
					const showCompactButton =
						Boolean(activeAgentId) &&
						!activeAgentId?.startsWith("pending-") &&
						(isCompactingNow || (contextPercent != null && contextPercent > 30));
					if (!showCompactButton) return null;
					const urgency =
						contextPercent != null && contextPercent >= 90
							? " critical"
							: contextPercent != null && contextPercent >= 70
								? " warn"
								: "";
					return (
						<button
							type="button"
							className={`composer-bar-btn compact${urgency}${isCompactingNow ? " compacting" : ""}`}
							disabled={
								isAgentStarting ||
								isCompactingNow ||
								Boolean(state?.isStreaming)
							}
							onClick={onCompact}
							title={
								contextPercent != null
									? t("app.contextCompactTitle", {
											percent: contextPercent.toFixed(1),
										})
									: t("app.compact")
							}
							aria-label={t("app.compact")}
						>
							<FoldVertical size={13} strokeWidth={1.8} aria-hidden="true" />
							<span>
								{isCompactingNow
									? t("app.compacting")
									: contextPercent != null
										? t("app.compactUsage", {
												percent: contextPercent.toFixed(0),
											})
										: t("app.compact")}
							</span>
						</button>
					);
				})()}
			</div>
		);
	},
	(previous, next) =>
		previous.state === next.state &&
		previous.activeAgentId === next.activeAgentId &&
		previous.isAgentBusy === next.isAgentBusy &&
		previous.isAgentStarting === next.isAgentStarting &&
		previous.compacting === next.compacting,
);
export function ComposerToolbar(props: {
	state?: AgentRuntimeState;
	compacting: boolean;
	disabled?: boolean;
	onPickModel: () => void;
	onPickPromptTemplate: () => void;
	onPickThinking: () => void;
	onCompact: () => void;
	/** 当前发送模式，用于按钮文字和轻高亮 */
	composerAgentMode?: ComposerAgentMode;
	onOpenComposerModePicker?: () => void;
	/** 取消计划模式：直接切回普通发送模式，不经过模式选择器 */
	onCancelPlan?: () => void;
	/** 在思考按钮后插入的额外指示器（如飞书链接状态） */
	feishuIndicator?: ReactNode;
	/** 会话文件路径卡片,渲染在思考按钮之后、feishuIndicator 之后 */
	pathIndicator?: ReactNode;
	/** 文件引用按钮回调 */
	onAttachFile?: () => void;

}) {
	const ctxPercent = props.state?.contextPercent;
	const showCompact = ctxPercent != null && ctxPercent > 30;
	// 根据当前 thinkingLevel 查找对应的多语言标签
	const currentThinkingLevel = props.state?.thinkingLevel;
	const thinkingLevelLabel = currentThinkingLevel
		? THINKING_LEVELS.find((level) => level.value === currentThinkingLevel)?.labelKey
		: undefined;
	const thinkingDisplay = thinkingLevelLabel ? t(thinkingLevelLabel) : "-";

	// mode 选择器：和模型/思考面板保持一致，默认普通。
	const activeMode = props.composerAgentMode ?? "normal";
	const activeModeLabel = activeMode === "plan" ? t("app.composerModePlan") : t("app.composerModeNormal");

	return (
		<div className="composer-toolbar">
			{props.onOpenComposerModePicker && (
				<button
					className={activeMode === "plan" ? "composer-mode-active" : ""}
					disabled={props.disabled}
					onClick={props.onOpenComposerModePicker}
					title={t("app.composerModeTitle")}
				>
					{activeModeLabel}
				</button>
			)}
			{activeMode === "plan" && props.onCancelPlan && (
				<button
					className="composer-mode-cancel"
					disabled={props.disabled}
					onClick={props.onCancelPlan}
					title={t("app.composerModeCancelPlan")}
				>
					<X size={14} strokeWidth={2.5} aria-hidden="true" />
					{t("app.composerModeCancelPlan")}
				</button>
			)}
			<button onClick={props.onPickModel} disabled={props.disabled}>
				{t("app.model")}: {props.state?.provider ? `${props.state.provider}/` : ""}{props.state?.modelName ?? "-"}
			</button>
			<button
				onClick={props.onPickPromptTemplate}
				disabled={props.disabled}
				title={t("app.promptTemplatePickerTitle")}
			>
				{t("app.promptTemplatePickerTitle")}
			</button>
			<button onClick={props.onPickThinking} disabled={props.disabled}>
				{t("app.think")}: {thinkingDisplay}
			</button>
			{props.onAttachFile && (
				<button
					onClick={props.onAttachFile}
					disabled={props.disabled}
					title={t("app.attachFileDesc")}
				>
					{t("app.attachFile")}
				</button>
			)}
			{props.feishuIndicator}
			{props.pathIndicator}

			{showCompact && (
				<button
					className={
						props.state?.isCompacting || props.compacting ? "compacting" : ""
					}
					disabled={
						props.state?.isCompacting ||
						props.compacting ||
						!!props.state?.isStreaming
					}
					title={t("app.contextCompactTitle", {
						percent: ctxPercent.toFixed(1),
					})}
					onClick={props.onCompact}
				>
					{props.state?.isCompacting || props.compacting
						? t("app.compacting")
						: `${t("app.compact")} ${ctxPercent.toFixed(0)}%`}
				</button>
			)}
		</div>
	);
}
