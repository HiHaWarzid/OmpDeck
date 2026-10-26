import type { PiCommand, PiCommandSubcommand } from "./types/agent";

/**
 * 把 omp 的斜线命令目录归一化为桌面契约 `PiCommand[]`。
 *
 * omp 线上形状（`get_available_commands` 与 `available_commands_update` 同构）：
 * `{ name, description?, source?, aliases?, input?: { hint }, subcommands?: [{ name, description? }] }`。
 * `input.hint` 是嵌套对象，渲染层只需要字符串，故在这里一次性摊平成 `inputHint`；
 * 归一化集中在本模块，主进程拉取（invoke）和推送（subscribe）走同一份实现，
 * 避免两条路径对同一份数据给出不同形状。
 *
 * 容错策略：非数组 → 空列表；缺 `name` 或名字不是非空字符串的条目丢弃。
 * 去重与可见性属于渲染层策略（`filterVisibleCommands`），这里原样保序——
 * 若在这里按名字去重，builtin 排在扩展之前时会先占位，扩展同名命令在渲染层
 * 被隐藏后仍丢失，用户可执行的命令凭空消失。
 */
export function normalizePiCommands(input: unknown): PiCommand[] {
	if (!Array.isArray(input)) return [];
	const commands: PiCommand[] = [];
	for (const raw of input) {
		if (!raw || typeof raw !== "object") continue;
		const source = raw as Record<string, unknown>;
		const name = typeof source.name === "string" ? source.name.trim() : "";
		if (!name) continue;

		const command: PiCommand = { name };
		if (typeof source.description === "string") command.description = source.description;
		if (typeof source.source === "string") command.source = source.source;

		const inputMeta = source.input;
		if (inputMeta && typeof inputMeta === "object") {
			const hint = (inputMeta as Record<string, unknown>).hint;
			if (typeof hint === "string" && hint.trim()) command.inputHint = hint.trim();
		}

		const subcommands = normalizeSubcommands(source.subcommands);
		if (subcommands.length > 0) command.subcommands = subcommands;

		commands.push(command);
	}
	return commands;
}

function normalizeSubcommands(input: unknown): PiCommandSubcommand[] {
	if (!Array.isArray(input)) return [];
	const subcommands: PiCommandSubcommand[] = [];
	for (const raw of input) {
		if (!raw || typeof raw !== "object") continue;
		const source = raw as Record<string, unknown>;
		const name = typeof source.name === "string" ? source.name.trim() : "";
		if (!name) continue;
		const subcommand: PiCommandSubcommand = { name };
		if (typeof source.description === "string") subcommand.description = source.description;
		subcommands.push(subcommand);
	}
	return subcommands;
}
