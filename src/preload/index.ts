import { contextBridge, ipcRenderer, webUtils } from "electron";
import { buildApi, type IpcBridge } from "./buildApi";
import { ipcChannels } from "../shared/ipc";
import type { PiDesktopApi } from "../shared/api";

/**
 * 从系统剪贴板读取「资源管理器复制文件」的本地路径列表。
 * Electron 已弃用 renderer/preload 进程直接访问 clipboard API，此处改为
 * 主进程 IPC 同步读取（ipcMain.on + returnValue），保持同步契约不变。
 */
function readClipboardFilePaths(): string[] {
	try {
		return ipcRenderer.sendSync(
			ipcChannels.clipboardReadFilePaths,
		) as string[];
	} catch {
		// 剪贴板格式不可用时静默失败，回退为普通文本粘贴
		return [];
	}
}

/**
 * 把 ipcRenderer 收窄为 buildApi 需要的 bridge（保持 electron 运行时行为不变）。
 * 依赖注入让 buildApi 可以在 vitest（node 环境）里用假 bridge 直接测。
 */
const bridge: IpcBridge = {
	invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
	send: (channel, ...args) => ipcRenderer.send(channel, ...args),
	sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
	on: (channel, listener) => ipcRenderer.on(channel, listener),
	removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
};

/**
 * 表外成员覆盖层：需要特殊实现（非 IPC、sendSync 同步读取、fire-and-forget）的成员由这里提供。
 * 成员签名以 NamespaceOverrides 编译期校验，与 ipcTable 里的 override 标记一一对应。
 */
const apiOverrides: NamespaceOverrides = {
	files: {
		/**
		 * Electron 32+ 已移除 File.path，拖拽/粘贴得到的 File 必须经 webUtils 解析本地路径。
		 * 同步返回，可在 drop/paste 事件中立即使用。
		 */
		getPathForFile: (file: File) => {
			try {
				return webUtils.getPathForFile(file) || "";
			} catch {
				return "";
			}
		},
		/**
		 * 读取资源管理器「复制文件」到剪贴板的路径列表。
		 * 浏览器 ClipboardEvent 通常暴露不出 kind=file，粘贴文件引用依赖此同步 API。
		 */
		getClipboardPaths: () => readClipboardFilePaths(),
	},
	perf: {
		/** PIDECK_PERF=1 时渲染层开启帧间隔/渲染耗时诊断（见 utils/perfStats.ts） */
		enabled: process.env.PIDECK_PERF === "1",
	},
	clipboard: {
		/**
		 * 写入文本到系统剪贴板（fire-and-forget，不返回 Promise）。
		 * 使用主进程 clipboard API（经 IPC），不依赖 document focus，
		 * 避免 navigator.clipboard.writeText() 在窗口失焦时抛
		 * "Document is not focused" 异常；同时规避 renderer 进程
		 * clipboard API 弃用（Electron 未来版本将移除）。
		 */
		writeText: (text: string) => {
			void ipcRenderer.invoke(ipcChannels.clipboardWriteText, text).catch(() => {});
		},
	},
};

/** 覆盖层形状：任意命名空间的成员子集（成员签名仍受 PiDesktopApi 编译期校验）。 */
type NamespaceOverrides = {
	[Ns in keyof PiDesktopApi]?: Partial<PiDesktopApi[Ns]>;
};

/**
 * 深合并覆盖层：buildApi 生成 + 特殊成员覆盖，逐命名空间合并，
 * 不能让覆盖层顶掉同一命名空间里由表生成的其它成员。
 * 接口类型没有索引签名，中间态用 Record 承载；边界处收敛：
 * 入参形状由 NamespaceOverrides 编译期校验，返回值以 PiDesktopApi 收敛断言。
 */
function mergeOverrides(base: PiDesktopApi, overrides: NamespaceOverrides): PiDesktopApi {
	const merged = { ...base } as unknown as Record<string, Record<string, unknown>>;
	for (const [namespace, members] of Object.entries(overrides)) {
		merged[namespace] = {
			...(merged[namespace] ?? {}),
			...(members as unknown as Record<string, unknown>),
		};
	}
	return merged as unknown as PiDesktopApi;
}

/** window.piDesktop —— 通道表驱动生成 + 特殊成员覆盖层。 */
const api: PiDesktopApi = mergeOverrides(buildApi(bridge), apiOverrides);

try {
	contextBridge.exposeInMainWorld("piDesktop", api);
	ipcRenderer.send(ipcChannels.preloadReady);
} catch (error) {
	const detail =
		error instanceof Error
			? { message: error.message, stack: error.stack }
			: { message: String(error) };
	console.error("[OmpDeck preload] Failed to expose desktop API", detail);
	ipcRenderer.send(ipcChannels.preloadError, detail);
}
