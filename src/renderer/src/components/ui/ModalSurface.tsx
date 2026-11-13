/**
 * ModalSurface —— 弹层统一表面（deep module）。
 *
 * interface 只有「是否打开 / 请求关闭 / 是否有未保存更改」，implementation 里收起所有弹层共性：
 * - 挂载门：关闭后整棵子树卸载，滚动位置与内部状态随之复位，不会残留上一次的草稿/滚动条；
 * - backdrop、点击外部关闭、Esc 关闭；
 * - 焦点陷阱与关闭后的焦点归还（Radix Dialog）；
 * - 关闭动画（挂载门再延迟 120ms，与 `.modal-radix-closing` 时长一致）；
 * - 未保存更改确认（dirty）：保存并关闭 / 放弃更改 / 继续编辑。
 *
 * 因此业务弹层只需要写内容，不再各自造 overlay、stopPropagation、关闭按钮和 Esc 监听。
 * 内容里有自建关闭按钮时，用 children 的函数形式拿到同一个带守卫的 requestClose。
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { t } from "../../i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { CloseIconButton } from "./IconButton";

/** 与 AGENTS.md 弹框尺寸规范一致的三档尺寸。 */
export type ModalSurfaceSize = "full" | "medium" | "small";

export interface ModalSurfaceProps {
	open: boolean;
	/** Esc / 点击 backdrop / 关闭按钮 → 这里；dirty 时先走未保存确认 */
	onRequestClose: () => void;
	/** 有未保存更改时，关闭请求先弹出确认 */
	dirty?: boolean;
	/** dirty 确认框里的「保存并关闭」；返回 false 表示保存失败、留在弹层里 */
	onSaveBeforeClose?: () => Promise<boolean> | boolean;
	/** 保存进行中，禁用确认框的写操作 */
	saving?: boolean;
	size?: ModalSurfaceSize;
	/** 无字符串标题时提供给读屏的可访问名称 */
	ariaLabel?: string;
	/** 标题；传入时自动渲染统一 header 与关闭按钮 */
	title?: ReactNode;
	/** header 标题下方的次要说明（例如项目名、路径） */
	subtitle?: ReactNode;
	/** header 右侧在关闭按钮之前的操作区（保存/取消、复制日志等） */
	headerActions?: ReactNode;
	/** 追加到弹层根节点的 class（用于业务布局类，如 settings-modal） */
	className?: string;
	/**
	 * 嵌套在另一个弹层内部时置为 true：overlay/content 各自抬高一层，
	 * 否则父弹层 content（z-index 110）会把本层的 overlay（100）压在下面。
	 */
	elevated?: boolean;
	/** 内容；函数形式可拿到带守卫的 requestClose，供内容内自建关闭按钮复用 */
	children: ReactNode | ((requestClose: () => void) => ReactNode);
}

/** 关闭动画时长（ms），必须与 styles.css 中 `.modal-radix-closing` 的 animation-duration 一致。 */
const CLOSE_ANIMATION_MS = 120;

export function ModalSurface(props: ModalSurfaceProps) {
	const { open, dirty, onRequestClose } = props;
	const [mounted, setMounted] = useState(open);
	const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
	// Radix 没有 Trigger 时会无条件 preventDefault 掉它自己的焦点归还，这里自己记录打开前的焦点。
	const openerRef = useRef<HTMLElement | null>(null);
	// 未保存确认里的异步保存可能被用户取消：token 让过期的保存结果不再关闭弹层。
	const saveTokenRef = useRef(0);

	useLayoutEffect(() => {
		openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}, []);

	// 挂载门：打开时立即挂载；关闭时保留一个动画周期再卸载，实现淡出并复位内部状态。
	useEffect(() => {
		if (open) {
			setMounted(true);
			return;
		}
		if (!mounted) return;
		const timer = window.setTimeout(() => setMounted(false), CLOSE_ANIMATION_MS);
		return () => window.clearTimeout(timer);
	}, [open, mounted]);

	// dirty 说明「内容已改动」，此时任何关闭入口都要先确认，避免静默丢改动。
	const requestClose = useCallback(() => {
		if (dirty) {
			setDiscardPromptOpen(true);
			return;
		}
		onRequestClose();
	}, [dirty, onRequestClose]);

	if (!mounted) return null;

	const closing = !open;
	const accessibleLabel =
		props.ariaLabel ?? (typeof props.title === "string" ? props.title : undefined);

	const content =
		typeof props.children === "function" ? props.children(requestClose) : props.children;

	return (
		<>
			<Dialog.Root
				open
				onOpenChange={(next) => {
					if (!next) requestClose();
				}}
			>
				<Dialog.Portal>
					<Dialog.Overlay
						className={cn(
							"modal-radix-overlay",
							props.elevated && "modal-radix-overlay-elevated",
							closing && "modal-radix-closing",
						)}
					/>
					<Dialog.Content
						className={cn(
							"modal-radix-content",
							`modal-radix-${props.size ?? "full"}`,
							props.elevated && "modal-radix-content-elevated",
							props.className,
							closing && "modal-radix-closing",
						)}
						aria-label={accessibleLabel}
						aria-describedby={undefined}
						onCloseAutoFocus={(event) => {
							event.preventDefault();
							openerRef.current?.focus();
						}}
					>
						{props.title !== undefined && (
							<div className="modal-header">
								{props.subtitle !== undefined ? (
									<div className="modal-header-heading">
										<Dialog.Title asChild>
											<strong>{props.title}</strong>
										</Dialog.Title>
										<small>{props.subtitle}</small>
									</div>
								) : (
									<Dialog.Title asChild>
										<strong>{props.title}</strong>
									</Dialog.Title>
								)}
								<div className="modal-header-actions">
									{props.headerActions}
									<Dialog.Close asChild>
										<CloseIconButton label={t("common.close")} />
									</Dialog.Close>
								</div>
							</div>
						)}
						{content}
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>

			{/* 未保存守卫：独立弹层，渲染在 surface 之外，避免被 content 的 transform/overflow 裁切 */}
			{discardPromptOpen && (
				<ConfirmDialog
					title={t("modal.unsavedTitle")}
					message={t("modal.unsavedMessage")}
					onCancel={() => {
						saveTokenRef.current += 1;
						setDiscardPromptOpen(false);
					}}
					danger
					confirmLabel={t("modal.discardChanges")}
					onConfirm={() => {
						saveTokenRef.current += 1;
						setDiscardPromptOpen(false);
						onRequestClose();
					}}
					busy={props.saving}
					secondaryAction={
						props.onSaveBeforeClose
							? {
									label: t("modal.saveAndClose"),
									onClick: () => {
										const token = ++saveTokenRef.current;
										void (async () => {
											const ok = await props.onSaveBeforeClose?.();
											// 保存期间用户可能已取消或再次触发保存，过期的结果不得关闭弹层。
											if (saveTokenRef.current !== token) return;
											setDiscardPromptOpen(false);
											// 保存失败时留在弹层里让用户修正，不静默关闭。
											if (ok) onRequestClose();
										})();
									},
								}
							: undefined
					}
				/>
			)}
		</>
	);
}
