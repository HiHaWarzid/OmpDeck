/** 文件抽屉：文件树面板与文件节点渲染。 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
	ChevronsUpDown,
	MoveDown,
	MoveUp,
	ChevronsDownUp,
	FileText,
	Folder,
	Plus,
	RefreshCw,
	FolderOpen,
} from "lucide-react";
import { getFileIconSeti, getFileIconColor, getFileTypeLabel } from "../../../fileIcons";
import { t } from "../../../i18n";
import { TextField } from "../../ui/TextField";
import type { FileTreeNode } from "../../../../../shared/types";

/** 文件抽屉：工具面板挂载（无内建 header，由外层 drawer-chrome Tab 接管 chrome）。 */
export function FilesDrawer(props: {
	files: FileTreeNode[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onCollapseAllDirectories: () => void;
	onExpandAllDirectories?: () => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	onOpenFolder?: () => void;
	onOpenFile?: (path: string) => void;
	onViewFile?: (path: string) => void;
	onCreateItem?: (parentDir: string, name: string, type: "file" | "directory") => void;
	/** 项目根目录路径 */
	projectRoot?: string;
	/** 从 OS 拖入文件到目录 */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 粘贴剪贴板文件到目标目录 */
	onPasteFiles?: (targetDir: string) => void;
	/** 内部拖拽移动文件到目标目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
}) {
	return (
		<FilesPanel
			files={props.files}
			expandedDirs={props.expandedDirs}
			onToggleDirectory={props.onToggleDirectory}
			onCollapseAll={props.onCollapseAllDirectories}
			onExpandAll={props.onExpandAllDirectories}
			onFileContextMenu={props.onFileContextMenu}
			onRefreshFiles={props.onRefreshFiles}
			onOpenFolder={props.onOpenFolder}
			onOpenFile={props.onOpenFile}
			onViewFile={props.onViewFile}
			onCreateItem={props.onCreateItem}
			currentProjectRoot={props.projectRoot}
			onDropFiles={props.onDropFiles}
			onPasteFiles={props.onPasteFiles}
			onMoveFiles={props.onMoveFiles}
		/>
	);
}
function fileIconElement(name: string, isDirectory: boolean, isExpanded: boolean) {
	if (isDirectory) {
		return isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />;
	}
	try {
		const { svg, colorName } = getFileIconSeti(name);
		const color = getFileIconColor(colorName);
		// SVG 只来自仓库内附带许可证的只读 Seti 数据快照，不接收文件内容或用户输入。
		return (
			<span
				aria-hidden="true"
				className="file-node-seti-icon"
				style={{ color }}
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
		);
	} catch {
		return <FileText size={15} />;
	}
}
function FileNode(props: {
	node: FileTreeNode;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onOpenFile?: (path: string) => void;
	onViewFile?: (path: string) => void;
	depth?: number;
	/** 拖入文件（仅目录节点使用） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
	dragOverDir?: string | null;
	onDragOverDirChange?: (path: string | null) => void;
}) {
	const { node, expandedDirs, onToggleDirectory, depth = 0 } = props;
	const expanded = expandedDirs.has(node.path);
	const typeLabel = node.type === "file" ? getFileTypeLabel(node.name) : "";
	const rowStyle = { "--file-depth-offset": `${depth * 16}px` } as CSSProperties;
	const menu = (event: React.MouseEvent) => {
		event.preventDefault();
		props.onFileContextMenu(node, event.clientX, event.clientY);
	};
	const handleDragStart = useCallback((e: React.DragEvent) => {
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/pi-file-path", node.path);
		// 设置拖拽图标
		const ghost = e.currentTarget.cloneNode(true) as HTMLElement;
		ghost.style.position = "absolute";
		ghost.style.top = "-1000px";
		ghost.style.opacity = "0.6";
		ghost.style.pointerEvents = "none";
		ghost.style.width = `${e.currentTarget.clientWidth}px`;
		document.body.appendChild(ghost);
		e.dataTransfer.setDragImage(ghost, 10, 10);
		setTimeout(() => document.body.removeChild(ghost), 0);
	}, [node.path]);
	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "move";
		props.onDragOverDirChange?.(node.path);
	}, [node.path]);
	const handleDragLeave = useCallback(() => {
		props.onDragOverDirChange?.(null);
	}, []);
	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		props.onDragOverDirChange?.(null);
		// 内部拖拽移动：优先检查 pi-file-path
		const sourcePath = e.dataTransfer.getData("text/pi-file-path");
		if (sourcePath) {
			if (sourcePath !== node.path && props.onMoveFiles) {
				props.onMoveFiles([sourcePath], node.path);
			}
			return;
		}
		// 外部 OS 文件拖入
		if (e.dataTransfer.files.length > 0 && props.onDropFiles) {
			props.onDropFiles(node.path, e.dataTransfer.files);
		}
	}, [node.path, props.onDropFiles, props.onMoveFiles]);
	if (node.type === "file")
		return (
			<div className="file-node" style={rowStyle}>
				<button
					className="file file-node-row"
					style={rowStyle}
					title={`${node.relativePath}\n${typeLabel}`}
					draggable
					onDragStart={handleDragStart}
					onClick={() => props.onViewFile?.(node.path)}
					onContextMenu={menu}
				>
					<span className="file-node-icon">
						{fileIconElement(node.name, false, false)}
					</span>
					<span className="file-node-name">{node.name}</span>
					<span className="file-node-type-label">{typeLabel}</span>
				</button>
			</div>
		);
	const isDragOver = props.dragOverDir === node.path;
	return (
		<div className="file-node" style={rowStyle}>
			<button
				className={`directory file-node-row${isDragOver ? " drag-over" : ""}`}
				style={rowStyle}
				draggable
				onDragStart={handleDragStart}
				onClick={() => onToggleDirectory(node.path)}
				onContextMenu={menu}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				title={node.relativePath}
			>
				<span className="file-node-icon">
					{fileIconElement(node.name, true, expanded)}
				</span>
				<span className="file-node-name">{node.name}</span>
			</button>
			{expanded && node.children && node.children.length > 0 && (
				<div className="file-children">
					{node.children.map((child) => (
						<FileNode key={child.path} node={child}
							expandedDirs={expandedDirs}
							onToggleDirectory={onToggleDirectory}
							onFileContextMenu={props.onFileContextMenu}
							onOpenFile={props.onOpenFile}
							onViewFile={props.onViewFile}
							depth={depth + 1}
							onDropFiles={props.onDropFiles}
							onMoveFiles={props.onMoveFiles}
							dragOverDir={props.dragOverDir}
							onDragOverDirChange={props.onDragOverDirChange} />
					))}
				</div>
			)}
		</div>
	);
}
function FilesPanel(props: {
	files: FileTreeNode[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	/** 收起文件树中所有已展开的目录，清空 expandedDirs。 */
	onCollapseAll?: () => void;
	/** 展开文件树中所有目录 */
	onExpandAll?: () => void;
	onOpenFolder?: () => void;
	onOpenFile?: (path: string) => void;
	onViewFile?: (path: string) => void;
	onCreateItem?: (parentDir: string, name: string, type: "file" | "directory") => void;
	/** 项目根目录路径 */
	currentProjectRoot?: string;
	/** 从 OS 拖入文件到目录或面板空白区域 */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 粘贴剪贴板文件到目标目录（Ctrl+V / 工具栏按钮 / 右键菜单） */
	onPasteFiles?: (targetDir: string) => void;
	/** 内部拖拽移动文件/目录到目标目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [showScrollTop, setShowScrollTop] = useState(false);
	const [showScrollBottom, setShowScrollBottom] = useState(false);
	// Electron renderer 不支持 window.prompt；新建文件/文件夹走应用内小弹层。
	const [createItemOpen, setCreateItemOpen] = useState(false);
	const [createItemName, setCreateItemName] = useState("");
	/** 拖入高亮的目标目录路径（null = 拖在面板空白区域无高亮） */
	const [dragOverDir, setDragOverDir] = useState<string | null>(null);
	const [dragSourcePath, setDragSourcePath] = useState<string | null>(null);
	const dragCountRef = useRef(0);

	// 面板自身接受拖入：落在空白区域视为复制到项目根目录
	const handlePanelDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	}, []);
	const handlePanelDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setDragOverDir(null);
		dragCountRef.current = 0;
		if (e.dataTransfer.files.length > 0 && props.onDropFiles && props.currentProjectRoot) {
			props.onDropFiles(props.currentProjectRoot, e.dataTransfer.files);
		}
	}, []);

	const handleScroll = useCallback(() => {
		const el = panelRef.current;
		if (!el) return;
		const threshold = 40;
		setShowScrollTop(el.scrollTop > threshold);
		setShowScrollBottom(el.scrollTop + el.clientHeight < el.scrollHeight - threshold);
	}, []);

	useEffect(() => {
		const el = panelRef.current;
		if (!el) return;
		el.addEventListener("scroll", handleScroll, { passive: true });
		handleScroll();
		return () => el.removeEventListener("scroll", handleScroll);
	}, [handleScroll, props.files, props.expandedDirs]);

	const scrollToTop = useCallback(() => {
		panelRef.current?.scrollTo({ top: 0, behavior: "smooth" });
	}, []);

	const scrollToBottom = useCallback(() => {
		const el = panelRef.current;
		if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, []);

	// 判断是否所有目录都已展开，用于切换折叠/展开按钮状态
	const allDirsList = useMemo(() => {
		const dirs: string[] = [];
		const collect = (nodes: FileTreeNode[]) => {
			for (const n of nodes) {
				if (n.type === "directory") {
					dirs.push(n.path);
					if (n.children) collect(n.children);
				}
			}
		};
		collect(props.files);
		return dirs;
	}, [props.files]);
	const isAllExpanded = allDirsList.length > 0 && allDirsList.every((d) => props.expandedDirs.has(d));

	return (
		<div
			className="files-panel"
			ref={panelRef}
			tabIndex={-1}
			onDragOver={handlePanelDragOver}
			onDragLeave={() => { setDragOverDir(null); dragCountRef.current = 0; }}
			onDrop={handlePanelDrop}
			onKeyDown={(e) => {
				// Ctrl+V / Cmd+V 粘贴到项目根目录
				if ((e.ctrlKey || e.metaKey) && e.key === "v") {
					if (props.onPasteFiles && props.currentProjectRoot) {
						props.onPasteFiles(props.currentProjectRoot);
					}
				}
			}}
			onContextMenu={(e) => {
				// 仅面板背景本身被右键时触发（不拦截文件节点的右键事件）
				if (e.target !== e.currentTarget) return;
				e.preventDefault();
				if (props.currentProjectRoot) {
					props.onFileContextMenu(
						{ path: props.currentProjectRoot, name: "", type: "directory", relativePath: "", children: undefined } as FileTreeNode,
						e.clientX, e.clientY
					);
				}
			}}
		>
			<div className="panel-action-row">
				<div className="panel-action-buttons">
					{props.onOpenFolder && (
						<button
							className="icon-only"
							onClick={props.onOpenFolder}
							title={t("drawer.openFolder")}
							aria-label={t("drawer.openFolder")}
						>
							<Folder size={14} />
						</button>
					)}
					{props.onCreateItem && props.currentProjectRoot && (
						<button
							className="icon-only"
							onClick={() => {
								setCreateItemName("");
								setCreateItemOpen(true);
							}}
							title={t("drawer.createItem")}
							aria-label={t("drawer.createItem")}
						>
							<Plus size={14} />
						</button>
					)}
					{/* 刷新与全部收起使用纯图标按钮，保持工具栏紧凑、与列表项字号对齐 */}
					<button
						className="icon-only"
						onClick={props.onRefreshFiles}
						title={t("common.refresh")}
						aria-label={t("common.refresh")}
					>
						<RefreshCw size={14} />
					</button>
					{props.onCollapseAll && (
						<button
							className="icon-only"
							onClick={props.onCollapseAll}
							title={t("drawer.collapseAllDirs")}
							aria-label={t("drawer.collapseAllDirs")}
							disabled={props.expandedDirs.size === 0}
						>
							<ChevronsDownUp size={14} />
						</button>
					)}
					{props.onExpandAll && (
						<button
							className="icon-only"
							onClick={props.onExpandAll}
							title={t("drawer.expandAllDirs")}
							aria-label={t("drawer.expandAllDirs")}
							disabled={isAllExpanded}
						>
							<ChevronsUpDown size={14} />
						</button>
					)}
				</div>
			</div>
			{showScrollTop && (
				<button
					type="button"
					className="drawer-scroll-btn drawer-scroll-top"
					title={t("app.modelScrollToTop")}
					onClick={scrollToTop}
				>
					<MoveUp size={14} strokeWidth={1.8} aria-hidden="true" />
				</button>
			)}
			{props.files.map((node) => (
				<FileNode
					key={node.path}
					node={node}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
					onOpenFile={props.onOpenFile}
					onViewFile={props.onViewFile}
					onDropFiles={props.onDropFiles}
					onMoveFiles={props.onMoveFiles}
					dragOverDir={dragOverDir}
					onDragOverDirChange={setDragOverDir}
				/>
			))}
			{showScrollBottom && (
				<button
					type="button"
					className="drawer-scroll-btn drawer-scroll-bottom"
					title={t("app.modelScrollToBottom")}
					onClick={scrollToBottom}
				>
					<MoveDown size={14} strokeWidth={1.8} aria-hidden="true" />
				</button>
			)}
			{/* 新建文件/文件夹：替代 window.prompt（Electron 下会抛 prompt is not supported） */}
			{createItemOpen && props.onCreateItem && props.currentProjectRoot && (
				<div
					className="config-modal-overlay"
					onClick={() => setCreateItemOpen(false)}
				>
					<div
						className="config-modal-dialog drawer-create-item-dialog"
						onClick={(e) => e.stopPropagation()}
					>
						<strong>{t("drawer.createItem")}</strong>
						<p>{t("drawer.createItemPrompt")}</p>
						<TextField
							label={t("drawer.createItemName")}
							value={createItemName}
							onChange={setCreateItemName}
							placeholder={t("drawer.createItemPlaceholder")}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									setCreateItemOpen(false);
									return;
								}
								if (e.key !== "Enter") return;
								e.preventDefault();
								const name = createItemName.trim();
								if (!name) return;
								const isDir = name.endsWith("/") || name.endsWith("\\");
								const finalName = isDir ? name.slice(0, -1).trim() : name;
								if (!finalName) return;
								props.onCreateItem?.(props.currentProjectRoot!, finalName, isDir ? "directory" : "file");
								setCreateItemOpen(false);
								setCreateItemName("");
							}}
						/>
						<div className="config-modal-actions">
							<button
								className="config-btn"
								onClick={() => {
									setCreateItemOpen(false);
									setCreateItemName("");
								}}
							>
								{t("common.cancel")}
							</button>
							<button
								className="config-btn primary"
								disabled={!createItemName.trim()}
								onClick={() => {
									const name = createItemName.trim();
									if (!name) return;
									const isDir = name.endsWith("/") || name.endsWith("\\");
									const finalName = isDir ? name.slice(0, -1).trim() : name;
									if (!finalName) return;
									props.onCreateItem?.(props.currentProjectRoot!, finalName, isDir ? "directory" : "file");
									setCreateItemOpen(false);
									setCreateItemName("");
								}}
							>
								{t("common.confirm")}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
