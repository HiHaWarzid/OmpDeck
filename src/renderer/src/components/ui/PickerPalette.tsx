import { useRef, type ReactNode } from "react";
import { useDismissableLayer } from "./useDismissableLayer";

/**
 * 居中浮层外壳（backdrop + palette）：composer 的模型 / 模式 / 思考档位 / 提示模板四个选择器共用。
 *
 * 为什么成模块：此前四处各自写 `div.picker-backdrop onClick={onClose}` + 内层 `stopPropagation`，
 * 把「关闭」实现成只有鼠标能触发的一条路径——Esc 完全无效，焦点也留在被卸载的选项上，
 * 下一个 Tab 从文档头开始。`dismissableLayer` 已经是关闭行为的唯一属主，这四个浮层只是它的
 * 一类使用者：外壳负责结构、外部点击、Esc 与焦点归还，调用方只提供 palette 的类名与内容。
 *
 * 焦点归还取「打开瞬间的 activeElement」，不由 App 逐层透传 ref：触发按钮埋在 composer 底栏的
 * memo 组件里，为了一次 `.focus()` 把 ref 穿过整条链得不偿失。快照必须在**渲染期**取：
 * 模型选择器的搜索框带 `autoFocus`，等到副作用阶段读到的已是浮层内部的输入框，
 * 归还焦点会落到一个随即卸载的节点上。
 */

export type PickerPaletteProps = {
	/** palette 自身的额外类名（如 `model-picker`）；外壳结构由本组件决定。 */
	className?: string;
	/** 关闭回调。Esc 与外部点击都会走到这里；选中某项后的关闭由调用方负责。 */
	onClose: () => void;
	children: ReactNode;
};

export function PickerPalette(props: PickerPaletteProps) {
	const paletteRef = useRef<HTMLDivElement | null>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	if (returnFocusRef.current === null) {
		const active = document.activeElement;
		// body 表示没有真实焦点（点空白处或脚本打开），归还给它没有意义。
		if (active instanceof HTMLElement && active !== document.body) {
			returnFocusRef.current = active;
		}
	}

	useDismissableLayer({
		open: true,
		elementRef: paletteRef,
		onDismiss: props.onClose,
		returnFocusRef,
	});

	return (
		<div className="picker-backdrop">
			<div
				ref={paletteRef}
				className={["picker-palette", props.className].filter(Boolean).join(" ")}
			>
				{props.children}
			</div>
		</div>
	);
}
