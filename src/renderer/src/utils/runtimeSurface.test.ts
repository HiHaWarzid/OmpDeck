import { describe, expect, it } from "vitest";
import { detectRuntimeSurface } from "./runtimeSurface";

/**
 * 宿主判定表。这张表决定两件互相关联的事：选哪个 api、`window.piDesktop` 有没有值。
 * 边界在「Electron 缺 preload」：它不是 Web 宿主，而是安装损坏，必须单独成一档，
 * 否则替换掉的 api 会让坏安装假装能跑。
 */
describe("detectRuntimeSurface", () => {
	const electronUa = "Mozilla/5.0 (Windows NT 10.0) Electron/38.0.0 Chrome/128";
	const browserUa = "Mozilla/5.0 (Windows NT 10.0) Chrome/128";

	it("preload 在就是 electron，不看 UA 与协议", () => {
		expect(
			detectRuntimeSurface({ hasPreload: true, userAgent: browserUa, protocol: "http:" }),
		).toBe("electron");
	});

	it("Electron 里没有 preload 是安装损坏，不当作 Web", () => {
		expect(
			detectRuntimeSurface({ hasPreload: false, userAgent: electronUa, protocol: "http:" }),
		).toBe("missing-preload");
	});

	it("浏览器 + http(s) 是 LAN-web（bundle 由 WebService 下发）", () => {
		expect(
			detectRuntimeSurface({ hasPreload: false, userAgent: browserUa, protocol: "https:" }),
		).toBe("lan-web");
	});

	it("浏览器 + 非 http 协议是预览宿主", () => {
		expect(
			detectRuntimeSurface({ hasPreload: false, userAgent: browserUa, protocol: "file:" }),
		).toBe("preview");
	});
});
