/**
 * 统一确认对话框（deep module）。
 *
 * 外部只需要声明「标题 + 说明 + 主/次操作」，其余全部由本模块拥有：
 * 遮罩、Esc 取消、点击遮罩取消、焦点陷阱/焦点归还、关闭动画。
 * 之前每个弹层各写一份 `config-modal-overlay` + `stopPropagation` + 按钮，
 * 导致 Esc、焦点、暗色适配行为不一致；这里统一成一份实现。
 *
 * `secondaryAction` 用于「保存并关闭」这类第三操作（设置弹框的未保存守卫），
 * 避免调用方再手写一套弹层。
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Button } from "./Button";

export interface ConfirmDialogSecondaryAction {
	label: string;
	onClick: () => void;
	disabled?: boolean;
}

export interface ConfirmDialogProps {
	/** 默认 true；条件渲染的调用方可以省略 */
	open?: boolean;
	title: string;
	message: ReactNode;
	/** 取消 / Esc / 点击遮罩 */
	onCancel: () => void;
	/** 主操作（危险操作时用 danger 变体） */
	onConfirm: () => void;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
	/** 主操作忙态：禁用确认与额外操作，避免重复提交 */
	busy?: boolean;
	secondaryAction?: ConfirmDialogSecondaryAction;
	/** 说明下方的补充内容（路径、错误详情等） */
	children?: ReactNode;
	/**
	 * 点击遮罩是否等于取消，默认 true。
	 * 需要“必须明确选择”的弹窗（如信任确认）置为 false，避免误点遮罩被当成一次真实决定。
	 */
	closeOnOutsideClick?: boolean;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
	const open = props.open ?? true;
	const closeOnOutsideClick = props.closeOnOutsideClick ?? true;
	// 挂载门：关闭后整棵子树卸载，内部状态与焦点自然复位。
	if (!open) return null;

	return (
		<Dialog.Root
			open
			onOpenChange={(next) => {
				if (!next) props.onCancel();
			}}
		>
			<Dialog.Portal>
				{/* confirm content 是 z-index 120，overlay 抬到 115 才能压暗内层弹层（110）。 */}
				<Dialog.Overlay className="modal-radix-overlay modal-radix-overlay-elevated" />
				<Dialog.Content
					className="modal-radix-content modal-radix-confirm"
					aria-label={props.title}
					aria-describedby={undefined}
					onPointerDownOutside={(event) => {
						if (!closeOnOutsideClick) event.preventDefault();
					}}
				>
					<Dialog.Title asChild>
						<strong>{props.title}</strong>
					</Dialog.Title>
					<p className="modal-radix-confirm-message">{props.message}</p>
					{props.children}
					<div className="modal-radix-confirm-actions">
						<Button variant="secondary" onClick={props.onCancel}>
							{props.cancelLabel ?? t("common.cancel")}
						</Button>
						{props.secondaryAction && (
							<Button
								variant="primary"
								disabled={props.busy || props.secondaryAction.disabled}
								onClick={props.secondaryAction.onClick}
							>
								{props.secondaryAction.label}
							</Button>
						)}
						<Button
							variant={props.danger ? "danger" : "primary"}
							disabled={props.busy}
							onClick={props.onConfirm}
						>
							{props.confirmLabel ?? t("common.confirm")}
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
