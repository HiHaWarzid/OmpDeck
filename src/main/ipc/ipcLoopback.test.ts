import { describe, expect, test, vi } from "vitest";

// ============================================================
// IPC 环回导线：在 vitest（node 环境）里把主进程 handler 与渲染层 api 接成一条真实链路。
// 单对象同时扮演
//   - 主进程侧：ipcMain 记录器（handle/on 注册登记进 registrations）
//   - 渲染进程侧：IpcBridge（invoke/send/sendSync 路由到已注册 handler；
//     on/removeListener 接收主进程推送）
// 主进程推送（handler 内部 mainWindow.webContents.send）经 fake 窗口路由回
// loopback.push() → 记录进 pushedEvents 并派发给 bridge.on 的监听器，
// 从而用真实 handler 代码走完 invoke → 处理 → 推送 → 回调的完整环回。
//
// 类放在 vi.hoisted 里：vi.mock("electron") 的工厂需要引用同一个实例，
// 而 vi.mock 工厂先于普通 import/const 执行，顶层局部变量此时尚未初始化。
// ============================================================
const { loopback } = vi.hoisted(() => {
	type FakeEvent = { returnValue?: unknown; sender: { getURL(): string } };

	const createEvent = (): FakeEvent => ({
		// sendSync 协议：handler 通过 event.returnValue 同步回写
		returnValue: undefined,
		// 部分真实 handler 读 event.sender.getURL()（如 preload 握手日志），提供最小 sender
		sender: { getURL: () => "loopback://renderer" },
	});

	class LoopbackBridge {
		/** ipcMain 注册记录：channel → { kind, fn }（kind: handle=invoke，on=send/sendSync） */
		readonly registrations = new Map<
			string,
			{ kind: "handle" | "on"; fn: (event: FakeEvent, ...args: unknown[]) => unknown }
		>();
		/** 渲染进程侧已注册的推送监听器（bridge.on 挂的订阅回调）。
		 *  存储面用 rest 签名：push 派发时把 (event, ...args) 原样展开；
		 *  两参签名的 listener（buildApi 的 subscribe 包装）可赋值给该类型。 */
		private readonly listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
		/** 主进程 → 渲染进程的推送流水（每次 webContents.send 全量记录，供断言） */
		readonly pushedEvents: Array<{ channel: string; args: unknown[] }> = [];

		/** 主进程注册面：与 electron ipcMain 同签名，registerIpcHandlers 写入这里 */
		readonly ipcMain = {
			handle: (channel: string, fn: (event: FakeEvent, ...args: unknown[]) => unknown) => {
				this.registrations.set(channel, { kind: "handle", fn });
			},
			on: (channel: string, fn: (event: FakeEvent, ...args: unknown[]) => void) => {
				this.registrations.set(channel, { kind: "on", fn });
			},
		};

		// ── 渲染进程 IpcBridge 面（buildApi 消费） ──
		invoke(channel: string, ...args: unknown[]): Promise<unknown> {
			const reg = this.registrations.get(channel);
			if (!reg) return Promise.reject(new Error(`No IPC handler registered for channel: ${channel}`));
			if (reg.kind !== "handle") {
				return Promise.reject(new Error(`Channel ${channel} is not an invoke channel`));
			}
			try {
				return Promise.resolve(reg.fn(createEvent(), ...args));
			} catch (error) {
				// handler 同步抛错也必须以 rejected promise 形态暴露（与 ipcRenderer.invoke 一致）
				return Promise.reject(error);
			}
		}

		send(channel: string, ...args: unknown[]): void {
			const reg = this.registrations.get(channel);
			if (!reg || reg.kind !== "on") return;
			reg.fn(createEvent(), ...args);
		}

		sendSync(channel: string, ...args: unknown[]): unknown {
			const reg = this.registrations.get(channel);
			if (!reg || reg.kind !== "on") return undefined;
			const event = createEvent();
			reg.fn(event, ...args);
			return event.returnValue;
		}

		on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
			let set = this.listeners.get(channel);
			if (!set) {
				set = new Set();
				this.listeners.set(channel, set);
			}
			set.add(listener);
		}

		removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void {
			this.listeners.get(channel)?.delete(listener);
		}

		/** 主进程 → 渲染进程推送（模拟 mainWindow.webContents.send 的落点） */
		push(channel: string, ...args: unknown[]): void {
			this.pushedEvents.push({ channel, args });
			for (const listener of [...(this.listeners.get(channel) ?? [])]) {
				listener({}, ...args);
			}
		}

		/** 主进程持有窗口的假件：webContents.send 路由回本导线（handler 内部推送走这里） */
		createWindow() {
			return {
				isDestroyed: () => false,
				webContents: {
					send: (channel: string, ...args: unknown[]) => this.push(channel, ...args),
					setZoomFactor: () => {},
					isDevToolsOpened: () => false,
					closeDevTools: () => {},
					openDevTools: () => {},
				},
				minimize: () => {},
				close: () => {},
				isMaximized: () => false,
				unmaximize: () => {},
				maximize: () => {},
				isAlwaysOnTop: () => false,
				setAlwaysOnTop: () => {},
			};
		}
	}

	return { loopback: new LoopbackBridge() };
});

// electron mock：ipcMain 的 handle/on 委托给环回导线，让 registerIpcHandlers 的注册落进导线；
// 其余 API 只提供 handler 模块加载所需的最小面（注册函数只建闭包，不触达这些 API）。
vi.mock("electron", () => ({
	app: {
		getPath: () => "C:/vitest-loopback-userdata",
		getAppPath: () => "C:/vitest-mock-app",
		getVersion: () => "0.0.0",
		getPreferredSystemLanguages: () => [],
		isPackaged: true,
	},
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => loopback.ipcMain.handle(channel, fn),
		on: (channel: string, fn: (...args: unknown[]) => void) => loopback.ipcMain.on(channel, fn),
	},
	BrowserWindow: class {},
	Notification: class {},
	Menu: { setApplicationMenu: () => {} },
	clipboard: { readBuffer: () => undefined, has: () => false, read: () => "", writeText: () => {} },
}));

