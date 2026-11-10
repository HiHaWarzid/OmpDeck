import { existsSync } from "node:fs";
import type { RemoteAccessErrorCode, RemoteAccessStatus } from "../../shared/types";
import { CommandError, type CommandRunner } from "../utils/CommandRunner";

/** Serve 默认使用 8443，避免覆盖用户可能已经占用的 443。 */
export const DEFAULT_REMOTE_ACCESS_HTTPS_PORT = 8443;
const COMMAND_TIMEOUT_MS = 15_000;
/**
 * 首次 `serve --bg` 可能触发 tailnet 证书签发；实测 TLS 证书申请约 40s，
 * 15s 会把已启用 HTTPS 的正常首次配置误判成超时。
 */
const SERVE_CONFIGURE_TIMEOUT_MS = 90_000;

type RemoteAccessLogger = {
	info: (scope: string, message: string, detail?: unknown) => unknown;
	warn: (scope: string, message: string, detail?: unknown) => unknown;
};

export type RemoteAccessManagerDeps = {
	runCommand: CommandRunner["runCommand"];
	/** 当前 Web 服务实际监听端口；0 表示未启动 */
	getWebPort: () => number;
	/** Web 服务是否真的在监听；远程访问只允许指向活着的回环服务 */
	isWebRunning: () => boolean;
	exists?: (path: string) => boolean;
	platform?: NodeJS.Platform;
	binaryCandidates?: string[];
	httpsPort?: number;
	logger?: RemoteAccessLogger;
};

/** 带稳定分类的远程访问错误；设置层据此回滚开关并显示对应文案。 */
export class RemoteAccessError extends Error {
	constructor(
		readonly code: RemoteAccessErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RemoteAccessError";
	}
}

type TailscaleStatusJson = {
	BackendState?: unknown;
	Self?: { DNSName?: unknown } | null;
};

function platformBinaryCandidates(platform: NodeJS.Platform): string[] {
	if (platform === "win32") {
		return [
			"C:\\Program Files\\Tailscale\\tailscale.exe",
			"C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
		];
	}
	if (platform === "darwin") {
		return [
			"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
			"/opt/homebrew/bin/tailscale",
			"/usr/local/bin/tailscale",
		];
	}
	return ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];
}

function parseTailscaleStatus(raw: string): { backendState: string; dnsName: string } {
	let parsed: TailscaleStatusJson;
	try {
		parsed = JSON.parse(raw) as TailscaleStatusJson;
	} catch {
		throw new RemoteAccessError("start-failed", "Tailscale 返回了无法解析的状态 JSON");
	}
	const backendState = typeof parsed.BackendState === "string" ? parsed.BackendState : "";
	const rawDnsName = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName : "";
	return { backendState, dnsName: rawDnsName.replace(/\.$/, "") };
}

