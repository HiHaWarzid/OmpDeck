/**
 * 手机端外壳的版本清单：`mobile.html` 的 `?v=` 与 `sw.js` 的 `CACHE_NAME`。
 *
 * 这三个 `?v=` 与一个 `CACHE_NAME` 共同构成整套缓存失效契约：改 JS/CSS 却忘了
 * 抬版本号，手机会继续用缓存里的旧脚本；只抬 `mobile.js` 而忘了 `mobile-state.js`，
 * 就会出现「新的渲染代码 + 旧的纯核心」这种半新半旧的组合（历史上已经踩过一次，
 * 当时靠 mobile.js 里的特性探测兜底）。
 *
 * 静态文件仍然没有构建步骤，所以版本号不作为字面数字写在文件里，而是写占位符
 * `__SHELL_VERSION__`，由 Main 进程在读文件时统一替换（见 WebServiceManager.sendFile）。
 * 这样「四个数字要一起改」变成「一个常量」，漏改在结构上不可能发生；
 * `mobileShell.test.ts` 守着占位符的存在与替换结果的一致性。
 */

/** 唯一版本来源。任何影响手机外壳缓存内容的改动都必须抬这个数字。 */
export const MOBILE_SHELL_VERSION = "30";

/** 静态文件里代表外壳版本的位置。 */
export const MOBILE_SHELL_VERSION_TOKEN = "__SHELL_VERSION__";

/**
 * 把占位符替换成真实版本号。
 *
 * 不持占位符的响应原样返回同一份字符串引用：`sendFile` 会对每个请求调用它，
 * 桌面 bundle 等大文件不该为此多复制一遍。
 */
export function applyMobileShellVersion(text: string): string {
	if (!text.includes(MOBILE_SHELL_VERSION_TOKEN)) return text;
	return text.split(MOBILE_SHELL_VERSION_TOKEN).join(MOBILE_SHELL_VERSION);
}
