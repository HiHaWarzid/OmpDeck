/**
 * 子代理（omp task 工具派生的子会话）实时分区，渲染在 composer dock 里。
 *
 * 数据来自 subagents 切片（主进程订阅 subagent_lifecycle / subagent_progress 后
 * 推送 agents:subagents），分区自己订阅该切片，progress 高频刷新不会唤醒 App 根组件。
 * 子代理正文不在推送里：点开记录时按 subagentId 让主进程从会话文件读取。
 *
 * 只有运行中/失败的行默认可见：已结束的子代理留在 chip 的“共 N 个”里，点“显示已结束”
 * 才展开——否则十几个历史行会吃掉整个 dock 的高度。
 */
import { useMemo, useState } from "react";
import {
	Ban,
	Bot,
	Check,
	ChevronDown,
	FileText,
	Loader2,
	MessageSquare,
	X,
} from "lucide-react";
import type { PiDesktopApi } from "../../../../../shared/api";
import type { AgentSubagent } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { useWorkspaceSlice } from "../../../workspace/hooks";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { TextField } from "../../ui/TextField";
import { DockSection } from "../composer/ComposerDock";
import { formatCompact, formatDuration } from "../format";
import { SubagentTranscriptModal } from "./SubagentTranscriptModal";
import { isSubagentRunning } from "./subagentStatus";

function isSubagentFailed(subagent: AgentSubagent): boolean {
	return subagent.status === "failed" || subagent.status === "error";
}

function statusLabel(subagent: AgentSubagent): string {
	switch (subagent.status) {
		case "running":
		case "started":
			return t("app.subagentStatusRunning");
		case "completed":
			return t("app.subagentStatusCompleted");
		case "aborted":
		case "cancelled":
			return t("app.subagentStatusAborted");
		case "failed":
		case "error":
			return t("app.subagentStatusFailed");
		default:
			return t("app.subagentStatusUnknown");
	}
}

function StatusIcon({ subagent }: { subagent: AgentSubagent }) {
	if (isSubagentRunning(subagent)) {
		return <Loader2 size={13} strokeWidth={2} className="subagent-spin" aria-hidden="true" />;
	}
	if (subagent.status === "completed") {
		return <Check size={13} strokeWidth={2.2} aria-hidden="true" />;
	}
	return <Ban size={13} strokeWidth={2} aria-hidden="true" />;
}

