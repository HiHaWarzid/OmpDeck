import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * 懒加载分块取不到时自动整页重载的兜底。
 *
 * 触发场景（真实出现过）：应用运行中重建/更新渲染层产物后，页面仍持有旧 index.html 的
 * 分块 hash，点开设置就会拿到 404 的 SettingsModal-<hash>.js，
 * `import()` 以 TypeError 拒绝 → React.lazy 抛错 → 错误边界把整页换成错误页。
 * 这类失败不是逻辑错误：刷新后拿到新 hash 即可恢复，所以自动 reload 一次比让用户
 * 手动点「重新加载」更可靠（用户点重试按钮只会再次导入同一个失效 URL）。
 *
 * 防死循环：同一时间窗口（COOLDOWN_MS）只允许一次自动重载。重载后仍然失败说明
 * 产物真的坏了，交给错误边界展示，不再反复刷新页面。
 */
const RELOAD_STORAGE_KEY = "ompdeck.chunk-reload-at";
const RELOAD_COOLDOWN_MS = 10_000;

/**
 * 可替换的宿主：跳转、时钟、会话标记与日志。
 * 抽出来是为了让单测能验证「重载一次 / 冷却期内不再重载」，而不真的跳转页面。
 */
export const lazyReloadHost = {
	reload: () => window.location.reload(),
	now: () => Date.now(),
	readMarker: () => window.sessionStorage.getItem(RELOAD_STORAGE_KEY),
	writeMarker: (value: string) => window.sessionStorage.setItem(RELOAD_STORAGE_KEY, value),
	log: (detail: Record<string, unknown>) => {
		try {
			void window.piDesktop?.app
				.rendererLog("warn", "renderer", "Reloading renderer after stale chunk", detail)
				.catch(() => undefined);
		} catch {
			// 日志失败绝不能挡住重载本身。
		}
	},
};

/**
 * 区分「分块 404」与其他异常：只有前者值得整页重载。
 * Chromium 的报错文案是 `Failed to fetch dynamically imported module: <url>`；
 * Vite/部分内核会给出 `Importing a module script failed`。
 */
export function isChunkLoadError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.name !== "TypeError") return false;
	return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
		error.message,
	);
}

/** 冷却窗口内只允许一次自动重载；返回 true 表示本次可以重载。 */
export function claimChunkReload(): boolean {
	try {
		const marker = lazyReloadHost.readMarker();
		const now = lazyReloadHost.now();
		if (marker !== null) {
			const last = Number(marker);
			// 标记存在即「上次已重载过」；缺失时才放行。不能用 0 当默认值判断：
			// 时钟或测试里传入的小时间戳会被误判成刚重载过。
			if (Number.isFinite(last) && now - last < RELOAD_COOLDOWN_MS) return false;
		}
		lazyReloadHost.writeMarker(String(now));
		return true;
	} catch {
		// sessionStorage 不可用（隐私模式/被禁用）时允许本次重载：宁可多刷一次页，
		// 也不要把用户永久留在错误页上。重载失败后会走错误边界，不会形成循环。
		return true;
	}
}

/**
 * 把加载器包成「分块失效 → 重载一次」的版本。
 * 重载期间返回永不 resolve 的 promise，让 Suspense 的 fallback 继续显示，
 * 避免页面在卸载前闪一次错误边界。
 */
export function createChunkAwareLoader<T>(loader: () => Promise<{ default: T }>): () => Promise<{ default: T }> {
	return async () => {
		try {
			return await loader();
		} catch (error) {
			if (!isChunkLoadError(error) || !claimChunkReload()) throw error;
			lazyReloadHost.log({ error: error instanceof Error ? error.message : String(error) });
			lazyReloadHost.reload();
			return new Promise<{ default: T }>(() => undefined);
		}
	};
}

/**
 * `React.lazy` 的替代品：加载失败且判定为分块失效时重载页面，其余异常原样抛出。
 *
 * 泛型约束与 React.lazy 一致用 `ComponentType<any>`：组件 props 是逆变的，
 * 收窄成 `ComponentType<unknown>` 会拒绝所有有必填 props 的组件（MarkdownBody 等），
 * 这正是该包装唯一的用途，不能收窄。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithReload<T extends ComponentType<any>>(
	loader: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
	return lazy(createChunkAwareLoader(loader));
}
