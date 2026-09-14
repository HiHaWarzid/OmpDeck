/** 创建 worktree 弹窗。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../i18n";

/** 创建 git worktree 的对话框 */
export function WorktreeCreateDialog(props: {
	projectId: string;
	creating: boolean;
	onCreate: (branchName: string) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// 预览最终创建的分支名，与后端 WorktreeService.slugify 保持一致：
	// 保留 Unicode 字母数字，其余字符替换为 -。让用户在提交前看到中文/特殊字符的实际结果，
	// 避免输入与最终分支名脱节。
	const previewSlug = useMemo(() => {
		const slug = name
			.trim()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "");
		return slug || "workspace";
	}, [name]);

	return (
		<div className="context-backdrop worktree-create-backdrop" onClick={props.onClose}>
			<div
				className="worktree-create-dialog"
				onClick={(e) => e.stopPropagation()}
			>
				<h3>{t("app.worktreeCreateTitle")}</h3>
				<input
					ref={inputRef}
					type="text"
					className="worktree-create-input"
					placeholder={t("app.worktreeCreatePlaceholder")}
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && name.trim()) {
							props.onCreate(name.trim());
						}
						if (e.key === "Escape") props.onClose();
					}}
					disabled={props.creating}
				/>
				{name.trim() && (
					<p className="worktree-create-preview">
						{t("app.worktreeBranchPreview", { name: previewSlug })}
					</p>
				)}
				<div className="worktree-create-actions">
					<button
						className="worktree-create-cancel"
						onClick={props.onClose}
						disabled={props.creating}
					>
						{t("common.cancel")}
					</button>
					<button
						className="worktree-create-confirm"
						disabled={!name.trim() || props.creating}
						onClick={() => props.onCreate(name.trim())}
					>
						{props.creating ? t("app.worktreeCreating") : t("app.worktreeCreate")}
					</button>
				</div>
			</div>
		</div>
	);
}