vi.mock("@electron-toolkit/utils", () => ({
	is: { dev: true, mac: false, windows: true, linux: false },
}));

import type { BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { buildApi } from "../../preload/buildApi";
import { registerIpcHandlers } from "./registerIpc";
import { registerAppHandlers, registerPreloadHandshakeHandlers } from "./appHandlers";
import { registerGitHandlers } from "./gitHandlers";
import { registerClipboardHandlers } from "./clipboardHandlers";
import { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";

// ── 链路装配（模块级：测试运行前完成注册，此后全部测试共享同一条真实链路） ──

// 与本批冒烟通道无关的依赖一律空对象 stub（与 ipcParity.test.ts 同风格）
const stubs = {} as never;

const appLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as AppLogger;

// settings.get 与 onApplyWindow 推送走的是真实 SettingsStore 内存态
// （不 load，磁盘读不到 → 回落默认值；update 的 150ms 防抖写盘在测试内用 fake timers 掐掉）
const settingsStore = new SettingsStore();

// git.branches 的 service 假件：projectStore.get 返回假项目，gitService.getBranches 返回假分支
const getBranches = vi.fn(async (_projectPath: string) => ["main", "dev"]);
const projectStoreFake = {
	get: (projectId: string) =>
		projectId === "repo1" ? { id: "repo1", path: "C:/fake/repo", kind: "git" } : undefined,
} as never;

const getMainWindow = (): BrowserWindow | null => loopback.createWindow() as unknown as BrowserWindow;

registerIpcHandlers(
	registerAppHandlers({
		appLogger,
		settingsStore,
		agentManager: stubs,
		terminalManager: stubs,
		piLocator: stubs,
		updateManager: stubs,
		getMainWindow,
		setIsQuitting: stubs,
		releaseSingleInstanceLock: stubs,
		restartApp: stubs,
		getPetSystem: () => null,
		getWebServiceManager: () => undefined,
		openExternalUrl: stubs,
		syncWslEnvironment: stubs,
		applyNativeThemeSource: () => {},
	}),
	registerGitHandlers({
		projectStore: projectStoreFake,
		gitService: { getBranches } as never,
		settingsStore: stubs,
		worktreeService: stubs,
		appLogger: stubs,
		quickGen: stubs,
	}),
	registerClipboardHandlers(),
);
// preload 启动握手是 mainOnly 通道（不走通道表命名空间），由 appHandlers 直接 ipcMain.on 注册
registerPreloadHandshakeHandlers(appLogger);

const api = buildApi(loopback);

describe("IPC 环回冒烟：真实 handler 结果到达渲染层 api", () => {
	test("settings.get（invoke 读）→ handler 执行，结果到达 api", async () => {
		const getSpy = vi.spyOn(settingsStore, "get");
		const settings = await api.settings.get();
		expect(getSpy).toHaveBeenCalledTimes(1);
		// 真实 SettingsStore 未 load 的内存默认值
		expect(settings.zoomFactor).toBe(1);
	});

	test("git.branches（invoke 读）→ 真实 service 假件被调用，分支列表到达 api", async () => {
		const branches = await api.git.branches("repo1");
		expect(branches).toEqual(["main", "dev"]);
		expect(getBranches).toHaveBeenCalledWith("C:/fake/repo");
	});

	test("handler 抛错 → 以 rejected promise 传播错误消息（error-shape 契约）", async () => {
		// git.branches 对未知项目走真实 handler 抛错路径（Project not found）
		await expect(api.git.branches("missing-project")).rejects.toThrow("Project not found: missing-project");
	});

	test("settings.onApplyWindow（subscribe 推送）→ settings.update 触发 webContents.send，payload 到达回调", async () => {
		// fake timers：掐掉 SettingsStore.update 的 150ms 防抖写盘，避免测试进程真实落盘到 userData
		vi.useFakeTimers();
		try {
			const received: unknown[] = [];
			const unsubscribe = api.settings.onApplyWindow((payload) => received.push(payload));

			const updated = await api.settings.update({ useNativeTitleBar: true });
			expect(updated.useNativeTitleBar).toBe(true);

			// 真实推送路径：handler → settingsStore.notifyTitleBarChange(getMainWindow())
			// → fake 窗口 webContents.send("settings:apply-window") → 导线 → 订阅回调
			expect(received).toHaveLength(1);
			expect(received[0]).toMatchObject({ useNativeTitleBar: true });
			// 推送流水里记录到该通道（通道名来自通道表派生，与 buildApi 订阅走的同源）
			expect(loopback.pushedEvents.map((e) => e.channel)).toContain(ipcChannels.settingsApplyWindow);

			unsubscribe();
		} finally {
			vi.useRealTimers();
		}
	});

	test("剪贴板路径读取（sendSync）→ handler 的 event.returnValue 同步回到调用侧", () => {
		// api 面是 override（real 实现走 preload 覆盖层），导线直接驱动 sendSync 验证 on+returnValue 线形；
		// electron mock 无剪贴板内容 → 真实 handler 回落为 []
		expect(loopback.sendSync(ipcChannels.clipboardReadFilePaths)).toEqual([]);
	});

	test("preload 握手（send）→ ipcMain.on handler 被执行", () => {
		loopback.send(ipcChannels.preloadReady);
		expect(appLogger.info).toHaveBeenCalledWith("app", "Preload API exposed", expect.any(Object));
	});
});