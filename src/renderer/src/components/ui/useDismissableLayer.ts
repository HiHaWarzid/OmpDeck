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
	/**
	 * 覆盖「打开它的元素」。缺省时自动取打开瞬间聚焦的元素——必须在**渲染期**记，
	 * 不能等到注册：层内输入框的 `autoFocus` 在 commit 时就抢走了焦点，
	 * 此时再读 activeElement 只会读到即将卸载的层内节点，焦点归还变成把焦点丢给弹框。
	 */
	returnFocusRef?: RefObject<HTMLElement | null>;
	/**
	 * toggle 型浮层的触发器。pointerdown 落在它上面不算外部，否则「再点一次收起」
	 * 会先被关闭、再被同一个 click 打开。
	 */
	triggerRef?: RefObject<HTMLElement | null>;
	dismissOnOutsidePointer?: boolean;
}): void {
	const { open, elementRef, returnFocusRef, triggerRef } = options;
	const dismissRef = useRef(options.onDismiss);
	dismissRef.current = options.onDismiss;

	// 打开这一帧的 activeElement 就是触发器（点按钮 → 按钮聚焦 → 状态位翻真）。
	const wasOpenRef = useRef(false);
	const openerRef = useRef<HTMLElement | null>(null);
	if (open && !wasOpenRef.current && typeof document !== "undefined") {
		const active = document.activeElement;
		openerRef.current = active instanceof HTMLElement ? active : null;
	}
	wasOpenRef.current = open;

	useEffect(() => {
		if (!open) return;
		return registerDismissableLayer({
			getElement: () => elementRef.current,
			getReturnFocus: returnFocusRef
				? () => returnFocusRef.current
				: () => {
						// body 表示打开时没有真实焦点（脚本打开、点空白处），归还给它没有意义；
						// 触发器可能已经随渲染被卸载，那时也不该 focus 一个游离节点。
						const opener = openerRef.current;
						if (!opener || opener === document.body || !opener.isConnected) return null;
						return opener;
					},
			getTriggerElement: triggerRef ? () => triggerRef.current : undefined,
			dismissOnOutsidePointer: options.dismissOnOutsidePointer,
			onDismiss: (reason) => dismissRef.current(reason),
		});
	}, [
		open,
		elementRef,
		returnFocusRef,
		triggerRef,
		options.dismissOnOutsidePointer,
	]);
}
