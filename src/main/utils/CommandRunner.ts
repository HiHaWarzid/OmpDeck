import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * git/gh 五个 CLI 执行约定的收敛 seam：超时、maxBuffer、stderr 归一化、allowFailure、
 * ENOENT 归类、cwd 全部收敛到这里，调用方只描述"跑什么"，不重复写执行细节。
 *
 * 语义对齐依据（Wave-3 换入前保持一致）：
 * - GitService.runGit：默认超时 30s、缓冲 32MB；blocking 变体用 4 倍超时覆盖；
 * - AfkOrchestrator.runGit：同上（GIT_TIMEOUT_MS=30s、缓冲硬编码 32MB）；
 * - WorktreeService：裸 execFileAsync，无超时、无缓冲覆盖、无 stderr 归一化；
 * - ticketSources.runGh：默认超时 30s（GH_TIMEOUT_MS）、缓冲 16MB、ENOENT 单独归类给安装指引；
 * - ExtensionManager.runNpm/runPi：带 wsl/shell/env 定位（本 seam 只透传 env，
 *   不复制 PiLocator 的 wsl 路径定位逻辑——那是 ExtensionManager 自己的职责面）。
 */

export type CommandErrorKind = "command" | "timeout" | "not-found";

/**
 * 归一化后的命令错误：
 * - kind "command"：进程有输出地失败（message 已并入 stderr，code 为退出码）；
 * - kind "timeout"：超时被杀（node execFile 超时错误 killed=true、code=null）；
 * - kind "not-found"：ENOENT（二进制不在 PATH），message 附带可执行的安装指引。
 */
export class CommandError extends Error {
	readonly kind: CommandErrorKind;
	/** 进程退出码；timeout/ENOENT 时无退出码，为 undefined */
	readonly code: number | undefined;

	constructor(kind: CommandErrorKind, message: string, code?: number) {
		super(message);
		this.name = "CommandError";
		this.kind = kind;
		this.code = code;
	}
}

/** 命令成功输出（对齐 node execFile 的 stdout 语义，调用方自行 trim/解析） */
export type CommandOutput = {
	stdout: string;
};

/** 底层执行器注入点（默认 node execFileAsync；测试注入 fake 验证超时 kill/选项透传语义） */
export type Executor = (
	bin: string,
	args: string[],
	options: ExecutorOptions,
) => Promise<CommandOutput>;

/** 透传给底层执行器的选项（字段名与 node execFile 对齐，timeout 单位毫秒） */
export type ExecutorOptions = {
	cwd?: string;
	timeout?: number;
	maxBuffer?: number;
	env?: NodeJS.ProcessEnv;
};

export type RunCommandOptions = {
	/** 工作目录 */
	cwd?: string;
	/** 超时毫秒；超时由执行器负责 kill 子进程（默认 executor 即 node execFile 原生行为） */
	timeoutMs?: number;
	/** 输出缓冲上限（runGit/runGh 提供默认值：32MB / 16MB） */
	maxBuffer?: number;
	/** 失败返回空 stdout 而非抛错（探测型命令，调用方自行降级，对齐 GitService allowFailure 语义） */
	allowFailure?: boolean;
	/** 透传环境变量（Electron 启动环境常缺用户 shell PATH，ExtensionManager 为此补 PATH） */
	env?: NodeJS.ProcessEnv;
};

export type CommandRunner = {
	runCommand: (bin: string, args: string[], options?: RunCommandOptions) => Promise<CommandOutput>;
	/** git 便捷封装：cwd 必填位置参数、返回 stdout 字符串（对齐 GitService/AfkOrchestrator 的 runGit 签名） */
	runGit: (cwd: string, args: string[], options?: RunCommandOptions) => Promise<string>;
	/** gh 便捷封装：对齐 ticketSources.runGh 签名 */
	runGh: (cwd: string, args: string[], options?: RunCommandOptions) => Promise<string>;
};

export type CommandRunnerDeps = {
	exec: Executor;
};

