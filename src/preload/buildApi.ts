import type { PiDesktopApi } from "../shared/api";
import { ipcTable, type IpcOpEntry } from "../shared/ipc";
import { unwrapIpcInvokeEnvelope, type IpcInvokeEnvelope } from "../shared/ipcEnvelope";

/**
 * IPC bridge 抽象：把 ipcRenderer 的调用面收窄为 buildApi 需要的五个操作，
 * 便于在 vitest（node 环境）里注入假 bridge 测试生成逻辑，而不必引入 electron。
 */
export interface IpcBridge {
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	send(channel: string, ...args: unknown[]): void;
	sendSync(channel: string, ...args: unknown[]): unknown;
	/** 监听主进程推送；listener 收到 (event, payload)（与 ipcRenderer.on 一致）。 */
	on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
	removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

/**
 * 由通道表生成 window.piDesktop 的 api 对象。
 *
 * - invoke：`(...args) => unwrap(bridge.invoke(channel, ...pack(args)))`，pack 缺省原样展开；
 *   解包失败契约 envelope（成功取 value、失败抛带 kind 的错误，见 shared/ipcEnvelope）
 * - subscribe：注册 listener 并返回解除订阅函数（与历史 subscribe helper 语义一致）
 * - send / sendSync：单向通知 / 同步读取
 * - local：不生成——由 preload 覆盖层提供实现（webUtils、环境标志、fire-and-forget 等）
 *
 * 表通过 `satisfies IpcTable` 与 PiDesktopApi 成员一一对应（编译期校验），
 * 因此这里只需一次收敛性断言；具体成员签名由 PiDesktopApi 持有。
 */
export function buildApi(bridge: IpcBridge): PiDesktopApi {
	const api: Record<string, Record<string, unknown>> = {};
	for (const [namespace, members] of Object.entries(ipcTable)) {
		const built: Record<string, unknown> = {};
		for (const [member, entry] of Object.entries(members)) {
			const op = entry as IpcOpEntry;
			// override 成员（webUtils、环境标志、sendSync 同步读取、fire-and-forget）由 preload 覆盖层提供
			if (op.kind === "local" || op.override) continue;
			if (op.kind === "subscribe") {
				built[member] = (callback: (payload: unknown) => void) => {
					const listener = (_event: unknown, payload: unknown) => callback(payload);
					bridge.on(op.channel ?? "", listener);
					return () => bridge.removeListener(op.channel ?? "", listener);
				};
				continue;
			}
			if (op.kind === "send") {
				built[member] = (...args: unknown[]) => bridge.send(op.channel ?? "", ...args);
				continue;
			}
			if (op.kind === "sendSync") {
				built[member] = (...args: unknown[]) => bridge.sendSync(op.channel ?? "", ...args);
				continue;
			}
			// invoke：过界的是失败契约 envelope（见 shared/ipcEnvelope），这里解包成历史形状——
			// 成功直接给 value，失败抛 IpcInvokeError（保留 try/catch 语义与干净 message）
			built[member] = async (...args: unknown[]) => {
				const packed = op.pack ? op.pack(...args) : args;
				const envelope = (await bridge.invoke(op.channel ?? "", ...packed)) as IpcInvokeEnvelope;
				return unwrapIpcInvokeEnvelope(envelope);
			};
		}
		api[namespace] = built;
	}
	// 表与 PiDesktopApi 的成员一致性已由 `ipcTable satisfies IpcTable` 在编译期保证，
	// 生成对象的运行时形状与之完全对齐，此处收敛断言不携带额外信息。
	return api as unknown as PiDesktopApi;
}
