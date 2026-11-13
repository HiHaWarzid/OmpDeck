import type { ReactNode } from "react";
import { ModalSurface, type ModalSurfaceSize } from "./ModalSurface";

export type ModalSize = ModalSurfaceSize;

export interface ModalProps {
	/** 是否显示弹框 */
	open: boolean;
	/** 关闭弹框回调 */
	onClose: () => void;
	/** 弹框标题（可选）。传 title 时自动展示 header 区域与关闭按钮 */
	title?: string;
	/** 弹框尺寸，对应预设的宽高 */
	size?: ModalSize;
	/** 主体内容 */
	children: ReactNode;
	/** 额外的 content wrapper class（业务布局类） */
	contentClassName?: string;
}

/**
 * 基于 ModalSurface 的通用弹框入口。
 * 尺寸规范 / 圆角 / 阴影 / backdrop / Esc / 焦点陷阱都由 ModalSurface 统一提供，
 * 这里只保留「标题 + 尺寸 + 内容」的简单签名。
 */
export function Modal({ open, onClose, title, size = "full", children, contentClassName }: ModalProps) {
	return (
		<ModalSurface
			open={open}
			onRequestClose={onClose}
			title={title}
			size={size}
			className={contentClassName}
		>
			{children}
		</ModalSurface>
	);
}
