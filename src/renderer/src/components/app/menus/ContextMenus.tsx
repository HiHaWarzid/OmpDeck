/** 右键菜单与确认框：文件/项目/智能体会话上下文菜单及通用确认弹窗。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../i18n";
import type { AgentTab, FileTreeNode, Project, SessionSummary } from "../../../../../shared/types";

export function ConfirmDialog(props: {
	title: string;
	message: string;
	onConfirm: () => void;
	onCancel: () => void;
	confirmLabel?: string;
	danger?: boolean;
}) {
	return (
		<div className="config-modal-overlay" onClick={props.onCancel}>
			<div className="config-modal-dialog" onClick={(e) => e.stopPropagation()}>
				<strong>{props.title}</strong>
				<p>{props.message}</p>
				<div className="config-modal-actions">
					<button className="config-btn" onClick={props.onCancel}>
						{t("common.cancel")}
					</button>
					<button
						className={`config-btn${props.danger ? " danger" : " primary"}`}
						onClick={props.onConfirm}
					>
						{props.confirmLabel ?? t("common.confirm")}
					</button>
				</div>
			</div>
		</div>
	);
}
export function FileContextMenu(props: {
	menu: { x: number; y: number; node: FileTreeNode };
	onClose: () => void;
	onOpen: () => void;
	onReveal: () => void;
	onAttach: () => void;
	onCopyPath: () => void;
	onDelete?: () => void;
	onRename?: () => void;
	/** 剪贴板中有文件路径时显示「粘贴」选项 */
	hasClipboardFiles?: boolean;
	onPaste?: (targetDir: string) => void;
}) {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState({ x: props.menu.x, y: props.menu.y });
	const isFile = props.menu.node.type === "file";
	const isDir = props.menu.node.type === "directory";

	// 测量菜单实际高度，超底部时向上翻转，避免底部文件右键菜单被视口遮挡。
	// 翻转后至少保留 8px 上边距，使菜单始终可读。
	useEffect(() => {
		const el = menuRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const overflowY = rect.bottom - window.innerHeight;
		if (overflowY > 0) {
			setPos({ x: props.menu.x, y: Math.max(8, props.menu.y - rect.height) });
		}
	}, [props.menu.x, props.menu.y]);

	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				ref={menuRef}
				className="context-menu"
				style={{ left: pos.x, top: pos.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button disabled={!isFile} onClick={props.onAttach}>
					{t("menu.attachFile")}
				</button>
				<button disabled={!isFile} onClick={props.onOpen}>
					{t("menu.defaultOpen")}
				</button>
				<button onClick={props.onReveal}>{t("menu.revealFile")}</button>
				<button onClick={props.onCopyPath}>{t("menu.copyPath")}</button>
				{props.onRename && (
					<button disabled={!props.menu.node.name} onClick={props.onRename}>{t("common.rename")}</button>
				)}
				{props.hasClipboardFiles && props.onPaste && (
					<button onClick={() => { props.onPaste!(props.menu.node.path); }}>
						{t("drawer.pasteFiles")}
					</button>
				)}
				{props.onDelete && (
					<button className="danger" disabled={!props.menu.node.name} onClick={props.onDelete}>
						{t("common.delete")}
					</button>
				)}
			</div>
		</div>
	);
}
/**
 * 右键菜单定位：渲染后按真实尺寸修正位置。
 * 当菜单超出视口底部/右侧时向上/向左翻转，仍放不下则夹紧到视口内，
 * 保证整块菜单始终可见、不被屏幕裁切（不使用滚动）。
 */
function useMenuPosition(initial: { x: number; y: number }) {
	const [pos, setPos] = useState(initial);
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let { x, y } = initial;
		// 下方空间不足时翻转到光标上方，仍放不下则夹紧到视口内
		if (y + rect.height > vh) {
			const flipped = y - rect.height;
			y = flipped >= 8 ? flipped : Math.max(8, vh - rect.height - 8);
		}
		// 右侧空间不足时翻转到光标左侧，仍放不下则夹紧到视口内
		if (x + rect.width > vw) {
			const flipped = x - rect.width;
			x = flipped >= 8 ? flipped : Math.max(8, vw - rect.width - 8);
		}
		if (x !== pos.x || y !== pos.y) setPos({ x, y });
	}, [initial.x, initial.y]);
	return { pos, ref };
}
export function ProjectContextMenu(props: {
	menu: { x: number; y: number; project: Project };
	onClose: () => void;
	onRevealProject: () => void;
	onOpenWithEditor: () => void;
	onImportCodexSessions: () => void;
	onImportClaudeSessions: () => void;
	onImportOpenCodeSessions: () => void;
	onManageProjectResources: () => void;
	onManageSessions: () => void;
	onFilterSessions: () => void;
	onToggleWorktree: () => void;
	onRefreshProject: () => void;
	onCopyProjectPath: () => void;
	onRemoveProject: () => void;
}) {
	const isWorktreeEnabled = props.menu.project.worktreeEnabled ?? false;
	const { pos, ref } = useMenuPosition(props.menu);
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: pos.x, top: pos.y }}
				ref={ref}
				onClick={(event) => event.stopPropagation()}
			>
				<button onClick={props.onRevealProject}>{t("menu.revealProject")}</button>
				<button onClick={props.onOpenWithEditor}>{t("app.openWithEditor")}</button>
				<button onClick={props.onImportCodexSessions}>
					{t("menu.importCodex")}
				</button>
				<button onClick={props.onImportClaudeSessions}>
					{t("menu.importClaude")}
				</button>
				<button onClick={props.onImportOpenCodeSessions}>
					{t("menu.importOpenCode")}
				</button>
				<hr className="context-separator" />
				<button onClick={props.onManageProjectResources}>{t("menu.projectResources")}</button>
				<button onClick={props.onManageSessions}>{t("menu.manageSessions")}</button>
				<hr className="context-separator" />
				<button onClick={props.onFilterSessions}>{t("menu.filterSessions")}</button>
				<hr className="context-separator" />
				<button onClick={props.onToggleWorktree}>
					{isWorktreeEnabled ? t("menu.disableWorktree") : t("menu.enableWorktree")}
				</button>
				<hr className="context-separator" />
				<button onClick={props.onCopyProjectPath}>{t("menu.copyProjectPath")}</button>
				<hr className="context-separator" />
				<button onClick={props.onRefreshProject}>{t("app.projectRefresh")}</button>
				<hr className="context-separator" />
				<button onClick={props.onRemoveProject}>{t("menu.removeProject")}</button>
			</div>
		</div>
	);
}
export function AgentContextMenu(props: {
	menu: { x: number; y: number; agent: AgentTab };
	actionLoading?: "copy" | "export" | null;
	onClose: () => void;
	onRename: () => void;
	onExport: () => void;
	onCopySession: () => void;
	onCopySessionFilePath: () => void;
	onToggleRpcLogging?: () => void;
	isRpcLogging?: boolean;
	onOpenLogFile?: () => void;
	onOpenSessionFile?: () => void;
	onCloseAgent: () => void;
}) {
	const { pos, ref } = useMenuPosition(props.menu);
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: pos.x, top: pos.y }}
				ref={ref}
				onClick={(event) => event.stopPropagation()}
			>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onRename}>{t("common.rename")}</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onCopySession}>
					{props.actionLoading === "copy" && <span className="mini-loader" />}
					{props.actionLoading === "copy" ? t("menu.copying") : t("menu.copySession")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onExport}>
					{props.actionLoading === "export" && <span className="mini-loader" />}
					{props.actionLoading === "export" ? t("menu.exporting") : t("menu.exportHtml")}
				</button>
				{props.menu.agent.sessionPath && (
					<>
						<button disabled={Boolean(props.actionLoading)} onClick={props.onCopySessionFilePath}>
							{t("menu.copySessionFilePath")}
						</button>
						<button disabled={Boolean(props.actionLoading)} onClick={props.onOpenSessionFile}>
							{t("menu.openAgentSessionFile")}
						</button>
					</>
				)}
				<button disabled={Boolean(props.actionLoading)} onClick={props.onToggleRpcLogging}>
					{props.isRpcLogging ? `✓ ${t("menu.rpcLoggingOn")}` : t("menu.rpcLogging")}
				</button>
				{props.isRpcLogging && (
					<button disabled={Boolean(props.actionLoading)} onClick={props.onOpenLogFile}>
						{t("menu.rpcLogFile")}
					</button>
				)}
				<button className="danger" onClick={props.onCloseAgent}>{t("menu.closeAgent")}</button>
			</div>
		</div>
	);
}
export function SessionContextMenu(props: {
	menu: { x: number; y: number; session: SessionSummary };
	actionLoading?: "copy" | "export" | null;
	onClose: () => void;
	onRename: () => void;
	onExport: () => void;
	onCopySession: () => void;
	onCopySessionFilePath: () => void;
	onOpenSessionFile?: () => void;
	onShowLogs?: () => void;
	onDeleteSession: () => void;
}) {
	const { pos, ref } = useMenuPosition(props.menu);
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: pos.x, top: pos.y }}
				ref={ref}
				onClick={(event) => event.stopPropagation()}
			>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onRename}>{t("common.rename")}</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onCopySession}>
					{props.actionLoading === "copy" && <span className="mini-loader" />}
					{props.actionLoading === "copy" ? t("menu.copying") : t("menu.copySession")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onExport}>
					{props.actionLoading === "export" && <span className="mini-loader" />}
					{props.actionLoading === "export" ? t("menu.exporting") : t("menu.exportHtml")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onCopySessionFilePath}>
					{t("menu.copySessionFilePath")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onOpenSessionFile}>
					{t("menu.openSessionFile")}
				</button>
				<button disabled={Boolean(props.actionLoading)} onClick={props.onShowLogs}>{t("menu.rpcLogs")}</button>
				<button
					className="danger"
					disabled={Boolean(props.actionLoading)}
					onClick={props.onDeleteSession}
				>
					{t("common.delete")}
				</button>
			</div>
		</div>
	);
}
