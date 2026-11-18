import type { PiDesktopApi } from "../../shared/api";
import { detectRuntimeSurface, type RuntimeSurface } from "./utils/runtimeSurface";
import { createBrowserApi } from "./browserApi";
import { createPreviewApi } from "./previewApi";
import { t } from "./i18n";

/**
 * 运行时 api 唯一入口：判定宿主，选出对应实现，并装回 `window.piDesktop`。
 *
 * `window.piDesktop` 在除 `missing-preload` 外的所有宿主里都必须有值——约 40 个组件
 * 直接读 `window.piDesktop.*`，它们不各自兜底。这条阶梯原先私有在 `App.tsx` 里，
 * 只有 App 自己拿到正确 api；其余调用方在 LAN-web / 预览宿主读到 undefined，
 * `NativeLoginModal`（常驻挂载）一挂载就崩在 `reading 'agents'`，桌面 Web 视图整页白屏。
 */

export type { RuntimeSurface };

export const runtimeSurface: RuntimeSurface = detectRuntimeSurface({
	hasPreload: Boolean(window.piDesktop),
	userAgent: navigator.userAgent,
	protocol: window.location.protocol,
});

/** 没有本机能力、api 走 HTTP 或内存假数据的宿主。 */
export const isBrowserRuntime =
	runtimeSurface === "lan-web" || runtimeSurface === "preview";

/**
 * 一个「每一步调用都抛 preload 缺失」的替身，让损坏的安装停在可读的错误上，
 * 而不是在某个组件里读到 undefined。
 */
function createUnavailableDesktopApi(): PiDesktopApi {
	const fail = () => {
		throw new Error(t("app.preloadMissing"));
	};
	return new Proxy(
		{},
		{
			get: fail,
			set: fail,
		},
	) as PiDesktopApi;
}

const resolved: PiDesktopApi =
	window.piDesktop ??
	(runtimeSurface === "missing-preload"
		? createUnavailableDesktopApi()
		: runtimeSurface === "lan-web"
			? createBrowserApi()
			: createPreviewApi());

/**
 * `missing-preload` 不写入：让 window 保持 undefined，安装损坏仍然可见、可诊断。
 * 其余宿主写入后，`browserApi` 里「preload 不存在才是 Web 运行时」的判定仍成立，
 * 因为它读的是模块求值期的 window，与这里同一次求值、顺序在安装之后。
 */
if (window.piDesktop === undefined && runtimeSurface !== "missing-preload") {
	window.piDesktop = resolved;
}

export const api: PiDesktopApi = resolved;
