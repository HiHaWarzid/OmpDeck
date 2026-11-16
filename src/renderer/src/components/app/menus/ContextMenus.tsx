/** 右键菜单：文件/项目/智能体会话上下文菜单。 */
import { t } from "../../../i18n";
import type { AgentTab, FileTreeNode, Project, SessionSummary } from "../../../../../shared/types";
import { ContextMenuSurface } from "../../ui/ContextMenuSurface";

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
	const isFile = props.menu.node.type === "file";
	return (
		<ContextMenuSurface x={props.menu.x} y={props.menu.y} onClose={props.onClose}>
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
		</ContextMenuSurface>
	);
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
	return (
		<ContextMenuSurface x={props.menu.x} y={props.menu.y} onClose={props.onClose}>
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
		</ContextMenuSurface>
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
	return (
		<ContextMenuSurface x={props.menu.x} y={props.menu.y} onClose={props.onClose}>
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
		</ContextMenuSurface>
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
	return (
		<ContextMenuSurface x={props.menu.x} y={props.menu.y} onClose={props.onClose}>
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
		</ContextMenuSurface>
	);
}
