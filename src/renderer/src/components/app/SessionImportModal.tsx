import { useState } from "react";
import { Check, RefreshCw, UploadCloud } from "lucide-react";
import type { ImportSummary, Project } from "../../../../shared/types";
import { t } from "../../i18n";
import { CloseIconButton } from "../ui/IconButton";
import { getImportThreadProjection } from "../../agentListDisplay";
import type { ImportSourceDescriptor } from "./sessionImportSources";

/**
 * 会话导入弹框 —— 三个导入源（Codex / Claude / OpenCode）共用一个实现。
 *
 * 差异全在 ImportSourceDescriptor：文案前缀、状态文案、是否按父子线程分组。
 * 此前这里是三个近乎逐字相同的组件（且带 @ts-nocheck），任一 UI 调整都要改三处。
 */

function displayPath(path?: string) {
	if (!path) return "";
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/");
	if (parts.length <= 2) return normalized;
	return `.../${parts.slice(-2).join("/")}`;
}

function formatBytes(value: number) {
	if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${value} B`;
}

export function SessionImportModal(props: {
	source: ImportSourceDescriptor;
	project: Project;
	sessions: ImportSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: { imported: number; failed: number; results: Array<{ sourcePath: string; targetPath?: string; title?: string; success: boolean; error?: string }> } | null;
	onClose: () => void;
	onRefresh: () => void;
	onToggle: (sourcePath: string) => void;
	onToggleAll: () => void;
	onImport: () => void;
}) {
	const { source, labels } = { source: props.source, labels: props.source.labels };
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
	const [showOrphanSubagents, setShowOrphanSubagents] = useState(false);
	const selected = new Set(props.selectedPaths);
	const statusLabel = (session: ImportSummary) => {
		if (session.status === "current") return t(labels.statusCurrent);
		if (session.status === "outdated") return t(labels.statusOutdated);
		return t(labels.statusNew);
	};
	const subagentLabel = (session: ImportSummary) => {
		const parts = [session.agentNickname, session.agentRole].filter(Boolean);
		return parts.length ? parts.join(" · ") : labels.subagent ? t(labels.subagent) : "";
	};

	const toggleGroup = (parentId: string) => {
		setExpandedGroups((current) => {
			const next = new Set(current);
			if (next.has(parentId)) next.delete(parentId);
			else next.add(parentId);
			return next;
		});
	};

	const renderRow = (session: ImportSummary, className = "codex-session-row") => (
		<label key={session.sourcePath} className={className}>
			<input
				type="checkbox"
				checked={selected.has(session.sourcePath)}
				onChange={() => props.onToggle(session.sourcePath)}
			/>
			<div className="codex-session-main">
				<div className="codex-session-title">
					<strong>{session.title}</strong>
					{source.grouped && session.threadSource === "subagent" && (
						<span className="codex-status subagent">{subagentLabel(session)}</span>
					)}
					<span className={`codex-status ${session.status}`}>{statusLabel(session)}</span>
				</div>
				<p>{session.preview}</p>
				<small>
					{new Date(session.updatedAt).toLocaleString()} ·{" "}
					{t("drawer.sessionMessages", { count: session.messageCount })} ·{" "}
					{formatBytes(session.sourceSize)}
				</small>
			</div>
		</label>
	);

	// Codex 有子代理线程：按父子分组渲染（子代理随父会话折叠展示），其余源是平铺列表
	const grouped = source.grouped ? getImportThreadProjection(props.sessions) : undefined;
	const selectableParents = grouped ? grouped.parents : props.sessions;
	const allSelected =
		selectableParents.length > 0 &&
		selectableParents.every((session) => selected.has(session.sourcePath));

	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<section className="codex-import-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<div>
						<strong>{t(labels.title)}</strong>
						<small>{props.project.name}</small>
					</div>
					<CloseIconButton label={t("common.close")} onClick={props.onClose} />
				</div>
				<div className="codex-import-toolbar">
					<div>
						<strong>{t(labels.importCount, { count: props.sessions.length })}</strong>
						<span>{displayPath(props.project.path)}</span>
					</div>
					<div className="codex-import-actions">
						<button onClick={props.onRefresh} disabled={props.loading || props.importing}>
							<RefreshCw size={14} />
							{t("common.refresh")}
						</button>
						<button onClick={props.onToggleAll} disabled={props.sessions.length === 0}>
							<Check size={14} />
							{allSelected ? t(labels.selectNone) : t("common.selectAll")}
						</button>
						<button
							className="primary-action"
							onClick={props.onImport}
							disabled={props.importing || props.selectedPaths.length === 0}
						>
							<UploadCloud size={14} />
							{props.importing
								? t(labels.importing)
								: t(labels.importSelected, { count: props.selectedPaths.length })}
						</button>
					</div>
				</div>
				<div className="codex-import-body">
					{props.loading ? (
						<div className="history-loading">
							<div className="loader" />
							<span>{t(labels.scanning)}</span>
						</div>
					) : props.sessions.length === 0 ? (
						<div className="codex-import-empty">
							<strong>{t(labels.emptyTitle)}</strong>
							<span>{t(labels.emptyDesc)}</span>
						</div>
					) : (
						<div className="codex-session-list">
							{grouped
								? grouped.parents.map((session) => {
										const children = grouped.childrenByParent.get(session.sourcePath) ?? [];
										return (
											<div key={session.sourcePath} className="codex-session-group">
												{renderRow(session)}
												{children.length > 0 && (
													<>
														<button
															className="codex-subagent-toggle"
															onClick={() => toggleGroup(session.sourcePath)}
														>
															{expandedGroups.has(session.sourcePath)
																? labels.hideSubagents
																	? t(labels.hideSubagents, { count: children.length })
																	: ""
																: labels.showSubagents
																	? t(labels.showSubagents, { count: children.length })
																	: ""}
														</button>
														{expandedGroups.has(session.sourcePath) && (
															<div className="codex-subagent-list">
																{children.map((child) =>
																	renderRow(child, "codex-session-row codex-subagent-row"),
																)}
															</div>
														)}
													</>
												)}
											</div>
										);
									})
								: props.sessions.map((session) => renderRow(session))}
							{grouped && grouped.orphanSubagents.length > 0 && (
								<div className="codex-session-group">
									<button
										className="codex-subagent-toggle codex-orphan-subagents-title"
										onClick={() => setShowOrphanSubagents((current) => !current)}
									>
										{labels.orphanSubagents
											? t(labels.orphanSubagents, { count: grouped.orphanSubagents.length })
											: ""}
									</button>
									{showOrphanSubagents && (
										<div className="codex-subagent-list">
											{grouped.orphanSubagents.map((session) =>
												renderRow(session, "codex-session-row codex-subagent-row"),
											)}
										</div>
									)}
								</div>
							)}
						</div>
					)}
				</div>
				{props.report && (
					<div className="codex-import-report">
						<strong>
							{t(labels.importDone, {
								imported: props.report.imported,
								failed: props.report.failed,
							})}
						</strong>
						<div>
							{props.report.results.map((result) => (
								<span
									key={result.sourcePath}
									className={result.success ? "success" : "error"}
									title={result.error || result.targetPath}
								>
									{result.success ? "✓" : "✗"} {result.title || result.sourcePath}
								</span>
							))}
						</div>
					</div>
				)}
			</section>
		</div>
	);
}
