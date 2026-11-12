import { afterEach, describe, expect, it, vi } from "vitest";
import { claimChunkReload, createChunkAwareLoader, isChunkLoadError, lazyReloadHost } from "./lazyWithReload";

const chunkError = () =>
	new TypeError("Failed to fetch dynamically imported module: file:///x/SettingsModal-abc.js");

function stubHost(now: () => number) {
	const store = new Map<string, string>();
	const reload = vi.fn();
	const log = vi.fn();
	Object.assign(lazyReloadHost, {
		now,
		reload,
		log,
		readMarker: () => store.get("ompdeck.chunk-reload-at") ?? null,
		writeMarker: (value: string) => store.set("ompdeck.chunk-reload-at", value),
	});
	return { reload, log, store };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isChunkLoadError", () => {
	it("识别 Vite/Chromium 的分块失效文案", () => {
		expect(isChunkLoadError(chunkError())).toBe(true);
		expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
	});

	it("非 TypeError 或非分块文案一律不重载", () => {
		expect(isChunkLoadError(new Error("Failed to fetch dynamically imported module: x"))).toBe(false);
		expect(isChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
		expect(isChunkLoadError("boom")).toBe(false);
	});
});

describe("claimChunkReload", () => {
	it("冷却窗口内只放行一次，窗口过期后再次放行", () => {
		let now = 1_000;
		stubHost(() => now);
		expect(claimChunkReload()).toBe(true);
		now += 5_000;
		expect(claimChunkReload()).toBe(false);
		now += 6_000;
		expect(claimChunkReload()).toBe(true);
	});
});

describe("createChunkAwareLoader", () => {
	it("分块失效时重载页面，并保持 pending 避免闪现错误页", async () => {
		vi.useFakeTimers();
		try {
			const host = stubHost(() => 1_000);
			const loader = vi.fn(async () => {
				throw chunkError();
			});
			const load = createChunkAwareLoader(loader);
			let settled = false;
			void load().then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			// 推进时钟，让任何「立即 resolve/reject」的实现暴露出来；pending 不该落定。
			await vi.advanceTimersByTimeAsync(60_000);
			expect(settled).toBe(false);
			expect(host.reload).toHaveBeenCalledTimes(1);
			expect(host.log).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("冷却期内再次失效直接抛错，交给错误边界", async () => {
		stubHost(() => 1_000);
		const load = createChunkAwareLoader(async () => {
			throw chunkError();
		});
		// 第一次触发重载并挂起
		void load();
		// 第二次处于冷却窗口：必须抛出原始错误，而不是无限刷新
		await expect(load()).rejects.toThrow(/dynamically imported module/);
	});

	it("非分块错误原样抛出，不重载", async () => {
		const host = stubHost(() => 1_000);
		const failure = new Error("module init failed");
		const load = createChunkAwareLoader(async () => {
			throw failure;
		});
		await expect(load()).rejects.toBe(failure);
		expect(host.reload).not.toHaveBeenCalled();
	});

	it("正常加载直接返回模块", async () => {
		stubHost(() => 1_000);
		const module = { default: {} };
		const load = createChunkAwareLoader(async () => module);
		await expect(load()).resolves.toBe(module);
	});
});
