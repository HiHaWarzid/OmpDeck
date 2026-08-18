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
import { assertNamespaceOwnership, missingNamespaceOwners } from "./namespaceOwnership";
import { registerAgentHandlers } from "./agentHandlers";
import { registerAfkHandlers } from "../afk/afkHandlers";
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
 * - 每个已注册成员的主模块必须是其命名空间的声明所有者（NAMESPACE_OWNERS，防新成员加错模块）
 * - 表的每个命名空间都必须有声明所有者（防新建命名空间无人认领）
 * 注册函数只建闭包不触碰 deps，因此可以传入空对象 stub 安全调用。
 */
const stubs = {} as never;

// pet 走 PetSystem.handlerMaps（start() 时经 registerIpcHandlers 注册）；
// handlerMaps 是 PetSystem 的 private 成员，具名收窄到仅含可遍历的注册 map 形状（测试只借用注册面）。
const petSystemShim = new PetSystem({ agentManager: stubs, settingsStore: stubs, getMainWindow: () => null }) as unknown as {
	handlerMaps: () => Record<string, Record<string, unknown>>;
};
const petHandlerMaps = petSystemShim.handlerMaps();

// 各模块返回的 map：命名空间 → 成员名集合（合并后全量奇偶）。
// module 标注主模块（命名空间所有权校验用，见 NAMESPACE_OWNERS）。
const moduleRegistrations = [
	{ module: "logHandlers", map: registerLogHandlers({ appLogger: stubs, rpcLogger: stubs }) },
	{ module: "skillHandlers", map: registerSkillHandlers({ skillManager: stubs, appLogger: stubs }) },
	{ module: "terminalHandlers", map: registerTerminalHandlers({ terminalManager: stubs, appLogger: stubs }) },
	{
		module: "extensionHandlers",
		map: registerExtensionHandlers({ extensionManager: stubs, appLogger: stubs, getActiveWslEnvironment: () => null }),
	},
	{
		module: "editorHandlers",
		map: registerEditorHandlers({ settingsStore: stubs, appLogger: stubs, getMainWindow: () => null }),
	},
	{ module: "promptHandlers", map: registerPromptHandlers({ promptManager: stubs, appLogger: stubs }) },
	{ module: "scratchPadHandlers", map: registerScratchPadHandlers({ appLogger: stubs }) },
	{
		module: "storeHandlers",
		map: registerStoreHandlers({ promptManager: stubs, skillManager: stubs, xuePromptManager: stubs, appLogger: stubs }),
	},
	{
		module: "projectHandlers",
		map: registerProjectHandlers({
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
	},
	{
		module: "fileHandlers",
		map: registerFileHandlers({ projectStore: stubs, fileSystemService: stubs, settingsStore: stubs, appLogger: stubs }),
	},
	{
		module: "sessionHandlers",
		map: registerSessionHandlers({ projectStore: stubs, sessionScanner: stubs, importPipeline: stubs, agentManager: stubs, appLogger: stubs }),
	},
	{
		module: "gitHandlers",
		map: registerGitHandlers({ projectStore: stubs, gitService: stubs, settingsStore: stubs, worktreeService: stubs, appLogger: stubs, quickGen: stubs }),
	},
	{ module: "configHandlers", map: registerConfigHandlers({ configManager: stubs, agentManager: stubs, appLogger: stubs }) },
	{ module: "clipboardHandlers", map: registerClipboardHandlers() },
	{
		module: "piHandlers",
		map: registerPiHandlers({ piLocator: stubs, settingsStore: stubs, extensionManager: stubs, appLogger: stubs, configManager: stubs }),
	},
	{ module: "afkHandlers", map: registerAfkHandlers({ orchestrator: stubs }) },
	{
		module: "agentHandlers",
		map: registerAgentHandlers({
			agentManager: stubs,
			terminalManager: stubs,
			appLogger: stubs,
			getFeishuBridge: () => null,
			getMainWindow: () => null,
		}),
	},
	{
		module: "appHandlers",
		map: registerAppHandlers({
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
			getAfkOrchestrator: () => undefined,
			openExternalUrl: stubs,
			syncWslEnvironment: stubs,
			applyNativeThemeSource: stubs,
		}),
	},
	{
		module: "feishuHandlers",
		map: registerFeishuHandlers({
			agentManager: stubs,
			projectStore: stubs,
			appLogger: stubs,
			getMainWindow: () => null,
			getFeishuBridge: () => null,
			setFeishuBridge: stubs,
		}),
	},
	{ module: "pet", map: petHandlerMaps },
];

// 各注册模块的 map 已全部带 module 标签进 moduleRegistrations（含 pet），与 registerIpcHandlers 合并循环同源
describe("IPC 注册奇偶校验", () => {
	const registered = new Map<string, string>(); // channel → "ns.member"
	for (const { map } of moduleRegistrations) {
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

	test("每个已注册成员的主模块都是其命名空间的声明所有者（NAMESPACE_OWNERS）", () => {
		const violations = assertNamespaceOwnership(
			moduleRegistrations.flatMap(({ module, map }) =>
				Object.keys(map).map((namespace) => ({ namespace, module })),
			),
		);
		expect(violations, "违反命名空间所有权声明的注册").toEqual([]);
	});

	test("表的每个命名空间都有声明所有者", () => {
		expect(missingNamespaceOwners(Object.keys(ipcTable))).toEqual([]);
	});
});
