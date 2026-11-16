import { describe, expect, it } from "vitest";
import { MainWindowLifecycle, type MainWindowHandle } from "./mainWindow";
import { decideRendererRecovery } from "./rendererRecovery";

/** 假窗口：只实现判定用到的两个能力。 */
function fakeWindow(state: { destroyed?: boolean; crashed?: boolean } = {}): MainWindowHandle {
	return {
		isDestroyed: () => Boolean(state.destroyed),
		webContents: { isCrashed: () => Boolean(state.crashed) },
	};
}

describe("窗口加载健康", () => {
	it("错误页那次 finish 只消费标记，不清除失败态", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		expect(lifecycle.onMainFrameLoadFailed(true)).toEqual({ fallbackToBuiltRenderer: true });
		expect(lifecycle.needsRecovery()).toBe(true);
		// did-fail-load 之后紧跟的 finish 是 Chromium 错误页本身
		lifecycle.onMainFrameLoadFinished();
		expect(lifecycle.needsRecovery()).toBe(true);
		// 真实页面加载成功才清除失败标记
		lifecycle.onMainFrameLoadFinished();
		expect(lifecycle.needsRecovery()).toBe(false);
	});

	it("dev 回退只做一次：再次加载失败不再回退", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		expect(lifecycle.onMainFrameLoadFailed(true).fallbackToBuiltRenderer).toBe(true);
		expect(lifecycle.onMainFrameLoadFailed(true).fallbackToBuiltRenderer).toBe(false);
	});

	it("非 dev 入口没有可回退的构建产物", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		expect(lifecycle.onMainFrameLoadFailed(false).fallbackToBuiltRenderer).toBe(false);
	});

	it("重建窗口后重新尝试 dev URL", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		lifecycle.onMainFrameLoadFailed(true);
		lifecycle.resetLoadHealth();
		// 新窗口既重新尝试 dev URL，也重新获得一次回退机会
		expect(lifecycle.needsRecovery()).toBe(false);
		expect(lifecycle.onMainFrameLoadFailed(true).fallbackToBuiltRenderer).toBe(true);
	});
});

describe("版本次启动的恢复计划", () => {
	it("窗口尚未创建时走完整加载", () => {
		expect(new MainWindowLifecycle(() => null).planVersionFocus()).toBe("open");
	});

	it("窗口已销毁时同样走完整加载", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow({ destroyed: true }));
		expect(lifecycle.planVersionFocus()).toBe("open");
	});

	it("健康窗口只前置，不重建", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		expect(lifecycle.planVersionFocus()).toBe("focus");
	});

	it("渲染进程崩溃的窗口必须重建而不是聚焦", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow({ crashed: true }));
		expect(lifecycle.planVersionFocus()).toBe("recreate");
	});

	it("停在错误页的窗口必须重建，仅聚焦无济于事", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		lifecycle.onMainFrameLoadFailed(false);
		expect(lifecycle.planVersionFocus()).toBe("recreate");
	});

	it("窗口销毁重建后按新窗口判定，不沿用旧状态", () => {
		let current: MainWindowHandle | null = null;
		const lifecycle = new MainWindowLifecycle(() => current);
		current = fakeWindow({ crashed: true });
		expect(lifecycle.planVersionFocus()).toBe("recreate");
		// 重建：新窗口健康
		current = fakeWindow();
		lifecycle.resetLoadHealth();
		expect(lifecycle.planVersionFocus()).toBe("focus");
	});
});

describe("关窗语义", () => {
	it("启用关闭到托盘时隐藏", () => {
		expect(new MainWindowLifecycle(() => fakeWindow()).planClose(true)).toBe("hide");
	});

	it("未启用托盘时关闭即退出", () => {
		expect(new MainWindowLifecycle(() => fakeWindow()).planClose(false)).toBe("quit");
	});

	it("主动退出后不再走托盘分支", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		lifecycle.setQuitting(true);
		expect(lifecycle.planClose(true)).toBe("ignore");
		expect(lifecycle.isQuitting()).toBe(true);
	});
});

describe("渲染进程 gone", () => {
	it("clean-exit 与已销毁窗口都不自愈", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		expect(lifecycle.shouldRecoverRenderer(fakeWindow(), true)).toBe(false);
		expect(lifecycle.shouldRecoverRenderer(fakeWindow({ destroyed: true }), false)).toBe(false);
	});

	it("崩溃且窗口仍在时自愈", () => {
		expect(new MainWindowLifecycle(() => fakeWindow()).shouldRecoverRenderer(fakeWindow(), false)).toBe(true);
	});

	it("重建后旧窗口的迟到事件按旧窗口判定，不看当前主窗口", () => {
		// 当前主窗口是健康的新窗口，但事件来自已销毁的旧窗口：不得据此恢复/强杀。
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		const stale = fakeWindow({ destroyed: true });
		expect(lifecycle.shouldRecoverRenderer(stale, false)).toBe(false);
		expect(lifecycle.planUnresponsiveRecovery(stale)).toBe("ignore");
	});
});

describe("无响应处置", () => {
	it("窗口仍在且渲染进程未崩溃时强杀", () => {
		expect(new MainWindowLifecycle(() => fakeWindow()).planUnresponsiveRecovery(fakeWindow())).toBe("force-crash");
	});

	it("窗口已销毁或渲染进程已崩溃时交给既有路径", () => {
		expect(new MainWindowLifecycle(() => fakeWindow()).planUnresponsiveRecovery(fakeWindow({ destroyed: true }))).toBe("ignore");
		expect(new MainWindowLifecycle(() => fakeWindow()).planUnresponsiveRecovery(fakeWindow({ crashed: true }))).toBe("ignore");
	});
});

describe("自愈次数账本", () => {
	const NOW = 1_000_000;

	it("超限前自动 reload，超限后交回用户", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		expect(lifecycle.decideRecovery(NOW, decideRendererRecovery).action).toBe("reload");
		expect(lifecycle.decideRecovery(NOW, decideRendererRecovery).action).toBe("reload");
		expect(lifecycle.decideRecovery(NOW, decideRendererRecovery).action).toBe("reload");
		expect(lifecycle.decideRecovery(NOW, decideRendererRecovery).action).toBe("prompt");
	});

	it("prompt 分支不追加时间戳，用户再试后不会立刻又超限", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		for (let index = 0; index < 3; index += 1) lifecycle.decideRecovery(NOW, decideRendererRecovery);
		const prompt = lifecycle.decideRecovery(NOW, decideRendererRecovery);
		expect(prompt.action).toBe("prompt");
		expect(prompt.attempts).toHaveLength(3);
		// 用户点「再试一次」：清空计数，重新获得完整预算
		lifecycle.resetRecoveryAttempts();
		expect(lifecycle.decideRecovery(NOW, decideRendererRecovery).action).toBe("reload");
	});

	it("窗口外的旧尝试不再计数", () => {
		const lifecycle = new MainWindowLifecycle(() => fakeWindow());
		for (let index = 0; index < 3; index += 1) lifecycle.decideRecovery(NOW, decideRendererRecovery);
		expect(lifecycle.decideRecovery(NOW, decideRendererRecovery).action).toBe("prompt");
		// 10 分钟后：三次旧尝试都滑出窗口
		expect(lifecycle.decideRecovery(NOW + 10 * 60 * 1000 + 1, decideRendererRecovery).action).toBe(
			"reload",
		);
	});
});
