/** 会话管理弹窗：批量重命名/删除/分叉会话。 */
import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { t } from "../../../i18n";
import type { SessionSummary } from "../../../../../shared/types";

/** 会话管理弹框：展示项目所有会话，支持多选删除、导出、重命名 */
export function SessionManagerModal(props: {
	sessions: SessionSummary[];
	onClose: () => void;
	onRename: (session: SessionSummary) => void;
	onExport: (session: SessionSummary) => void;
	onDelete: (sessions: SessionSummary[]) => void;
}) {
	const SOURCES = ["pi", "codex", "claude", "opencode"] as const;
	const [activeSources, setActiveSources] = useState<Set<string>>(new Set(SOURCES));
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [selectAll, setSelectAll] = useState(false);

	// 按来源过滤
	const filteredSessions = props.sessions.filter((s) =>
		activeSources.has(s.source ?? "pi"),
	);

	const toggleSource = (source: string) => {
		setActiveSources((prev) => {
			const next = new Set(prev);
			if (next.has(source)) {
				next.delete(source);
			} else {
				next.add(source);
			}
			return next;
		});
		setSelected(new Set());
		setSelectAll(false);
	};

	// 全选/取消全选（只在当前过滤后的范围内）
	const handleToggleAll = () => {
		if (selectAll) {
			setSelected(new Set());
		} else {
			setSelected(new Set(filteredSessions.map((s) => s.filePath)));
		}
		setSelectAll(!selectAll);
	};

	const handleToggle = (filePath: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(filePath)) {
				next.delete(filePath);
			} else {
				next.add(filePath);
			}
			setSelectAll(next.size === filteredSessions.length);
			return next;
		});
	};

	const handleDeleteSelected = () => {
		const toDelete = props.sessions.filter((s) => selected.has(s.filePath));
		if (toDelete.length === 0) return;
		props.onDelete(toDelete);
	};

	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<section className="session-manager-modal" onClick={(e) => e.stopPropagation()}>
				<header className="modal-header">
					<div>
						<strong>{t("menu.manageSessions")}</strong>
						<small>{filteredSessions.length} / {props.sessions.length} sessions</small>
					</div>
					<button
						className="modal-close"
						onClick={props.onClose}
						aria-label={t("common.close")}
					>
						<X size={18} strokeWidth={2} />
					</button>
				</header>

				<div className="session-manager-toolbar">
					<div className="session-manager-toolbar-left">
						<label className="session-manager-select-all">
							<input
								type="checkbox"
								checked={selectAll}
								onChange={handleToggleAll}
							/>
							{t("common.selectAll")}
						</label>
						<div className="session-manager-source-filters">
							{SOURCES.map((source) => (
								<button
									key={source}
									className={`session-source-btn${activeSources.has(source) ? " active" : ""}`}
									onClick={() => toggleSource(source)}
								>
									{t(`sessionSource.${source}` as any)}
								</button>
							))}
						</div>
					</div>
					{selected.size > 0 && (
						<button
							className="session-manager-delete-btn"
							onClick={handleDeleteSelected}
						>
							{t("common.deleteSelected", { count: selected.size })}
						</button>
					)}
				</div>

				<div className="session-manager-list">
					{filteredSessions.map((session) => {
						const isChecked = selected.has(session.filePath);
						return (
							<div
								key={session.filePath}
								className={`session-manager-row${isChecked ? " selected" : ""}`}
							>
								<label className="session-manager-row-checkbox">
									<input
										type="checkbox"
										checked={isChecked}
										onChange={() => handleToggle(session.filePath)}
									/>
								</label>
								<div
									className="session-manager-row-info"
									onClick={() => handleToggle(session.filePath)}
								>
									<div className="session-manager-row-name">
										{session.name || session.preview?.slice(0, 60) || t("common.untitled")}
									</div>
									{session.source && session.source !== "pi" && (
										<span className={`session-source-badge ${session.source}`}>
											{t(`sessionSource.${session.source}` as any)}
										</span>
									)}
									{session.degraded && (
										<span className="session-degraded-badge" title={t("drawer.sessionDegraded")}>
											<AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
										</span>
									)}
								</div>
								<div className="session-manager-row-actions">
									<button
										className="session-manager-action-btn"
										onClick={() => props.onRename(session)}
										title={t("common.rename")}
									>
										{t("common.rename")}
									</button>
									<button
										className="session-manager-action-btn"
										onClick={() => props.onExport(session)}
										title={t("menu.exportHtml")}
									>
										{t("menu.exportHtml")}
									</button>
									<button
										className="session-manager-action-btn danger"
										onClick={() => props.onDelete([session])}
										title={t("common.delete")}
									>
										{t("common.delete")}
									</button>
								</div>
							</div>
						);
					})}
				</div>
			</section>
		</div>
	);
}
