/**
 * QuickGenProcess —— 持久化轻量 pi RPC 进程，用于快速文本生成（如 commit message）。
 *
 * 之前这部分逻辑内联在 index.ts 中，由 4 个 module-level let（genProcess / genRpcClient /
 * genProcessCwd / genIdleTimer）+ ensureGenProcess + quickGenerate + stopGenProcess +
 * resetGenIdleTimer 构成。此处抽成独立模块：
 * - 状态封装在实例字段中，不再污染 index.ts 顶层
 * - 接口收窄为 generate() + stop()，调用方不再需要知道 idle timer / RPC client 细节
 * - 跨项目复用同一进程，30 分钟空闲自动退出释放内存
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { AppSettings } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "./PiLocator";
import { PiRpcClient } from "./PiRpcClient";

/** QuickGen 依赖：通过依赖注入避免直接耦合全局单例。 */
export interface QuickGenProcessDeps {
	locator: PiLocator;
	getSettings: () => AppSettings;
	appLogger: AppLogger;
}

/**
 * 持久化轻量 pi RPC 进程管理器。
 * 跨项目复用同一进程，30 分钟空闲自动退出释放内存。
 */
export class QuickGenProcess {
	private process: ChildProcess | null = null;
	private rpcClient: PiRpcClient | null = null;
	private cwd = "";
	private idleTimer: NodeJS.Timeout | null = null;

	constructor(private readonly deps: QuickGenProcessDeps) {}

	/**
	 * 通过持久化的 RPC 进程快速生成文本。
	 * 已有进程还在运行时直接复用（跨项目也复用），否则按当前设置拉起新进程。
	 */
	async generate(projectPath: string, prompt: string): Promise<string> {
		const { locator, getSettings, appLogger } = this.deps;
		const settings = getSettings();
		const command = locator.resolveCommand(
			settings.customPiPath,
			settings.wslEnabled,
			settings.wslDistro,
			settings.wslUser,
		);

		const rpc = await this.ensureProcess(projectPath, command);

		return new Promise<string>((resolve, reject) => {
			const collected: string[] = [];
			let settled = false;
			const timeout = setTimeout(() => {
				if (!settled) {
					void appLogger.warn("git", "QuickGen timed out", {
						collected: collected.join("").slice(0, 200),
					});
					reject(new Error("Quick generate timed out"));
				}
			}, 60_000);

			const onEvent = (event: Record<string, unknown>) => {
				const eventType = event.type as string;
				if (eventType === "message_update") {
					const ae = (event as Record<string, unknown>).assistantMessageEvent as
						| Record<string, unknown>
						| undefined;
					if (ae?.type === "text_delta" && typeof ae.delta === "string") {
						collected.push(ae.delta);
					}
				}
				if (eventType === "agent_settled" || eventType === "agent_end") {
					settled = true;
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					const text = collected.join("");
					void appLogger.warn("git", "QuickGen completed", { length: text.length });
					resolve(text);
				}
			};

			rpc.on("event", onEvent);

			rpc.request({ type: "prompt", message: prompt }).then((response) => {
				if (!response.success) {
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					reject(new Error(response.error ?? "Prompt rejected"));
				}
			}).catch((err) => {
				clearTimeout(timeout);
				rpc.off("event", onEvent);
				reject(err);
			});
		});
	}

	/** 应用退出时调用，杀掉进程并清理 RPC client / 定时器。 */
	stop(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.rpcClient?.close();
		this.rpcClient = null;
		if (this.process && this.process.exitCode === null) {
			try {
				this.process.kill();
			} catch {
				/* ignore */
			}
		}
		this.process = null;
		this.cwd = "";
	}

	/**
	 * 确保持久化进程可用；已存活则复用，已死亡则重建。
	 * 返回当前 RPC client 供调用方挂事件监听。
	 */
	private async ensureProcess(projectPath: string, command: string): Promise<PiRpcClient> {
		const { locator, getSettings, appLogger } = this.deps;

		// 已有进程还活着：直接复用（跨项目也复用），重置空闲定时器
		if (this.process && this.rpcClient && this.process.exitCode === null) {
			this.cwd = projectPath;
			this.resetIdleTimer();
			return this.rpcClient;
		}

		// 旧进程已死：先清理再重建
		if (this.process) {
			this.stop();
		}

		const settings = getSettings();
		const invocation = locator.createInvocation(command, [
			"--mode", "rpc",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-themes",
			"--thinking", "off",
		]);

		this.process = spawn(invocation.command, invocation.args, {
			cwd: projectPath,
			env: locator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
			stdio: ["pipe", "pipe", "pipe"],
			shell: invocation.shell,
			windowsHide: true,
			windowsVerbatimArguments: invocation.windowsVerbatimArguments,
		});
		this.cwd = projectPath;

		this.rpcClient = new PiRpcClient(this.process.stdin!, this.process.stdout!);

		// stderr 仅用于调试日志
		this.process.stderr!.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").slice(0, 300);
			void appLogger.warn("git", "QuickGen stderr", text);
		});

		// 进程退出时清理状态
		this.process.on("exit", (code, signal) => {
			void appLogger.warn("git", "QuickGen process exited", { code, signal });
			this.stop();
		});

		this.process.on("error", (err) => {
			void appLogger.error("git", "QuickGen process error", err.message);
		});

		this.resetIdleTimer();
		return this.rpcClient;
	}

	/** 重置空闲定时器：30 分钟无请求自动杀掉进程释放内存。 */
	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			void this.deps.appLogger.debug("git", "QuickGen idle timeout, killing process");
			this.stop();
		}, 30 * 60 * 1000);
		if (this.idleTimer && typeof this.idleTimer === "object") {
			this.idleTimer.unref?.();
		}
	}
}
