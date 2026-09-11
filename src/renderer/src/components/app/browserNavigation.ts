/**
 * 内置浏览器面板的外部导航订阅（纯模块，无 React/DOM 依赖，可单测）。
 *
 * 从 BrowserPanel.tsx 抽出：面板挂载时订阅、卸载时退订，外部（链接点击、
 * 「在浏览器中打开」）调用 navigateTo。面板未挂载时 URL 暂存，挂载时消费。
 *
 * 关键约定：**有订阅者时不再入队**。否则已投递的 URL 会残留在 pendingUrl 里，
 * 面板下次挂载（抽屉关闭再打开）会把上一次导航重放成一个新 tab。
 */

type NavigateListener = (url: string) => void;

const navigateListeners = new Set<NavigateListener>();
let pendingUrl: string | null = null;

/**
 * 在浏览器侧栏/弹框中导航到指定 URL。
 * 有订阅者（面板已挂载）时立即通知；无订阅者时存入 pendingUrl 待挂载时消费。
 */
export function navigateTo(url: string): void {
	if (navigateListeners.size === 0) {
		pendingUrl = url;
		return;
	}
	for (const listener of navigateListeners) {
		listener(url);
	}
}

/** 面板挂载时注册导航回调，返回退订函数（卸载时调用）。 */
export function subscribeNavigate(listener: NavigateListener): () => void {
	navigateListeners.add(listener);
	return () => {
		navigateListeners.delete(listener);
	};
}

/** 取出并清空面板未挂载期间暂存的导航请求。 */
export function consumePendingUrl(): string | null {
	const url = pendingUrl;
	pendingUrl = null;
	return url;
}
