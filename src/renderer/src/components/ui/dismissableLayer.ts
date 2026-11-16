/**
 * 弹层关闭层（dismissable layer）：所有「点外部关闭 / Esc 关闭」行为的唯一属主。
 *
 * 为什么收成一个 module：此前渲染层有 9 处各自监听 window/document，分成两套事件名
 * （mousedown / pointerdown）、两种相位（发送方式菜单用捕获阶段抢在输入框之前），
 * 焦点归还在其中 1 处，Esc 只有 6 处实现——浏览器设备菜单与设置页模型选择器**根本关不掉**。
 * AGENTS.md 甚至为自定义下拉写了一条「必须支持 Esc / 点击外部 / ArrowUp/Down」的例外配方：
 * 那是一份「不存在的 module」的规格说明，于是每个新弹层都再实现一遍，漏掉两处。
 *
 * 现在只有一份 window 捕获监听（用引用计数按需装卸），每条不变式只写一次：
 *
 * - 外部点击：关闭**所有**不包含点击目标的层。点进父层内部时只有内层关闭。
 * - Esc：只有栈顶可关的那一层消费按键，并在捕获阶段 `preventDefault + stopPropagation`。
 *   一次 Esc 只关一层（先关内层），外层不会顺带收到 Esc（输入框的历史导航、
 *   Radix Dialog 的关闭都不会被误触发）。
 * - 焦点归还：Esc 关闭前把焦点还给触发元素，且**先还焦再通知关闭**——触发器的 `onFocus`
 *   可能重新打开菜单（发送方式菜单就是这样），同批次内以关闭收尾。
 * - 顺序确定：捕获阶段监听，不受层内元素自己的 keydown/pointerdown 处理影响。
 *
 * 元素与归还焦点都用取值函数而不是快照：层内可能整体切换到另一个节点
 * （模型角色选择器在角色之间切换时容器节点会重建），快照会指向已卸载的旧节点，
 * 于是任何点击都被判成「外部」。
 *
 * 本模块不认识 React：注册返回注销函数，React 绑定见 `useDismissableLayer`。
 */

/** 关闭原因。焦点归还只发生在 `escape`——鼠标点别处时抢焦点会打断用户的下一个动作。 */
export type DismissReason = "outside-pointer" | "escape";

export type DismissableLayerSpec = {
	/** 层自身的边界元素：落在它内部（含子节点）的指针事件不算外部。返回 null 视为不包含。 */
	getElement: () => HTMLElement | null;
	onDismiss: (reason: DismissReason) => void;
	/** Esc 关闭后归还焦点的元素（通常是打开它的按钮）。 */
	getReturnFocus?: () => HTMLElement | null;
	/** 默认 true。 */
	dismissOnOutsidePointer?: boolean;
	/** 默认 true。 */
	dismissOnEscape?: boolean;
};

/** 打开顺序栈：后注册的在上面。Esc 只作用于栈顶。 */
const layers: DismissableLayerSpec[] = [];
let listening = false;

function handlePointerDown(event: Event): void {
	const target = event.target as Node | null;
	if (!target) return;
	// 从栈顶向下遍历，先关最内层，保证回调里读到的父子关系仍是打开时的样子。
	// 快照后逐个通知：onDismiss 会同步 setState，卸载与注销发生在之后的 commit 阶段。
	const closing = layers
		.filter((layer) => {
			if (layer.dismissOnOutsidePointer === false) return false;
			const element = layer.getElement();
			return !element || !element.contains(target);
		})
		.reverse();
	for (const layer of closing) layer.onDismiss("outside-pointer");
}

function handleKeyDown(event: KeyboardEvent): void {
	if (event.key !== "Escape") return;
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (layer.dismissOnEscape === false) continue;
		// 消费掉这次 Esc：否则层内输入框的 Esc 分支与外层弹框会同时响应。
		event.preventDefault();
		event.stopPropagation();
		const returnFocus = layer.getReturnFocus?.();
		if (returnFocus?.isConnected) returnFocus.focus();
		layer.onDismiss("escape");
		return;
	}
}

function ensureListening(): void {
	if (listening || typeof window === "undefined") return;
	listening = true;
	// 监听放在 window 的捕获阶段，而不是 document：捕获阶段的事件路径是
	// window → document → … → 目标，所以这里**必然**先于任何挂在 document 上的
	// 捕获监听器（Radix Dialog 的 Esc 就是其一）。挂在 document 上则会退化成
	// 「谁先注册谁先跑」——弹框先挂载，Esc 就被它先消费，选择器与弹框一起关掉
	// （真实回归，已在开发态复现）。The order must not depend on mount order.
	window.addEventListener("pointerdown", handlePointerDown, true);
	window.addEventListener("keydown", handleKeyDown, true);
}

function stopListening(): void {
	if (!listening) return;
	listening = false;
	window.removeEventListener("pointerdown", handlePointerDown, true);
	window.removeEventListener("keydown", handleKeyDown, true);
}

/**
 * 注册一层打开的弹层。返回注销函数（幂等）。
 * 每次注册/注销都会按需装卸唯一的一份 window 捕获监听：没有打开的层时不占监听器。
 */
export function registerDismissableLayer(spec: DismissableLayerSpec): () => void {
	layers.push(spec);
	ensureListening();
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		const index = layers.indexOf(spec);
		if (index !== -1) layers.splice(index, 1);
		if (layers.length === 0) stopListening();
	};
}
