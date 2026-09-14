/** 会话抽屉：历史会话面板（会话历史弹窗复用同一面板）。 */
import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Pin, X } from "lucide-react";
import { getSessionTreeProjection, normalizeSessionPathForCompare } from "../../../agentListDisplay";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import type { Project, SessionSummary } from "../../../../../shared/types";

/** 会话历史抽屉：自带 header（标题/pin/close），只管会话列表——文件树由 FilesDrawer 独占。 */
export function SessionsDrawer(props: {
	project?: Project;
	sessions: SessionSummary[];
	sessionsLoading?: boolean;
	pinned: boolean;
	onTogglePin: () => void;
	onCollapse: () => void;
	onClose: () => void;
	onRefreshSessions: () => void;
	onOpenSession: (session: SessionSummary) => void;
	onRenameSession: (filePath: string, newName: string) => void;
	onCopySession: (session: SessionSummary) => void | Promise<void>;
	onExportSession: (session: SessionSummary) => void | Promise<void>;
	onDeleteSession: (session: SessionSummary) => void | Promise<void>;
}) {
	const title = props.project
		? t("drawer.projectSessions", { name: props.project.name })
		: t("drawer.historyTitle");
	return (
		<>
			<div className="drawer-header">
				<strong>{title}</strong>
				<div className="drawer-header-actions">
					<button
						className={props.pinned ? "active" : ""}
						title={props.pinned ? t("drawer.unpin") : t("drawer.pin")}
						aria-label={props.pinned ? t("drawer.unpin") : t("drawer.pin")}
						onClick={props.onTogglePin}
					>
						<Pin size={15} />
					</button>
					<button
						disabled={props.pinned}
						title={props.pinned ? t("drawer.pinnedCannotClose") : t("drawer.closePanel")}
						aria-label={t("drawer.closePanel")}
						onClick={props.onClose}
					>
						<X size={16} />
					</button>
				</div>
			</div>
			<SessionsPanel
				sessions={props.sessions}
				onRefresh={props.onRefreshSessions}
				onOpen={props.onOpenSession}
				onRename={props.onRenameSession}
				onCopy={props.onCopySession}
				onExport={props.onExportSession}
				onDelete={props.onDeleteSession}
			/>
		</>
	);
}
export function SessionsPanel(props: {
	sessions: SessionSummary[];
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	/* sessionActionNotice 已改用 toast (sonner) 实现 */
	const [sessionActionLoading, setSessionActionLoading] = useState<{
		filePath: string;
		action: "copy" | "export" | "delete";
	} | null>(null);
	const [deleteConfirmSession, setDeleteConfirmSession] =
		useState<SessionSummary | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	function startRename(session: SessionSummary) {
		setRenamingPath(session.filePath);
		setEditValue(session.name || "");
		requestAnimationFrame(() => inputRef.current?.focus());
	}

	function confirmRename() {
		if (renamingPath && editValue.trim()) {
			void props.onRename(renamingPath, editValue.trim());
		}
		setRenamingPath(null);
		setEditValue("");
	}

	async function runSessionAction(
		session: SessionSummary,
		actionType: "copy" | "export" | "delete",
		action: () => void | Promise<void>,
		successText: string,
	) {
		setSessionActionLoading({ filePath: session.filePath, action: actionType });
		showNotice(
			actionType === "copy"
				? t("drawer.sessionActionCopying")
				: actionType === "export"
					? t("drawer.sessionActionExporting")
					: t("drawer.sessionActionDeleting"),
			3500,
		);
		try {
			await action();
			showNotice(successText, 1600);
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : t("drawer.sessionActionFailed"),
				2400,
			);
		} finally {
			setSessionActionLoading(null);
		}
	}

	// 分组走会话目录共享投影（agentListDisplay.getSessionTreeProjection）：与侧栏
	// 同一语义（pi 按 parentSessionPath 归一化、codex 按 codexSessionId、orphan 恢复）。
	const tree = useMemo(() => getSessionTreeProjection(props.sessions), [props.sessions]);
	const parentSessions = tree.topLevel;
	const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
	const toggleParent = useCallback((filePath: string) => {
		const key = normalizeSessionPathForCompare(filePath) ?? filePath;
		setExpandedParents(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);
	const getChildren = useCallback(
		(filePath?: string) => (filePath ? (tree.childrenOf.get(normalizeSessionPathForCompare(filePath) ?? "") ?? []) : []),
		[tree],
	);
	return (
		<div className="sessions-panel">
			<div className="panel-action-row">
				<span>{t("drawer.sessionCount", { count: parentSessions.length })}</span>
				<button onClick={props.onRefresh}>{t("common.refresh")}</button>
			</div>
			{parentSessions.length === 0 && (
				<div className="sessions-empty">
					<strong>{t("drawer.sessionEmptyTitle")}</strong>
					<span>{t("drawer.sessionEmptyDesc")}</span>
				</div>
			)}
			{parentSessions.map((session) => {
				const children = getChildren(session.filePath);
				const normalizedPath = normalizeSessionPathForCompare(session.filePath) ?? session.filePath;
				const isExpanded = expandedParents.has(normalizedPath);
				return (
				<div
					key={session.filePath}
					className="session-card-group"
				>
					<div className="session-card">
					{renamingPath === session.filePath ? (
						<div className="session-rename-row">
							<input
								ref={inputRef}
								value={editValue}
								onChange={(e) => setEditValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") confirmRename();
									if (e.key === "Escape") {
										setRenamingPath(null);
										setEditValue("");
									}
								}}
								autoFocus
							/>
							<button onClick={confirmRename}>{t("common.save")}</button>
							<button
								onClick={() => {
									setRenamingPath(null);
									setEditValue("");
								}}
							>
								{t("common.cancel")}
							</button>
						</div>
					) : (
						<div className="session-card-display">
							<button
								className="session-card-inner"
								onClick={() => props.onOpen(session)}
								title={session.filePath}
							>
								<div className="session-card-title">
									<strong>{session.name || t("common.untitled")}</strong>
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
									<small>
										{new Date(session.updatedAt).toLocaleString()} ·{" "}
										{t("drawer.sessionMessages", {
											count: session.messageCount,
										})}
									</small>
								</div>
							</button>
							<div className="session-card-actions">
								<button
									className="session-rename-button"
									title={t("menu.copySession")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() =>
										void runSessionAction(
											session,
											"copy",
											() => props.onCopy(session),
											t("drawer.sessionCopied"),
										)
									}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "copy" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "copy"
											? t("menu.copying")
											: t("common.copy")}
									</span>
								</button>
								<button
									className="session-rename-button"
									title={t("menu.exportHtml")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() =>
										void runSessionAction(
											session,
											"export",
											() => props.onExport(session),
											t("drawer.sessionExported"),
										)
									}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "export" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "export"
											? t("menu.exporting")
											: t("common.export")}
									</span>
								</button>
								<button
									className="session-rename-button"
									title={t("common.rename")}
									onClick={() => startRename(session)}
								>
									<span>{t("common.rename")}</span>
								</button>
								<button
									className="session-rename-button danger"
									title={t("common.delete")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() => setDeleteConfirmSession(session)}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "delete" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "delete"
											? t("drawer.sessionActionDeleting")
											: t("common.delete")}
									</span>
								</button>
							</div>
							{/* sessionActionNotice 已改用 toast (sonner) 实现 */}
						</div>
					)}
				</div>
					{children && children.length > 0 && (
						<div className="session-card-children-header">
							<button
								className="session-card-expand-btn"
								title={isExpanded ? t("drawer.collapseSubagentSessions") : t("drawer.expandSubagentSessions")}
								onClick={() => toggleParent(session.filePath)}
							>
								{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
								<span>{t("drawer.subagentSessionCount", { count: children.length })}</span>
							</button>
						</div>
					)}
					{isExpanded && children?.map((child) => (
						<div key={child.filePath} className="session-card session-card-child">
							<div className="session-card-display">
								<button
									className="session-card-inner"
									onClick={() => props.onOpen(child)}
									title={child.filePath}
								>
									<div className="session-card-title">
										<strong>{child.name || t("common.untitled")}</strong>
										<span className="session-source-badge subagent">{t("drawer.subagentSession")}</span>
										<small>
											{new Date(child.updatedAt).toLocaleString()} ·{" "}
											{t("drawer.sessionMessages", {
												count: child.messageCount,
											})}
										</small>
									</div>
								</button>
							</div>
						</div>
					))}
				</div>
				);
			})}
			{deleteConfirmSession && (() => {
					const deleteChildren = getChildren(deleteConfirmSession.filePath);
					return (
				<div className="session-delete-confirm-backdrop" onClick={() => setDeleteConfirmSession(null)}>
					<section
						className="session-delete-confirm"
						onClick={(event) => event.stopPropagation()}
					>
						<strong>{t("drawer.sessionDeleteTitle")}</strong>
						<p>
							{deleteChildren.length > 0
								? t("drawer.sessionDeleteBodyWithChildren", {
										name: deleteConfirmSession.name || t("common.untitled"),
										count: deleteChildren.length,
									})
								: t("drawer.sessionDeleteBody", {
										name: deleteConfirmSession.name || t("common.untitled"),
									})}
						</p>
						<div className="session-delete-confirm-actions">
							<button onClick={() => setDeleteConfirmSession(null)}>{t("common.cancel")}</button>
							<button
								className="danger"
								onClick={() => {
									const target = deleteConfirmSession;
									setDeleteConfirmSession(null);
									void runSessionAction(
										target,
										"delete",
										() => props.onDelete(target),
										t("drawer.sessionDeleted"),
									);
								}}
							>
								{t("common.delete")}
							</button>
						</div>
					</section>
				</div>
			); })()
		}
		</div>
	);
}
