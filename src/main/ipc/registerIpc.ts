import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { ipcTable, type IpcOpEntry } from "../../shared/ipc";

/**
 * 表驱动 IPC 注册循环。
 * 各 handler 模块返回 HandlerMap（成员名 = api 成员名），这里从通道表取通道名与协议：
 * - invoke → ipcMain.handle
 * - send / sendSync → ipcMain.on（sendSync 的 handler 用 event.returnValue 同步回写）
 * 表里查不到条目的成员直接抛错——防止表外裸注册绕过通道表。
 */
export type IpcHandlerFn = (...args: never[]) => unknown;
export type IpcHandlerMaps = Record<string, Record<string, IpcHandlerFn>>;

export function registerIpcHandlers(maps: IpcHandlerMaps): void {
	const table = ipcTable as Record<string, Record<string, IpcOpEntry>>;
	for (const [namespace, map] of Object.entries(maps)) {
		for (const [member, handler] of Object.entries(map)) {
			const entry = table[namespace]?.[member];
			if (!entry?.channel) {
				throw new Error(`IPC 通道表缺失条目: ${namespace}.${member}`);
			}
			if (entry.kind === "send" || entry.kind === "sendSync") {
				// 模块侧签名已由 IpcHandlerMap 编译期校验；这里只做 electron 监听器边界的形状适配
				ipcMain.on(entry.channel, handler as (event: IpcMainEvent, ...args: unknown[]) => void);
			} else {
				ipcMain.handle(entry.channel, handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
			}
		}
	}
}
