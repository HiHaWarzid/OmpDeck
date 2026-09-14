/**
 * settings.update 的 web 服务失败回落语义。
 *
 * WebServiceManager.applySettings 先绑新端口、成功后才关旧 server：
 * 新端口被占用时旧服务仍在正常服务。此时把 webServiceEnabled 回写成 false
 * 会把一个可用服务误判为失败并强关，所以只有确实没有任何实例在跑
 * （isRunning() === false）才允许回落开关；旧服务存活时必须保留设置并把错误抛给 UI。
 */
import { vi, test, expect } from "vitest";

vi.mock("electron", () => ({
	app: { getVersion: () => "0.0.0-test", getPath: () => process.cwd() },
	ipcMain: { on: () => {}, handle: () => {} },
	shell: {},
	net: {},
	BrowserWindow: class {},
}));

import { registerAppHandlers } from "./appHandlers";
import type { AppSettings } from "../../shared/types";

// 与本用例无关的依赖一律空对象 stub（与 ipcLoopback.test.ts 同风格）
const stubs = {} as never;

const appLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as never;

function makeSettingsStore() {
	const state: Partial<AppSettings> = {
		webServiceEnabled: true,
		webServiceHost: "0.0.0.0",
		webServicePort: 1234,
	};
	const updateCalls: Array<Partial<AppSettings>> = [];
	const store = {
		get: () => ({ ...state }),
		update: async (patch: Partial<AppSettings>) => {
			updateCalls.push(patch);
			Object.assign(state, patch);
			return { ...state };
		},
		notifyTitleBarChange: () => {},
	};
	return { state, updateCalls, store };
}

/** 只覆写 settings.update 需要的依赖；其余字段留空 stub。 */
function register(webServiceManager: { applySettings: () => Promise<void>; isRunning: () => boolean }) {
	const settingsStore = makeSettingsStore();
	const handlers = registerAppHandlers({
		appLogger,
		settingsStore: settingsStore.store,
		agentManager: stubs,
		terminalManager: stubs,
		piLocator: stubs,
		updateManager: stubs,
		getMainWindow: () => null,
		setIsQuitting: stubs,
		releaseSingleInstanceLock: stubs,
		restartApp: stubs,
		getPetSystem: () => null,
		getWebServiceManager: () => webServiceManager,
		openExternalUrl: stubs,
		syncWslEnvironment: stubs,
		applyNativeThemeSource: () => {},
	} as never);
	return { settingsStore, update: handlers.settings.update };
}

test("旧服务仍在运行：失败不回写 webServiceEnabled，且端口回滚到实际在服务的值", async () => {
	const manager = {
		applySettings: async () => {
			throw new Error("EADDRINUSE: 端口被占用");
		},
		isRunning: () => true,
	};
	const { settingsStore, update } = register(manager);

	await expect(update({} as never, { webServicePort: 4321 })).rejects.toThrow("EADDRINUSE");
	// 关键断言：可用服务没有被强关，也没有任何回写 webServiceEnabled 的调用。
	expect(settingsStore.updateCalls.some((patch) => "webServiceEnabled" in patch)).toBe(false);
	expect(settingsStore.state.webServiceEnabled).toBe(true);
	// 端口未生效 → 必须回滚，否则面板显示 4321 而实际服务在 1234。
	expect(settingsStore.state.webServicePort).toBe(1234);
	expect(settingsStore.updateCalls.at(-1)).toEqual({ webServicePort: 1234 });
});

test("确实没有服务在跑：失败回写 webServiceEnabled=false 并回滚端口", async () => {
	const manager = {
		applySettings: async () => {
			throw new Error("EADDRINUSE: 端口被占用");
		},
		isRunning: () => false,
	};
	const { settingsStore, update } = register(manager);

	await expect(update({} as never, { webServicePort: 4321 })).rejects.toThrow("EADDRINUSE");
	expect(settingsStore.state.webServiceEnabled).toBe(false);
	expect(settingsStore.state.webServicePort).toBe(1234);
});

test("同时改开关与端口且失败：两者都回滚", async () => {
	const manager = {
		applySettings: async () => {
			throw new Error("EADDRINUSE: 端口被占用");
		},
		isRunning: () => true,
	};
	const { settingsStore, update } = register(manager);

	await expect(
		update({} as never, { webServiceEnabled: false, webServiceHost: "127.0.0.1", webServicePort: 4321 }),
	).rejects.toThrow("EADDRINUSE");
	// 旧服务仍在跑，所以三个键都回到应用前：面板与服务保持一致。
	expect(settingsStore.state.webServiceEnabled).toBe(true);
	expect(settingsStore.state.webServiceHost).toBe("0.0.0.0");
	expect(settingsStore.state.webServicePort).toBe(1234);
});
