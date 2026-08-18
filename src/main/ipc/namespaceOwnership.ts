/**
 * IPC 命名空间 → 宿主模块 所有权声明。
 *
 * 单一事实源：每个命名空间的成员「可以」由哪些模块注册。ipcParity.test.ts 据此
 * 校验所有已注册成员的主模块都在声明之列——新表成员加错模块会在 CI 直接失败，
 * 不再需要靠跨文件 grep 才知道某个命名空间散落在哪几个模块。
 *
 * 约定：模块标识 = handler 文件 stem（registerIpc.ts 的 import 后缀），
 * pet 用 "pet"（PetSystem.handlerMaps），perf 用 "preload"（overlay 层实现）。
 *
 * 未来收拢方向：物理迁回 primary 之后从对应数组里删掉次要宿主即可（见各拆分注释）。
 */
import type { PiDesktopApi } from "../../shared/api";

export type Namespace = keyof PiDesktopApi;

export const NAMESPACE_OWNERS: Record<Namespace, readonly string[]> = {
	editors: ["editorHandlers"],
	// 拆分：projectHandlers 为主宿主；piHandlers 残留 projects.listModels（pi-extraction
	// 批次遗留：模型列表查询复用了 pi 进程，物理上留在 piHandlers）。后续应迁回 projectHandlers。
	projects: ["projectHandlers", "piHandlers"],
	projectResources: ["projectHandlers"],
	// 拆分：fileHandlers 为主宿主；clipboardHandlers 注册 files.getClipboardPaths
	// （sendSync 同步读剪贴板路径，与剪贴板实现同模块）。后续迁回 fileHandlers。
	files: ["fileHandlers", "clipboardHandlers"],
	sessions: ["sessionHandlers"],
	codexSessions: ["sessionHandlers"],
	claudeSessions: ["sessionHandlers"],
	openCodeSessions: ["sessionHandlers"],
	git: ["gitHandlers"],
	pi: ["piHandlers"],
	wsl: ["piHandlers"],
	logs: ["logHandlers"],
	// 拆分：logHandlers 为主宿主（getSize/get/clear/openFile）；appHandlers 注册
	// setLogging/getLogging（开关依赖 agentManager 注入，物理上在 app 块）。
	rpcLogs: ["logHandlers", "appHandlers"],
	// 拆分：appHandlers 为主宿主；logHandlers 注册 app.rendererLog（渲染层日志转发，
	// 与日志设施同模块）。
	app: ["appHandlers", "logHandlers"],
	skills: ["skillHandlers"],
	prompts: ["promptHandlers"],
	promptStore: ["storeHandlers"],
	skillStore: ["storeHandlers"],
	skillHub: ["storeHandlers"],
	yaoPrompts: ["storeHandlers"],
	extensions: ["extensionHandlers"],
	settings: ["appHandlers"],
	config: ["configHandlers"],
	// 拆分：agentHandlers 为主宿主；configHandlers 注册 agents.respondTrustRequest
	// （项目信任确认的回传，物理上在 config 块，逻辑属于 agents 流程）。
	agents: ["agentHandlers", "configHandlers"],
	// PetSystem.handlerMaps（src/main/pet/index.ts），非独立 handler 模块文件。
	pet: ["pet"],
	terminal: ["terminalHandlers"],
	feishu: ["feishuHandlers"],
	dialog: ["projectHandlers"],
	clipboard: ["clipboardHandlers"],
	// local/override 条目，实现走 preload 覆盖层（PIDECK_PERF=1），无 handler 注册。
	perf: ["preload"],
	scratchPad: ["scratchPadHandlers"],
	afk: ["afkHandlers"],
};

export interface RegisteredNamespace {
	namespace: string;
	module: string;
}

/** 校验每个已注册成员的主模块都被声明为其命名空间的所有者。返回违规描述列表（空 = 全部通过）。 */
export function assertNamespaceOwnership(registered: readonly RegisteredNamespace[]): string[] {
	const violations: string[] = [];
	for (const { namespace, module } of registered) {
		const owners = NAMESPACE_OWNERS[namespace as Namespace];
		if (!owners || owners.length === 0) {
			violations.push(
				`命名空间 ${namespace} 未声明任何所有者：请在 NAMESPACE_OWNERS 中登记（成员由 ${module} 注册）`,
			);
		} else if (!owners.includes(module)) {
			violations.push(
				`命名空间 ${namespace} 的成员由 ${module} 注册，但声明所有者仅 [${owners.join(", ")}]——` +
					`新成员只能加到已声明的宿主模块，或先更新 NAMESPACE_OWNERS`,
			);
		}
	}
	return violations;
}

/** 返回表中没有声明所有者的命名空间列表（空 = 全部有主）。 */
export function missingNamespaceOwners(tableNamespaces: readonly string[]): string[] {
	return tableNamespaces.filter((ns) => {
		const owners = NAMESPACE_OWNERS[ns as Namespace];
		return !owners || owners.length === 0;
	});
}