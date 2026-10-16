/**
 * pi RPC 命令名兼容层（跨 pi 版本）。
 *
 * 背景：pi 18.10.x 把三条命令改名，旧名在新版只回一条
 * `success:false` / `error: "Unknown command: xxx"` 的失败响应：
 *   - get_commands      → get_available_commands
 *   - clone             → fork（不带 entryId = 分叉整个会话）
 *   - get_fork_messages → get_branch_messages
 *
 * 桌面端不能按 pi 版本号硬编码（用户可自装任意 pi，WSL 里还可能同时存在多份），
 * 因此按「新名优先、旧名兜底」探测：只有明确是 Unknown command 才降级到旧名，
 * 超时/连接断开等真实错误直接向上抛，避免把失败伪装成旧版 pi。
 *
 * 探测结果按 PiRpcClient 缓存：命令名在同一个 pi 进程生命周期内不会变，缓存后
 * 不再白跑注定失败的请求（旧实现每次打开「/」命令面板、每条 /xxx 消息都发一次
 * 旧命令，实测一天日志里 300+ 条 "Unknown command"）。
 */
import type { PiRpcClient, RpcResponse } from "./PiRpcClient";

/** 新命令名 → 旧 pi 只认的名字（按新名优先探测）。 */
const LEGACY_COMMAND_NAMES: Record<string, string> = {
	get_available_commands: "get_commands",
	fork: "clone",
	get_branch_messages: "get_fork_messages",
};

/** 每个 pi 进程已探测出的「主命令名」缓存。 */
const resolvedCommandNames = new WeakMap<PiRpcClient, Map<string, string>>();

/**
 * 失败响应的类别。调用方需要按类别分支：
 *   - unknown-command：命令名与此 pi 版本不兼容（本模块负责换名重试）；
 *   - transport-limit：响应体超过 RPC 传输上限（大会话的 get_messages/get_entries 会命中），
 *     必须走会话文件直读兜底，绝不能把 `data === undefined` 当「会话为空」；
 *   - other：其余真实错误（参数错误、会话忙、provider 报错等），照原样上报。
 */
export type PiFailureKind = "unknown-command" | "transport-limit" | "other";

export function classifyPiFailure(response: RpcResponse | undefined): PiFailureKind {
	const error = response?.error ?? "";
	if (/unknown command/i.test(error)) return "unknown-command";
	if (/transport limit/i.test(error)) return "transport-limit";
	return "other";
}

/**
 * 按「新名优先、旧名兜底」发一条命令，返回真正生效的命令名与响应。
 * 所有候选名都被判定为 Unknown command 时返回最后一次失败响应（由调用方决定兜底）。
 */
export async function requestPiCommand(
	client: PiRpcClient,
	type: string,
	options: { params?: Record<string, unknown>; timeoutMs?: number } = {},
): Promise<{ response: RpcResponse; command: string }> {
	const legacy = LEGACY_COMMAND_NAMES[type];
	const cache = resolvedCommandNames.get(client);
	const cached = cache?.get(type);
	const candidates = cached ? [cached] : legacy ? [type, legacy] : [type];

	let last: { response: RpcResponse; command: string } | undefined;
	for (const command of candidates) {
		const response = await client.request({ type: command, ...options.params }, options.timeoutMs);
		if (response.success) {
			if (cache) cache.set(type, command);
			else resolvedCommandNames.set(client, new Map([[type, command]]));
			return { response, command };
		}
		last = { response, command };
		// 非「未知命令」的失败（参数错误、超时后的错误响应等）与命令名无关，不再试旧名。
		if (classifyPiFailure(response) !== "unknown-command") break;
	}
	return last ?? { response: { type: "response", command: type, success: false, error: "no candidate command" }, command: type };
}
