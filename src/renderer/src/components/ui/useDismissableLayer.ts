import { useEffect, useRef, type RefObject } from "react";
import {
	registerDismissableLayer,
	type DismissReason,
} from "./dismissableLayer";

/**
 * 把关闭层绑到 React 状态：`open` 为真期间注册一层，关闭或卸载时注销。
 *
 * `onDismiss` 放在 ref 里转发，这样调用方每次渲染新建的箭头函数不会导致
 * 「卸载 → 重装监听」——重装会丢失打开顺序（嵌套的 Esc 会关错层）。
 * 元素同样按需读取：`ref.current` 在注册时可能还没挂上（首次渲染），
 * 也可能因为层内切换而换成了另一个节点。
 */
export function useDismissableLayer(options: {
	open: boolean;
	elementRef: RefObject<HTMLElement | null>;
	onDismiss: (reason: DismissReason) => void;
	returnFocusRef?: RefObject<HTMLElement | null>;
	dismissOnOutsidePointer?: boolean;
	dismissOnEscape?: boolean;
}): void {
	const { open, elementRef, returnFocusRef } = options;
	const dismissRef = useRef(options.onDismiss);
	dismissRef.current = options.onDismiss;

	useEffect(() => {
		if (!open) return;
		return registerDismissableLayer({
			getElement: () => elementRef.current,
			getReturnFocus: returnFocusRef ? () => returnFocusRef.current : undefined,
			dismissOnOutsidePointer: options.dismissOnOutsidePointer,
			dismissOnEscape: options.dismissOnEscape,
			onDismiss: (reason) => dismissRef.current(reason),
		});
	}, [
		open,
		elementRef,
		returnFocusRef,
		options.dismissOnOutsidePointer,
		options.dismissOnEscape,
	]);
}