/** git 本地命令默认超时（对齐 GIT_MUTATION_TIMEOUT_MS / GIT_TIMEOUT_MS） */
const GIT_TIMEOUT_MS = 30_000;
/** git 输出缓冲上限（两个 git 约定都用 32MB，覆盖大 log/status/ref 输出） */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
/** gh 网络操作默认超时（对齐 ticketSources GH_TIMEOUT_MS，createPr 等大调用自行覆盖加长） */
const GH_TIMEOUT_MS = 30_000;
/** gh 输出缓冲上限（对齐 ticketSources 16MB） */
const GH_MAX_BUFFER = 16 * 1024 * 1024;

const defaultExecutor: Executor = (bin, args, options) => execFileAsync(bin, args, options);

function toCommandError(
	bin: string,
	args: string[],
	timeoutMs: number | undefined,
	error: unknown,
): CommandError {
	// execFile 的 error.message 不含 stderr，而失败原因在 stderr（checkout 冲突/push 认证拒绝）；
	// stderr 字段未被 node 类型暴露，具名 const 收窄读取。
	const execError = error as { stderr?: string; code?: unknown; killed?: boolean };
	const detail = execError.stderr?.trim() || (error instanceof Error ? error.message : String(error));
	const commandName = `${bin} ${args[0] ?? "command"}`;

	if (execError.code === "ENOENT") {
		// ENOENT 时 message 只有 "spawn git ENOENT"，对用户不可行；改成带安装指引的错误。
		return new CommandError("not-found", `${commandName} failed: ${detail}，请检查 PATH 或是否安装 ${bin}`);
	}
	// node execFile 超时：子进程被 kill，错误对象 killed=true 且 code=null
	// （个别包装层用 ETIMEDOUT 标识），统一归一为独立 kind 便于调用方区分处理。
	if (execError.killed === true || execError.code === "ETIMEDOUT") {
		return new CommandError("timeout", `${commandName} timed out after ${timeoutMs ?? "?"}ms: ${detail}`);
	}
	return new CommandError(
		"command",
		`${commandName} failed: ${detail}`,
		typeof execError.code === "number" ? execError.code : undefined,
	);
}

/**
 * 创建命令执行器。deps.exec 注入底层执行（默认 node execFileAsync）；
 * 测试注入 fake 即可完整覆盖超时/缓冲/归一化语义，不触碰真实二进制。
 */
export function createCommandRunner(deps: Partial<CommandRunnerDeps> = {}): CommandRunner {
	const exec = deps.exec ?? defaultExecutor;

	const runCommand = async (
		bin: string,
		args: string[],
		options: RunCommandOptions = {},
	): Promise<CommandOutput> => {
		try {
			const { stdout } = await exec(bin, args, {
				cwd: options.cwd,
				timeout: options.timeoutMs,
				maxBuffer: options.maxBuffer,
				env: options.env,
			});
			return { stdout };
		} catch (error) {
			// allowFailure 语义与既有约定一致：任何失败（含 timeout/ENOENT）都降级为空输出。
			if (options.allowFailure) return { stdout: "" };
			throw toCommandError(bin, args, options.timeoutMs, error);
		}
	};

	return {
		runCommand,
		runGit: async (cwd, args, options = {}) => {
			const { stdout } = await runCommand("git", args, {
				...options,
				cwd,
				timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
				maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
			});
			return stdout;
		},
		runGh: async (cwd, args, options = {}) => {
			const { stdout } = await runCommand("gh", args, {
				...options,
				cwd,
				timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
				maxBuffer: options.maxBuffer ?? GH_MAX_BUFFER,
			});
			return stdout;
		},
	};
}

/** 默认 executor（node child_process.execFile）的模块级单例，供调用方直接使用。 */
const defaultRunner = createCommandRunner();

export const runCommand = defaultRunner.runCommand;
export const runGit = defaultRunner.runGit;
export const runGh = defaultRunner.runGh;