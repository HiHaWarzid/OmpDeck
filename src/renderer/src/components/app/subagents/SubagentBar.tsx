/**
 * 子代理（omp task 工具派生的子会话）实时面板。
 *
 * 数据来自 subagents 切片（主进程订阅 subagent_lifecycle / subagent_progress 后
 * 推送 agents:subagents），面板只订阅该切片，progress 高频刷新不会唤醒 App 根组件。
 * 子代理正文不在推送里：点开记录时按 subagentId 让主进程从会话文件读取。
 */
import { useMemo, useState } from "react";
import {
	Ban,
	Bot,
	Check,
	ChevronDown,
	ChevronUp,
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
import { formatCompact, formatDuration } from "../format";
import { SubagentTranscriptModal } from "./SubagentTranscriptModal";
import { isSubagentRunning } from "./subagentStatus";

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

export function SubagentBar({
	agentId,
	agents,
}: {
	agentId: string;
	/** 主进程 agents API；模块级常量引用稳定，可直接作为只读依赖。 */
	agents: PiDesktopApi["agents"];
}) {
	const subagents = useWorkspaceSlice(agentId, "subagents") ?? [];
	const [collapsed, setCollapsed] = useState(false);
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

	// 全部行被隐藏时面板整体消失，但已打开的 transcript 不能跟着卸载。
	if (visible.length === 0) return transcriptId ? transcriptModal : null;

	return (
		<>
			<div className="subagent-bar">
				<button
					type="button"
					className="subagent-bar-head"
					onClick={() => setCollapsed((value) => !value)}
					aria-expanded={!collapsed}
					title={collapsed ? t("app.subagentExpand") : t("app.subagentCollapse")}
				>
					<Bot size={14} strokeWidth={1.8} aria-hidden="true" />
					<span className="subagent-bar-title">{t("app.subagents")}</span>
					<span className="subagent-bar-meta">
						{t("app.subagentsSummary", {
							running: runningCount,
							total: visible.length,
						})}
					</span>
					{collapsed ? (
						<ChevronUp size={14} strokeWidth={1.8} aria-hidden="true" />
					) : (
						<ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
					)}
				</button>
				{!collapsed && (
					<div className="subagent-list">
						{visible.map((subagent) => {
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
				)}
			</div>
			{transcriptModal}
		</>
	);
}