export function SubagentDockSection({
	agentId,
	agents,
}: {
	agentId: string;
	/** 主进程 agents API；模块级常量引用稳定，可直接作为只读依赖。 */
	agents: PiDesktopApi["agents"];
}) {
	const subagents = useWorkspaceSlice(agentId, "subagents") ?? [];
	// 已结束的行默认折叠：运行中/失败的行才值得占 dock 的高度。
	const [showSettled, setShowSettled] = useState(false);
	const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
	const [steerTarget, setSteerTarget] = useState<string | null>(null);
	const [steerDraft, setSteerDraft] = useState("");
	const [busyId, setBusyId] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
	const [transcriptId, setTranscriptId] = useState<string | null>(null);

	const visible = useMemo(
		() =>
			subagents.filter(
				// 已 dismiss 的 id 若再次进入运行态（omp 允许同 id 复用），说明是新一次运行，
				// 重新展示；否则保持隐藏。
				(subagent) => !hiddenIds.has(subagent.id) || isSubagentRunning(subagent),
			),
		[subagents, hiddenIds],
	);
	const runningCount = visible.filter(isSubagentRunning).length;
	const failedCount = visible.filter(
		(subagent) => !isSubagentRunning(subagent) && isSubagentFailed(subagent),
	).length;
	const settledCount = visible.length - runningCount - failedCount;
	// 运行中与失败的行始终展示；其余（completed/aborted）归入“已结束”折叠区。
	const rows = showSettled
		? visible
		: visible.filter((subagent) => isSubagentRunning(subagent) || isSubagentFailed(subagent));
	const chipMeta = [
		runningCount > 0 ? t("app.subagentChipRunning", { count: runningCount }) : null,
		failedCount > 0 ? t("app.subagentChipFailed", { count: failedCount }) : null,
	]
		.filter(Boolean)
		.join(" · ") || t("app.subagentChipTotal", { count: visible.length });
	const transcriptTarget = transcriptId
		? subagents.find((subagent) => subagent.id === transcriptId)
		: undefined;

	const transcriptModal = (
		<SubagentTranscriptModal
			open={Boolean(transcriptTarget)}
			onClose={() => setTranscriptId(null)}
			agentId={agentId}
			agents={agents}
			subagent={transcriptTarget}
		/>
	);

	const reportError = (subagentId: string, error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		setRowError({ id: subagentId, message });
	};

	const cancel = async (subagent: AgentSubagent) => {
		setBusyId(subagent.id);
		setRowError(null);
		try {
			const cancelled = await agents.cancelSubagent(agentId, subagent.id);
			// omp 返回 false = 子代理已自行结束；没有失败，只是状态时代差。
			if (!cancelled) setRowError({ id: subagent.id, message: t("app.subagentAlreadyDone") });
		} catch (error) {
			reportError(subagent.id, error);
		} finally {
			setBusyId(null);
		}
	};

	const sendSteer = async (subagent: AgentSubagent) => {
		const message = steerDraft.trim();
		if (!message) return;
		setBusyId(subagent.id);
		setRowError(null);
		try {
			await agents.steerSubagent(agentId, subagent.id, message);
			setSteerDraft("");
			setSteerTarget(null);
		} catch (error) {
			reportError(subagent.id, error);
		} finally {
			setBusyId(null);
		}
	};

	// 全部行被隐藏时整个分区（含 chip）消失，但已打开的 transcript 不能跟着卸载。
	if (visible.length === 0) return transcriptId ? transcriptModal : null;

	return (
		<>
			<DockSection
				id="subagents"
				icon={
					runningCount > 0 ? (
						<Loader2 size={13} strokeWidth={1.8} className="composer-dock-spin" />
					) : (
						<Bot size={13} strokeWidth={1.8} />
					)
				}
				label={t("app.subagents")}
				meta={chipMeta}
				tone={failedCount > 0 ? "danger" : runningCount > 0 ? "info" : "neutral"}
			>
				<div className="subagent-list">
					{rows.map((subagent) => {
						const running = isSubagentRunning(subagent);
						const name = subagent.description || subagent.agent || subagent.id;
						const intent = subagent.lastIntent || subagent.assignment || subagent.task;
						const lastTool = subagent.recentTools?.at(-1);
						const stats = [
							subagent.toolCount != null
								? t("app.subagentToolCalls", { count: subagent.toolCount })
								: null,
							subagent.tokens != null && subagent.tokens > 0
								? t("app.subagentTokens", {
										count: formatCompact(subagent.tokens),
									})
								: null,
							subagent.durationMs != null
								? formatDuration(subagent.durationMs)
								: null,
						].filter(Boolean);
						return (
							<div
								key={subagent.id}
								className={`subagent-row status-${running ? "running" : "settled"}`}
								onClick={(event) => {
									// 行主体可点开记录；行内的按钮/steer 输入必须保留自己的点击语义。
									if (
										(event.target as HTMLElement).closest(
											"button, input, textarea, label",
										)
									) {
										return;
									}
									setTranscriptId(subagent.id);
								}}
							>
								<span className={`subagent-status status-${subagent.status}`} title={statusLabel(subagent)}>
									<StatusIcon subagent={subagent} />
								</span>
								<div className="subagent-main">
									<div className="subagent-row-head">
										<strong className="subagent-name" title={name}>
											{name}
										</strong>
										<span className="subagent-badge">{statusLabel(subagent)}</span>
										{stats.length > 0 && (
											<span className="subagent-stats">{stats.join(" · ")}</span>
										)}
									</div>
									{intent && <div className="subagent-intent">{intent}</div>}
									{lastTool && (
										<div className={`subagent-tool ${lastTool.isError ? "is-error" : ""}`}>
											<span className="subagent-tool-name">{lastTool.tool}</span>
											{lastTool.args && (
												<span className="subagent-tool-args">{lastTool.args}</span>
											)}
										</div>
									)}
									{rowError?.id === subagent.id && (
										<div className="subagent-error">{rowError.message}</div>
									)}
									{steerTarget === subagent.id && (
										<div className="subagent-steer">
											<TextField
												label={t("app.subagentSteer")}
												value={steerDraft}
												onChange={setSteerDraft}
												placeholder={t("app.subagentSteerPlaceholder")}
												disabled={busyId === subagent.id}
												onKeyDown={(event) => {
													if (event.key === "Enter" && !event.shiftKey) {
														event.preventDefault();
														void sendSteer(subagent);
													}
												}}
											/>
											<Button
												variant="primary"
												buttonSize="sm"
												loading={busyId === subagent.id}
												onClick={() => void sendSteer(subagent)}
											>
												{t("app.send")}
											</Button>
										</div>
									)}
								</div>
								<div className="subagent-actions">
									<IconButton
										label={t("app.subagentTranscript")}
										onClick={() => setTranscriptId(subagent.id)}
									>
										<FileText size={14} strokeWidth={1.8} />
									</IconButton>
									{running && (
										<>
											<IconButton
												label={t("app.subagentSteerAction")}
												onClick={() => {
													setRowError(null);
													setSteerDraft("");
													setSteerTarget((current) =>
														current === subagent.id ? null : subagent.id,
													);
												}}
											>
												<MessageSquare size={14} strokeWidth={1.8} />
											</IconButton>
											<IconButton
												label={t("app.subagentCancel")}
												onClick={() => void cancel(subagent)}
												disabled={busyId === subagent.id}
											>
												<Ban size={14} strokeWidth={1.8} />
											</IconButton>
										</>
									)}
									{!running && (
										<IconButton
											label={t("app.subagentDismiss")}
											onClick={() =>
												setHiddenIds((current) => {
													const next = new Set(current);
													next.add(subagent.id);
													return next;
												})
											}
										>
											<X size={14} strokeWidth={1.8} />
										</IconButton>
									)}
								</div>
							</div>
						);
					})}
				</div>
				{settledCount > 0 && (
					<button
						type="button"
						className="subagent-settled-toggle"
						onClick={() => setShowSettled((value) => !value)}
						aria-expanded={showSettled}
					>
						<ChevronDown
							size={11}
							strokeWidth={2}
							className={`composer-dock-chip-chevron${showSettled ? " is-open" : ""}`}
							aria-hidden="true"
						/>
						{showSettled
							? t("app.subagentHideSettled")
							: t("app.subagentShowSettled", { count: settledCount })}
					</button>
				)}
			</DockSection>
			{transcriptModal}
		</>
	);
}
