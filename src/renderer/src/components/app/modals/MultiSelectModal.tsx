/** 消息多选弹窗：批量选择消息用于复制/导出。 */
import { useCallback, useMemo, useState } from "react";
import { summarizeMessage, type MessageItem, type AgentRunItem, type RenderMessage } from "../AppUtils";
import { Check, Brain, FileText, MessageCircle, X } from "lucide-react";
import { t } from "../../../i18n";
import { formatTime, stripAnsi } from "../format";

/** 收集所有可勾选的消息 ID（user + assistant） */
function getSelectableMessageIds(
	items: RenderMessage[],
): string[] {
	const ids: string[] = [];
	for (const item of items) {
		if (item.kind === "message" &&
			(item.message.role === "user" || item.message.role === "assistant")) {
			ids.push(item.message.id);
		} else if (item.kind === "agent-run") {
			for (const sub of item.items) {
				if (sub.kind === "message" && sub.message.role === "assistant") {
					ids.push(sub.message.id);
				}
			}
		}
	}
	return ids;
}
/**
 * 多选分享弹框：以会话树形式展示消息，用户勾选后复制分享。
 * 支持按 agent-run 层级全选或逐条选择。
 */
export function MultiSelectModal(props: {
	renderedRuns: RenderMessage[];
	onClose: () => void;
	onCopy: (
		selectedIds: Set<string>,
		kind: "text" | "markdown" | "image",
	) => void;
}) {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(
		() => new Set(getSelectableMessageIds(props.renderedRuns)),
	);
	const [copying, setCopying] = useState<
		"text" | "markdown" | "image" | null
	>(null);

	const allSelectableIds = useMemo(
		() => getSelectableMessageIds(props.renderedRuns),
		[props.renderedRuns],
	);

	const toggleMessage = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const isRunFullySelected = useCallback(
		(run: AgentRunItem) => {
			const ids = run.items
				.filter(
					(i): i is MessageItem =>
						i.kind === "message" && i.message.role === "assistant",
				)
				.map((i) => i.message.id);
			return ids.length > 0 && ids.every((id) => selectedIds.has(id));
		},
		[selectedIds],
	);

	const toggleRun = useCallback(
		(run: AgentRunItem) => {
			const ids = run.items
				.filter(
					(i): i is MessageItem =>
						i.kind === "message" && i.message.role === "assistant",
				)
				.map((i) => i.message.id);
			if (ids.length === 0) return;
			const allSelected = ids.every((id) => selectedIds.has(id));
			setSelectedIds((prev) => {
				const next = new Set(prev);
				for (const id of ids) {
					if (allSelected) next.delete(id);
					else next.add(id);
				}
				return next;
			});
		},
		[selectedIds],
	);

	const selectAll = useCallback(() => {
		setSelectedIds(new Set(allSelectableIds));
	}, [allSelectableIds]);

	const deselectAll = useCallback(() => {
		setSelectedIds(new Set());
	}, []);

	/** 点击分享按钮：先显示脉冲动画，再执行复制关闭弹框 */
	const handleCopy = useCallback(
		async (kind: "text" | "markdown" | "image") => {
			setCopying(kind);
			// 让按钮脉冲动画渲染一帧后再执行复制
			await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));
			setCopying(null);
			props.onCopy(selectedIds, kind);
		},
		[selectedIds, props.onCopy],
	);

	const selectedCount = selectedIds.size;
	const totalCount = allSelectableIds.length;

	return (
		<div
			className="multi-select-modal-overlay"
			onClick={props.onClose}
		>
			<div
				className="multi-select-modal"
				onClick={(e) => e.stopPropagation()}
			>
				{/* 标题栏 */}
				<header className="multi-select-modal-header">
					<h3>{t("app.multiSelectEnter")}</h3>
					<button
						className="multi-select-modal-close"
						onClick={props.onClose}
						aria-label={t("common.close")}
					>
						<X size={18} strokeWidth={2} />
					</button>
				</header>

				{/* 树状列表 */}
				<div className="multi-select-modal-tree">
					{props.renderedRuns.map((item) => {
						if (item.kind === "message") {
							const msg = item.message;
							if (msg.role === "user" || msg.role === "assistant") {
								const isChecked = selectedIds.has(msg.id);
								return (
									<label
										key={msg.id}
										className={`multi-select-tree-node${isChecked ? " selected" : ""}`}
									>
										<input
											type="checkbox"
											checked={isChecked}
											onChange={() => toggleMessage(msg.id)}
										/>
										<MessageCircle
											size={14}
											className="multi-select-node-icon user"
										/>
										<span className="multi-select-node-label">
											<span className="multi-select-node-summary">
												{summarizeMessage(stripAnsi(msg.text))}
											</span>
										</span>
									</label>
								);
							}
							return null;
						}

						if (item.kind === "agent-run") {
							const runChecked = isRunFullySelected(item);
							const runHasSome = item.items.some(
								(i) =>
									i.kind === "message" &&
									i.message.role === "assistant" &&
									selectedIds.has(i.message.id),
							);
							const runAnyChecked = runChecked || runHasSome;
							const assistantMsgs = item.items.filter(
								(i): i is MessageItem =>
									i.kind === "message" && i.message.role === "assistant",
							);
							if (assistantMsgs.length === 0) return null;

							return (
								<div key={item.id} className="multi-select-tree-run">
									<div
										className={`multi-select-tree-node run-parent${runAnyChecked ? " selected" : ""}`}
										onClick={() => toggleRun(item)}
									>
										<Brain size={15} className="multi-select-node-icon assistant" />
										<span className="multi-select-node-label">
											<span className="multi-select-node-run-label">omp</span>
											<span className="multi-select-node-time">
												{formatTime(item.endedAt)}
											</span>
										</span>
										<span className="multi-select-node-assistant-count">
											{assistantMsgs.length}
										</span>
									</div>
									<div className="multi-select-run-children">
										{assistantMsgs.map((sub) => {
											const subChecked = selectedIds.has(sub.message.id);
											return (
												<label
													key={sub.message.id}
													className={`multi-select-tree-node run-child${subChecked ? " selected" : ""}`}
												>
													<input
														type="checkbox"
														checked={subChecked}
														onChange={() =>
															toggleMessage(sub.message.id)
														}
													/>
													<FileText
														size={14}
														className="multi-select-node-icon child"
													/>
													<span className="multi-select-node-label">
														<span className="multi-select-node-summary">
															{summarizeMessage(
																stripAnsi(sub.message.text),
															)}
														</span>
													</span>
												</label>
											);
										})}
									</div>
								</div>
							);
						}

						return null;
					})}
				</div>

				{/* 底部操作栏 */}
				<footer className="multi-select-modal-footer">
					<div className="multi-select-modal-footer-top">
						<span className="multi-select-count">
							{t("app.multiSelectCount", { count: selectedCount })}
						</span>
						<div className="multi-select-bulk-actions">
							<button
								className="multi-select-bulk-btn"
								onClick={selectAll}
								disabled={!totalCount}
							>
								{t("common.selectAll")}
							</button>
							<button
								className="multi-select-bulk-btn"
								onClick={deselectAll}
								disabled={!selectedCount}
							>
								{t("common.deselectAll")}
							</button>
						</div>
					</div>
					<div className="multi-select-modal-footer-bottom">
						<button
							className={`multi-select-action-btn${copying === "text" ? " copying" : ""}`}
							disabled={!selectedCount || !!copying}
							onClick={() => handleCopy("text")}
						>
							{copying === "text" ? (
								<Check size={14} strokeWidth={3} />
							) : (
								t("app.shareAsText")
							)}
						</button>
						<button
							className={`multi-select-action-btn${copying === "markdown" ? " copying" : ""}`}
							disabled={!selectedCount || !!copying}
							onClick={() => handleCopy("markdown")}
						>
							{copying === "markdown" ? (
								<Check size={14} strokeWidth={3} />
							) : (
								t("app.shareAsMarkdown")
							)}
						</button>
						<button
							className={`multi-select-action-btn${copying === "image" ? " copying" : ""}`}
							disabled={!selectedCount || !!copying}
							onClick={() => handleCopy("image")}
						>
							{copying === "image" ? (
								<Check size={14} strokeWidth={3} />
							) : (
								t("app.shareAsImage")
							)}
						</button>
						<button
							className="multi-select-action-btn primary"
							onClick={props.onClose}
							disabled={!!copying}
						>
							{t("app.multiSelectCancel")}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}
