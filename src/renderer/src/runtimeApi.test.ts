// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 运行时 api 的选择与安装。
 *
 * 这条阶梯原本只活在 App.tsx 里：App 自己拿到正确的 api，其余约 40 个直接读
 * `window.piDesktop.*` 的调用方在 LAN-web / 预览宿主里读到 undefined，
 * 一挂载就崩（NativeLoginModal 常驻挂载，所以桌面 Web 视图整页白屏）。
 * 现在选择与安装收在 runtimeApi，调用方无需各自兜底。
 */

/** 每次 import 都要重新求值模块，才能模拟不同宿主的首帧。 */
async function load(env: { electron?: boolean; protocol?: string; withPreload?: boolean }) {
	vi.resetModules();
	vi.stubGlobal("navigator", {
		userAgent: env.electron ? "Mozilla/5.0 Electron/38.0.0" : "Mozilla/5.0 Chrome/131",
	});
	// jsdom 的 window 就是 globalThis，因此 stub 全局 location 等价于换掉 window.location。
	vi.stubGlobal("location", { protocol: env.protocol ?? "http:" });
	Object.defineProperty(window, "piDesktop", {
		value: env.withPreload ? { marker: true } : undefined,
		writable: true,
		configurable: true,
	});
	return import("./runtimeApi");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	delete (window as Partial<Window>).piDesktop;
});

describe("runtimeApi", () => {
	it("Electron + preload：直接用 preload 注入的 api，不改写 window", async () => {
		const mod = await load({ electron: true, withPreload: true });
		expect(mod.runtimeSurface).toBe("electron");
		expect(mod.api).toEqual({ marker: true });
		expect(window.piDesktop).toEqual({ marker: true });
	});

	it("Electron 缺 preload：不安装替身对象，损坏保持在 window 上可见", async () => {
		const mod = await load({ electron: true, withPreload: false });
		expect(mod.runtimeSurface).toBe("missing-preload");
		expect(window.piDesktop).toBeUndefined();
		// 替身仍然在 api 上，让调用方停在可读错误而不是 undefined
		expect(() => mod.api.app).toThrow();
	});

	it("LAN-web：把 HTTP api 装回 window.piDesktop，常驻组件不再读到 undefined", async () => {
		const mod = await load({ electron: false, protocol: "http:" });
		expect(mod.runtimeSurface).toBe("lan-web");
		expect(window.piDesktop).toBe(mod.api);
	});

	it("预览宿主（file:）：同样安装，组件与 App 拿到同一个 api", async () => {
		const mod = await load({ electron: false, protocol: "file:" });
		expect(mod.runtimeSurface).toBe("preview");
		expect(window.piDesktop).toBe(mod.api);
	});
});