/** 判断 serve status JSON 中是否已经出现该 HTTPS 端口（键或字符串均可）。 */
function serveStatusMentionsPort(raw: string, port: number): boolean {
	return new RegExp(`(^|[^0-9])${port}([^0-9]|$)`).test(raw);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Tailscale Serve 远程访问编排。
 *
 * 只负责配置/撤销 Serve 转发，不启动第二个 HTTP 服务。所有命令都用参数数组
 * 交给 execFile 语义的 runCommand，避免把端口拼进 shell 字符串。
 */
export class RemoteAccessManager {
	private state: RemoteAccessStatus["state"] = "off";
	private enabled = false;
	private installed = false;
	private loggedIn = false;
	private hostname: string | null = null;
	private url: string | null = null;
	private binaryPath: string | null = null;
	private errorCode: RemoteAccessErrorCode | null = null;
	private error: string | null = null;
	/** 本进程是否创建过 Serve 配置；用于 stop 时避免误删用户自己的同名端口配置 */
	private managed = false;
	/** 本进程最后一次成功写入 Serve 的回环目标；端口变更时用于识别自己的旧配置。 */
	private appliedTarget: string | null = null;
	/** 串行化 start/stop，避免禁用请求与 15s 的 Serve 启动命令交错。 */
	private operation: Promise<unknown> = Promise.resolve();
	private readonly httpsPort: number;
	private readonly exists: (path: string) => boolean;

	constructor(private readonly deps: RemoteAccessManagerDeps) {
		this.httpsPort = deps.httpsPort ?? DEFAULT_REMOTE_ACCESS_HTTPS_PORT;
		this.exists = deps.exists ?? existsSync;
	}

	getStatus(): RemoteAccessStatus {
		return {
			enabled: this.enabled,
			state: this.state,
			provider: "tailscale",
			installed: this.installed,
			loggedIn: this.loggedIn,
			url: this.url,
			hostname: this.hostname,
			httpsPort: this.httpsPort,
			binaryPath: this.binaryPath,
			errorCode: this.errorCode,
			error: this.error,
		};
	}

	/**
	 * 应用设置。启用时先确认 Web 服务活着，再启动 Serve；关闭时撤销本进程
	 * 创建或明确指向 OmpDeck 的 Serve 处理器。
	 */
	async applySettings(settings: {
		remoteAccessEnabled?: boolean;
		webServiceEnabled: boolean;
	}): Promise<RemoteAccessStatus> {
		if (settings.remoteAccessEnabled !== true) {
			// 即使设置是关闭态也要探测一次：上次退出/关闭失败可能留下指向本机端口的
			// Serve 规则，不能因为进程内 managed=false 就让它继续暴露服务。
			this.enabled = false;
			return this.stop();
		}
		this.enabled = true;
		if (!settings.webServiceEnabled || !this.deps.isWebRunning()) {
			throw this.fail("web-service-off", "Web 服务未运行，无法开启远程访问");
		}
		return this.start();
	}

	/** 启动/重新配置 Serve。队列保证「关→开」最终以开结束。 */
	async start(): Promise<RemoteAccessStatus> {
		return this.enqueue(() => this.doStart());
	}

	/** 所有 start/stop 共享一条队列，后到的禁用一定在启动命令结束后执行。 */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.operation.then(task, task);
		this.operation = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async doStart(): Promise<RemoteAccessStatus> {
		// 连续 start 入队时第二次通常已无工作可做；只有端口变化或上次失败才需要重跑 CLI。
		if (this.state === "running" && this.appliedTarget === this.serveTarget() && !this.error) {
			this.enabled = true;
			return this.getStatus();
		}
		this.enabled = true;
		this.state = "starting";
		this.errorCode = null;
		this.error = null;
		try {
			if (!this.deps.isWebRunning() || this.deps.getWebPort() <= 0) {
				throw new RemoteAccessError("web-service-off", "Web 服务未运行，无法开启远程访问");
			}
			const binary = this.resolveBinary();
			this.binaryPath = binary;
			this.installed = true;

			const status = await this.runStatus(binary);
			this.hostname = status.dnsName || null;
			this.loggedIn = status.backendState === "Running";
			if (!this.loggedIn) {
				throw new RemoteAccessError(
					"not-logged-in",
					`Tailscale 未登录或未连接（BackendState=${status.backendState || "unknown"}）`,
				);
			}
			if (!status.dnsName) {
				throw new RemoteAccessError("start-failed", "Tailscale 未返回 DNS 名称，无法生成远程地址");
			}

			const target = this.serveTarget();
			const serveStatus = await this.runServeStatus(binary);
			// 端口变更后 Serve 仍指向本进程上一次写入的回环目标；这不是“其他服务占用”，
			// 应允许用新端口覆盖。只有目标看起来不是本机回环服务时才判定冲突。
			const ownsExistingHandler =
				this.managed &&
				(this.appliedTarget
					? serveStatus.includes(this.appliedTarget)
					: serveStatus.includes("http://127.0.0.1:"));
			if (
				serveStatus.trim() &&
				serveStatusMentionsPort(serveStatus, this.httpsPort) &&
				!serveStatus.includes(target) &&
				!ownsExistingHandler
			) {
				throw new RemoteAccessError(
					"port-conflict",
					`Tailscale Serve 的 ${this.httpsPort} 端口已被其他服务占用`,
				);
			}

			try {
				await this.deps.runCommand(
					binary,
					["serve", "--bg", "--yes", `--https=${this.httpsPort}`, target],
					{ timeoutMs: SERVE_CONFIGURE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
				);
			} catch (error) {
				// Tailnet 未启用 Serve/HTTPS 证书时，CLI 会打印启用链接后一直等待，
				// 只能靠超时收口；单独分类，避免用户看到含糊的 “start-failed”。
				if (error instanceof CommandError && error.kind === "timeout") {
					throw new RemoteAccessError(
						"serve-not-enabled",
						"Tailscale Serve 未启用或配置超时，请先在 Tailscale 管理后台启用 HTTPS 证书与 Serve",
					);
				}
				throw new RemoteAccessError("start-failed", errorMessage(error));
			}

			this.managed = true;
			this.appliedTarget = target;
			this.state = "running";
			this.url = `https://${status.dnsName}:${this.httpsPort}`;
			this.deps.logger?.info("remoteAccess", "Tailscale Serve started", {
				url: this.url,
				target,
			});
			return this.getStatus();
		} catch (error) {
			if (error instanceof RemoteAccessError) {
				throw this.fail(error.code, error.message);
			}
			throw this.fail("unknown", errorMessage(error));
		}
	}

	/**
	 * 撤销 Serve。只有本进程创建过配置，或当前 Serve 状态明确指向 OmpDeck
	 * 时才执行 off，避免把用户自己的 8443 配置一并清掉。
	 */
	async stop(): Promise<RemoteAccessStatus> {
		return this.enqueue(() => this.doStop());
	}

	private async doStop(): Promise<RemoteAccessStatus> {
		const shouldRemove = this.managed || (await this.serveTargetsSelf());
		this.enabled = false;
		this.state = "off";
		this.url = null;
		this.errorCode = null;
		this.error = null;
		if (!shouldRemove) {
			this.managed = false;
			this.appliedTarget = null;
			return this.getStatus();
		}
		const binary = this.binaryPath ?? this.resolveBinary();
		this.binaryPath = binary;
		try {
			await this.deps.runCommand(
				binary,
				["serve", `--https=${this.httpsPort}`, "off"],
				{ timeoutMs: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			);
			this.managed = false;
			this.appliedTarget = null;
			this.deps.logger?.info("remoteAccess", "Tailscale Serve stopped", {
				httpsPort: this.httpsPort,
			});
		} catch (error) {
			// 关闭失败时保留 managed，下一次停止/退出还会重试。必须把错误抛给设置层，
			// 否则 remoteAccessEnabled 会先落盘为 false，而 Serve 仍在转发。
			this.errorCode = "start-failed";
			this.error = `移除 Tailscale Serve 失败：${errorMessage(error)}`;
			this.state = "error";
			this.deps.logger?.warn("remoteAccess", "Failed to stop Tailscale Serve", error);
			throw new RemoteAccessError("start-failed", this.error);
		}
		return this.getStatus();
	}

	/** 退出时静默撤销，不阻塞进程结束，也不把错误抛给 Electron。 */
	async dispose(): Promise<void> {
		try {
			await this.stop();
		} catch {
			// stop 已自行记录错误
		}
	}

	private resolveBinary(): string {
		const candidates =
			this.deps.binaryCandidates ?? platformBinaryCandidates(this.deps.platform ?? process.platform);
		for (const candidate of candidates) {
			if (this.exists(candidate)) return candidate;
		}
		return "tailscale";
	}

	private serveTarget(): string {
		return `http://127.0.0.1:${this.deps.getWebPort()}`;
	}

	private async runStatus(binary: string): Promise<{ backendState: string; dnsName: string }> {
		try {
			const { stdout } = await this.deps.runCommand(binary, ["status", "--json"], {
				timeoutMs: COMMAND_TIMEOUT_MS,
				maxBuffer: 8 * 1024 * 1024,
			});
			return parseTailscaleStatus(stdout);
		} catch (error) {
			if (error instanceof CommandError && error.kind === "not-found") {
				this.installed = false;
				throw new RemoteAccessError("not-installed", "未找到 Tailscale CLI，请先安装 Tailscale");
			}
			throw new RemoteAccessError("start-failed", errorMessage(error));
		}
	}

	private async runServeStatus(binary: string): Promise<string> {
		try {
			const { stdout } = await this.deps.runCommand(binary, ["serve", "status", "--json"], {
				timeoutMs: COMMAND_TIMEOUT_MS,
				maxBuffer: 8 * 1024 * 1024,
				allowFailure: true,
			});
			return stdout;
		} catch {
			// 旧版 CLI 可能不支持 --json；无法检查冲突时仍允许启动，避免功能不可用。
			return "";
		}
	}

	private async serveTargetsSelf(): Promise<boolean> {
		// CLI 不在候选路径时仍尝试 PATH；runServeStatus 失败会返回空串，等价于“无法确认”。
		const binary = this.binaryPath ?? this.resolveBinary();
		const raw = await this.runServeStatus(binary);
		return raw.includes(this.serveTarget());
	}

	private fail(code: RemoteAccessErrorCode, message: string): RemoteAccessError {
		this.state = "error";
		// 启动失败时设置层会回滚 remoteAccessEnabled；状态里的 enabled 必须同步，
		// 否则设置页会出现「开关已关但状态仍显示已启用」的矛盾。
		this.enabled = false;
		this.errorCode = code;
		this.error = message;
		this.url = null;
		if (code === "not-installed") this.installed = false;
		this.deps.logger?.warn("remoteAccess", "Tailscale Serve start failed", {
			code,
			message,
		});
		return new RemoteAccessError(code, message);
	}
}
