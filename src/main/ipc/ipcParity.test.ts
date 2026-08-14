import { describe, expect, test, vi } from "vitest";

// feishuHandlers 模块级 import FeishuBridge（构造时读 userData），vitest node 环境无 electron；
// 用最小 mock 让模块可加载（注册函数只建闭包，不触达这些 API）
vi.mock("electron", () => ({
	app: {
		getPath: () => "C:/vitest-mock-userdata",
		getAppPath: () => "C:/vitest-mock-app",
		getVersion: () => "0.0.0",
		getPreferredSystemLanguages: () => [],
		isPackaged: true,
	},
	ipcMain: { handle: vi.fn(), on: vi.fn() },
	BrowserWindow: class {},
	Notification: class {},
	clipboard: { readBuffer: () => undefined, has: () => false, read: () => "" },
}));

vi.mock("@electron-toolkit/utils", () => ({
	is: { dev: true, mac: false, windows: true, linux: false },
}));

import { ipcTable, type IpcOpEntry } from "../../shared/ipc";
import { registerAgentHandlers } from "./agentHandlers";
import { registerAppHandlers } from "./appHandlers";
import { registerClipboardHandlers } from "./clipboardHandlers";
import { registerConfigHandlers } from "./configHandlers";
import { registerEditorHandlers } from "./editorHandlers";
import { registerExtensionHandlers } from "./extensionHandlers";
import { registerFeishuHandlers } from "./feishuHandlers";
import { registerFileHandlers } from "./fileHandlers";
import { registerGitHandlers } from "./gitHandlers";
import { registerLogHandlers } from "./logHandlers";
import { registerPiHandlers } from "./piHandlers";
import { registerProjectHandlers } from "./projectHandlers";
import { registerPromptHandlers } from "./promptHandlers";
import { registerScratchPadHandlers } from "./scratchPadHandlers";
import { registerSessionHandlers } from "./sessionHandlers";
import { registerSkillHandlers } from "./skillHandlers";
import { registerStoreHandlers } from "./storeHandlers";
import { registerTerminalHandlers } from "./terminalHandlers";
import { PetSystem } from "../pet";

/**
 * IPC 注册奇偶校验：所有 HandlerMap 模块的 map 成员必须与通道表的 invoke/send 条目一一对应。
 * - 每个已注册成员必须能在表里找到（channel 存在、kind 为 invoke/send/sendSync）
 * - 每个表的 invoke/send/sendSync 条目必须恰好被一个模块注册一次（防漏注册/重复注册）
 * 注册函数只建闭包不触碰 deps，因此可以传入空对象 stub 安全调用。
 */
const stubs = {} as never;

// 各模块返回的 map：命名空间 → 成员名集合（合并后全量奇偶）
const moduleMaps = [
	registerLogHandlers({ appLogger: stubs, rpcLogger: stubs }),
	registerSkillHandlers({ skillManager: stubs, appLogger: stubs }),
	registerTerminalHandlers({ terminalManager: stubs, appLogger: stubs }),
	registerExtensionHandlers({ extensionManager: stubs, appLogger: stubs, getActiveWslEnvironment: () => null }),
	registerEditorHandlers({ settingsStore: stubs, appLogger: stubs, getMainWindow: () => null }),
	registerPromptHandlers({ promptManager: stubs, appLogger: stubs }),
	registerScratchPadHandlers({ appLogger: stubs }),
	registerStoreHandlers({ promptManager: stubs, skillManager: stubs, xuePromptManager: stubs, appLogger: stubs }),
	registerProjectHandlers({
		projectStore: stubs,
		projectResourceManager: stubs,
		settingsStore: stubs,
		appLogger: stubs,
		agentManager: stubs,
		gitService: stubs,
		worktreeService: stubs,
		getMainWindow: () => null,
		getActiveWslEnvironment: () => null,
		syncWslEnvironment: stubs,
	}),
	registerFileHandlers({ projectStore: stubs, fileSystemService: stubs, settingsStore: stubs, appLogger: stubs }),
	registerSessionHandlers({ projectStore: stubs, sessionScanner: stubs, importPipeline: stubs, agentManager: stubs, appLogger: stubs }),
	registerGitHandlers({ projectStore: stubs, gitService: stubs, settingsStore: stubs, worktreeService: stubs, appLogger: stubs, quickGen: stubs }),
	registerConfigHandlers({ configManager: stubs, agentManager: stubs, appLogger: stubs }),
	registerClipboardHandlers(),
	registerPiHandlers({ piLocator: stubs, settingsStore: stubs, extensionManager: stubs, appLogger: stubs, configManager: stubs }),
	registerAgentHandlers({
		agentManager: stubs,
		terminalManager: stubs,
		appLogger: stubs,
		getFeishuBridge: () => null,
		getMainWindow: () => null,
	}),
	registerAppHandlers({
		appLogger: stubs,
		settingsStore: stubs,
		agentManager: stubs,
		terminalManager: stubs,
		piLocator: stubs,
		updateManager: stubs,
		getMainWindow: () => null,
		setIsQuitting: stubs,
		releaseSingleInstanceLock: stubs,
		restartApp: stubs,
		getPetSystem: () => null,
		getWebServiceManager: () => undefined,
		openExternalUrl: stubs,
		syncWslEnvironment: stubs,
		applyNativeThemeSource: stubs,
	}),
	registerFeishuHandlers({
		agentManager: stubs,
		projectStore: stubs,
		appLogger: stubs,
		getMainWindow: () => null,
		getFeishuBridge: () => null,
		setFeishuBridge: stubs,
	}),
	// pet 走 PetSystem.handlerMaps（start() 时经 registerIpcHandlers 注册）
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(new PetSystem({ agentManager: stubs, settingsStore: stubs, getMainWindow: () => null }) as any).handlerMaps(),
];

// pet 是 class 私有（PetSystem.handlerMaps），不在模块注册表里；其注册经 registerIpcHandlers 同一条循环
describe("IPC 注册奇偶校验", () => {
	const registered = new Map<string, string>(); // channel → "ns.member"
	for (const map of moduleMaps) {
		for (const [ns, members] of Object.entries(map)) {
			for (const [member] of Object.entries(members as Record<string, unknown>)) {
				const key = `${ns}.${member}`;
				const entry = (ipcTable as Record<string, Record<string, IpcOpEntry>>)[ns]?.[member];
				expect(entry, `${key} 必须在通道表中`).toBeDefined();
				expect(entry?.channel, `${key} 必须有 channel`).toBeDefined();
				if (entry && entry.channel) {
					const prev = registered.get(entry.channel);
					expect(prev, `通道 ${entry.channel} 重复注册（${prev} vs ${key}）`).toBeUndefined();
					registered.set(entry.channel, key);
				}
			}
		}
	}

	test("每个 handler 成员都能在通道表找到条目", () => {
		// 上面遍历已断言；此处统计已注册通道数
		expect(registered.size).toBeGreaterThan(100);
	});

	test("表的 invoke/send/sendSync 条目全部被注册", () => {
		const unregistered: string[] = [];
		for (const [ns, members] of Object.entries(ipcTable)) {
			for (const [member, entry] of Object.entries(members as Record<string, IpcOpEntry>)) {
				if (entry.kind === "invoke" || entry.kind === "send" || entry.kind === "sendSync") {
					if (entry.channel && !registered.has(entry.channel)) {
						unregistered.push(`${ns}.${member} (${entry.channel})`);
					}
				}
			}
		}
		expect(unregistered).toEqual([]);
	});
});
