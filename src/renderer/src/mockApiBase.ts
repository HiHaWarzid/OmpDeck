import type { PiDesktopApi } from "../../shared/api";
import { ipcTable, type IpcOpEntry } from "../../shared/ipc";

/**
 * 由通道表派生的假实现基座：每个非 override 成员生成默认实现。
 * - invoke/send/sendSync：`async () => undefined`（契约返回 void 的成员可直接用；
 *   返回具体值的成员必须由覆盖层提供罐头数据，防止 UI 显示 NaN/undefined）
 * - subscribe：`() => () => undefined`（无监听、无推送）
 * - override 成员不生成（webUtils / 环境标志 / sendSync / fire-and-forget，由覆盖层提供）
 *
 * 表与 PiDesktopApi 的成员一致性由 `ipcTable satisfies IpcTable` 编译期保证，
 * 因此这里只需一次收敛性断言；具体成员签名由 PiDesktopApi 持有。
 * previewApi / browserApi 用「基座 + 罐头数据覆盖层」组合，任何表变更都会
 * 在覆盖层漏成员时以 undefined 暴露（配合 parity 测试防漂移）。
 */
export function createMockApiBase(): PiDesktopApi {
	const api: Record<string, Record<string, unknown>> = {};
	for (const [namespace, members] of Object.entries(ipcTable)) {
		const built: Record<string, unknown> = {};
		for (const [member, entry] of Object.entries(members)) {
			const op = entry as IpcOpEntry;
			if (op.override) continue;
			if (op.kind === "subscribe") {
				built[member] = () => () => undefined;
			} else {
				built[member] = async () => undefined;
			}
		}
		api[namespace] = built;
	}
	return api as unknown as PiDesktopApi;
}
