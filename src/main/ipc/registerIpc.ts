import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { ipcTable, type IpcOpEntry } from "../../shared/ipc";
import type { IpcInvokeEnvelope, IpcInvokeFailure } from "../../shared/ipcEnvelope";
import { CommandError } from "../utils/CommandRunner";

/**
 * 表驱动 IPC 注册循环。
 * 各 handler 模块返回 HandlerMap（成员名 = api 成员名），这里从通道表取通道名与协议：
 * - invoke → ipcMain.handle，且统一包装成失败契约（见 wrapInvokeHandler）
 * - send / sendSync → ipcMain.on（sendSync 的 handler 用 event.returnValue 同步回写）
 * 表里查不到条目的成员直接抛错——防止表外裸注册绕过通道表。
 *
 * 接受多个模块的 map 并按命名空间深合并：同一命名空间可能被多个模块分担
 * （如 app.rendererLog 在 logHandlers、app 其余在 appHandlers），合并时逐成员覆盖。
 * 谁允许注册哪个命名空间由 namespaceOwnership.ts 的 NAMESPACE_OWNERS 声明，
 * ipcParity.test.ts 强制校验——新表成员只能加到已声明的宿主模块。
 */
export type IpcHandlerFn = (...args: never[]) => unknown;
export type IpcHandlerMaps = Record<string, Record<string, IpcHandlerFn>>;

/**
 * handler 抛出的错误 → envelope 失败分支。
 * 命令层已分类的 CommandError 原样保留其 kind（timeout / not-found / command），其余一律 "unknown"。
 * message 取原始 message：干净信息的关键不在这里，而在于失败是「返回值」不是「异常」——
 * 只要不抛过界，Electron 那层 `Error invoking remote method '<channel>': Error: ...` 就不会产生。
 */
function toInvokeFailure(error: unknown): IpcInvokeFailure {
	if (error instanceof CommandError) {
		return { ok: false, kind: error.kind, message: error.message };
	}
	return { ok: false, kind: "unknown", message: error instanceof Error ? error.message : String(error) };
}

/**
 * 把 invoke handler 收敛成失败契约：成功 → { ok: true, value }，抛错 → 失败 envelope。
 * 所有 invoke 成员都经这里注册，是「不允许绕过」的唯一收口。
 */
function wrapInvokeHandler(
	handler: IpcHandlerFn,
): (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcInvokeEnvelope> {
	// 模块侧签名已由 IpcHandlerMap 编译期校验；这里只做 electron 监听器边界的形状适配
	const invoke = handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
	return async (event, ...args) => {
		try {
			return { ok: true, value: await invoke(event, ...args) };
		} catch (error) {
			return toInvokeFailure(error);
		}
	};
}

export function registerIpcHandlers(...maps: IpcHandlerMaps[]): void {
	const merged: IpcHandlerMaps = {};
	for (const map of maps) {
		for (const [namespace, members] of Object.entries(map)) {
			merged[namespace] = { ...(merged[namespace] ?? {}), ...members };
		}
	}

	const table = ipcTable as Record<string, Record<string, IpcOpEntry>>;
	for (const [namespace, map] of Object.entries(merged)) {
		for (const [member, handler] of Object.entries(map)) {
			const entry = table[namespace]?.[member];
			if (!entry?.channel) {
				throw new Error(`IPC 通道表缺失条目: ${namespace}.${member}`);
			}
			if (entry.kind === "send" || entry.kind === "sendSync") {
				// send 系不走失败契约：单向通知/sendSync 没有 Promise 承载 envelope，形状与历史一致。
				ipcMain.on(entry.channel, handler as (event: IpcMainEvent, ...args: unknown[]) => void);
			} else {
				ipcMain.handle(entry.channel, wrapInvokeHandler(handler));
			}
		}
	}
}
