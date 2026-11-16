import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useDismissableLayer } from "./useDismissableLayer";

/**
 * 右键菜单外壳（backdrop + 定位 + 关闭）。
 *
 * 为什么成模块：文件 / 项目 / Agent / 会话 / Git 提交 / 会话筛选六处右键菜单各自写了一遍
 * 「全屏 backdrop + onClick 关闭 + 内层 stopPropagation + 超视口翻转」。其中翻转逻辑还有两份
 * 实现（`useMenuPosition` 与 FileContextMenu 内联的那份），关闭路径只有鼠标一条——六处菜单
 * 都无法用 Esc 关闭。`dismissableLayer` 已经是关闭行为的唯一属主，右键菜单只是它的一类使用者。
 *
 * 为什么外部点击仍由 backdrop 承担、而不是交给关闭层的 `pointerdown`：
 * 关闭层在 pointerdown 阶段就同步关闭，随后到来的 `click` 会落到菜单下面那个元素上——
 * 一次「关菜单」的点击会顺带激活下层的按钮。backdrop 挡在中间并吞掉这次 click 才是菜单语义。
 * Esc 没有这个问题，所以它走关闭层。
 *
 * 定位：渲染后按真实尺寸修正，超出视口底部/右侧时翻转，仍放不下则夹紧到视口内。
 */

export type ContextMenuSurfaceProps = {
	/** 期望的屏幕坐标（通常是光标位置）。 */
	x: number;
	y: number;
	/** 菜单容器的额外类名（如 `filter-menu`）。 */
	className?: string;
	onClose: () => void;
	children: ReactNode;
};

/** 菜单与视口边缘的最小间距。 */
const VIEWPORT_GAP = 8;

export function ContextMenuSurface(props: ContextMenuSurfaceProps) {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState({ x: props.x, y: props.y });

	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let { x, y } = { x: props.x, y: props.y };
		// 下方空间不足时翻转到光标上方，仍放不下则夹紧到视口内。
		if (y + rect.height > vh) {
			const flipped = y - rect.height;
			y = flipped >= VIEWPORT_GAP ? flipped : Math.max(VIEWPORT_GAP, vh - rect.height - VIEWPORT_GAP);
		}
		// 右侧空间不足时翻转到光标左侧，仍放不下则夹紧到视口内。
		if (x + rect.width > vw) {
			const flipped = x - rect.width;
			x = flipped >= VIEWPORT_GAP ? flipped : Math.max(VIEWPORT_GAP, vw - rect.width - VIEWPORT_GAP);
		}
		setPos((current) => (current.x === x && current.y === y ? current : { x, y }));
	}, [props.x, props.y]);

	useDismissableLayer({
		open: true,
		elementRef: menuRef,
		// 外部点击由 backdrop 吞掉并关闭，见文件头注释。
		dismissOnOutsidePointer: false,
		onDismiss: props.onClose,
	});

	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				ref={menuRef}
				className={["context-menu", props.className].filter(Boolean).join(" ")}
				style={{ left: pos.x, top: pos.y }}
				onClick={(event) => event.stopPropagation()}
			>
				{props.children}
			</div>
		</div>
	);
}
