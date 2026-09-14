/**
 * 更新包下载内核：把一次 HTTP 传输变成一个「一定有终态」的 Promise。
 *
 * 原实现是裸 Promise 套 electron net.request，缺五种不变式：
 * - 只有 request/output 的 error 监听，response 的 error/aborted 无人处理 → 中途断流时 Promise 永不 settle；
 * - 没有中止定时器 → 网络假死时 renderer 的下载进度永久卡住；
 * - 忽略 write() 返回的背压 → 慢盘把整个安装包缓在内存里；
 * - 没有单飞 → 双击/重试会开两条流写同一个路径，产出损坏的安装包却仍报 completed；
 * - 没有临时文件 + rename → 截断的半成品直接被 installDownloadedUpdate 打开。
 *
 * 这里把传输通道抽象成 UpdateDownloadTransport（默认实现留在 UpdateManager 里用 electron net），
 * 于是本模块不依赖 electron，可以用假传输/假写流做确定性单测（见 updateArtifact.test.ts）。
 */
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { AppUpdateAsset, AppUpdateDownloadProgress } from "../../shared/types";

// ── 常量 ──────────────────────────────────────────────

/** 整体下载超时（毫秒）。网络假死时必须有终态，否则 renderer 的进度条永远停在下载中。 */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;
/** 进度推送最小间隔（毫秒）。按时间而非按 chunk 节流，避免 100MB 安装包刷出上千次 IPC。 */
export const UPDATE_PROGRESS_INTERVAL_MS = 250;
/** 等待写流释放文件句柄的上限（毫秒）。Windows 上句柄未释放就删/替换文件会 EBUSY/EPERM。 */
const STREAM_CLOSE_TIMEOUT_MS = 2_000;

// ── 传输通道抽象 ──────────────────────────────────────

/**
 * 下载响应。Electron 的 IncomingMessage 在 .d.ts 里只声明成 EventEmitter，
 * 文档却承诺实现 Readable Stream 接口，所以 pause/resume 声明为可选：
 * 运行时存在就用来做背压，不存在也只是退化成排队。
 */
export interface UpdateDownloadResponse {
	readonly statusCode: number;
	readonly headers: Record<string, string | string[] | undefined>;
	on(event: "data", listener: (chunk: Buffer) => void): void;
	on(event: "end", listener: () => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	on(event: "aborted", listener: () => void): void;
	pause?(): void;
	resume?(): void;
}

export interface UpdateDownloadRequest {
	on(event: "response", listener: (response: UpdateDownloadResponse) => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	/** Electron 用 'abort'，Node http 用 'aborted'；合并成一个签名才能同时容纳两者。 */
	on(event: "abort" | "aborted", listener: () => void): void;
	on(
		event: "redirect",
		listener: (statusCode: number, method: string, redirectUrl: string) => void,
	): void;
	setHeader(name: string, value: string): void;
	followRedirect(): void;
	abort(): void;
	end(): void;
}

/** 由调用方提供：用什么样的客户端发请求（主进程用 electron net）。 */
export type UpdateDownloadTransport = (url: string, userAgent: string) => UpdateDownloadRequest;

/** 目标写流的最小面。fs.WriteStream 结构上满足，测试可注入假流断言背压顺序。 */
export interface UpdateArtifactWriteStream {
	write(chunk: Buffer): boolean;
	end(): void;
	destroy(): void;
	on(event: "drain", listener: () => void): void;
	on(event: "close", listener: () => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	once(event: "drain", listener: () => void): void;
	once(event: "close", listener: () => void): void;
	once(event: "error", listener: (error: Error) => void): void;
}

export interface UpdateArtifactLogger {
	debug(scope: string, message: string, detail?: unknown): unknown;
	info(scope: string, message: string, detail?: unknown): unknown;
	warn(scope: string, message: string, detail?: unknown): unknown;
}

// ── 依赖与结果 ────────────────────────────────────────

export interface UpdateArtifactDeps {
	/** 下载目录；临时文件与最终文件同目录，保证 rename 是同盘原子替换。 */
	downloadDir: string;
	transport: UpdateDownloadTransport;
	userAgent: string;
	/** 进度上报；downloading 事件已按时间节流，failed/completed 是终态且各只发一次。 */
	onProgress: (progress: AppUpdateDownloadProgress) => void;
	logger?: UpdateArtifactLogger;
	timeoutMs?: number;
	progressIntervalMs?: number;
	now?: () => number;
	openWriteStream?: (path: string) => UpdateArtifactWriteStream;
}

export interface UpdateArtifactResult {
	filePath: string;
	bytes: number;
}

// ── 纯工具 ────────────────────────────────────────────

/** 资产名 → 落盘路径：basename 防路径穿越，非法字符替换掉避免 Windows 写入失败。 */
export function resolveArtifactPath(downloadDir: string, assetName: string) {
	const safeName = basename(assetName).replace(/[<>:"/\\|?*]+/g, "-");
	return join(downloadDir, safeName);
}

// ── 下载器 ───────────────────────────────────────────

/**
 * 单个资产的下载落盘器。
 * - 单飞：同一最终路径在途时复用同一 promise；
 * - 原子落盘：先写 `<name>.part`，成功后 rename，失败清理；
 * - 终态保证：超时/断流/写失败任何一条路径都会 reject 且不留下半成品。
 */
export class UpdateArtifactDownloader {
	private readonly deps: UpdateArtifactDeps;
	/** key 是最终文件的绝对路径。 */
	private readonly inFlight = new Map<string, Promise<UpdateArtifactResult>>();
	/** 本进程内成功完成 rename 的产物；install 只认这里的路径。 */
	private readonly verified = new Set<string>();

	constructor(deps: UpdateArtifactDeps) {
		this.deps = deps;
	}

	fetchToFile(asset: AppUpdateAsset): Promise<UpdateArtifactResult> {
		const filePath = resolveArtifactPath(this.deps.downloadDir, asset.name);
		const running = this.inFlight.get(filePath);
		// 单飞：并发/重试复用同一 promise，否则两条流交错写同一个文件会产出损坏的安装包，
		// 而先完成的那一条仍会把它报成 completed。
		if (running) return running;
		const tracked = this.transfer(asset, filePath).finally(() => {
			// 先记录再注册回调，保证结束时一定释放占位（失败后允许重新下载）。
			this.inFlight.delete(filePath);
		});
		this.inFlight.set(filePath, tracked);
		return tracked;
	}

	/** 只有本次成功传输并完成 rename 的文件才可安装，避免打开截断的残留文件。 */
	isVerified(filePath: string): boolean {
		return this.verified.has(resolve(filePath));
	}

	private async transfer(
		asset: AppUpdateAsset,
		filePath: string,
	): Promise<UpdateArtifactResult> {
		const { transport, onProgress, logger, userAgent } = this.deps;
		const timeoutMs = this.deps.timeoutMs ?? UPDATE_DOWNLOAD_TIMEOUT_MS;
		const progressIntervalMs = this.deps.progressIntervalMs ?? UPDATE_PROGRESS_INTERVAL_MS;
		const now = this.deps.now ?? Date.now;
		const openWriteStream =
			this.deps.openWriteStream ?? ((path: string) => createWriteStream(path));
		const tempPath = `${filePath}.part`;

		return new Promise<UpdateArtifactResult>((fulfill, reject) => {
			const startedAt = now();
			const pending: Buffer[] = [];
			let request: UpdateDownloadRequest | undefined;
			let response: UpdateDownloadResponse | undefined;
			let output: UpdateArtifactWriteStream | undefined;
			let abortTimer: NodeJS.Timeout | undefined;
			let settled = false;
			let receivedBytes = 0;
			let totalBytes = asset.size > 0 ? asset.size : undefined;
			let lastProgressAt = Number.NEGATIVE_INFINITY;
			let streamClosed = false;
			let responseEnded = false;
			let waitingDrain = false;
			const closeWaiters: Array<() => void> = [];

			const emitProgress = () => {
				const timestamp = now();
				if (timestamp - lastProgressAt < progressIntervalMs) return;
				lastProgressAt = timestamp;
				const elapsedSeconds = Math.max(0.001, (timestamp - startedAt) / 1000);
				onProgress({
					assetName: asset.name,
					receivedBytes,
					totalBytes,
					percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : undefined,
					bytesPerSecond: receivedBytes / elapsedSeconds,
					state: "downloading",
				});
			};

			const settle = (finish: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(abortTimer);
				finish();
			};

			// 释放写流句柄后再删临时文件：Windows 上句柄未释放会让 rm 报 EBUSY，留下 .part。
			const discardTemp = async () => {
				if (output && !streamClosed) {
					const closed = new Promise<void>((done) => {
						closeWaiters.push(done);
					});
					output.destroy();
					await Promise.race([
						closed,
						new Promise<void>((done) => {
							const timer = setTimeout(done, STREAM_CLOSE_TIMEOUT_MS);
							timer.unref?.();
						}),
					]);
				}
				await rm(tempPath, { force: true }).catch(() => {
					// 清理失败不覆盖原始错误；残留的 .part 永远不会被当成安装包打开。
				});
			};

			const fail = (error: unknown) => {
				if (settled) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				onProgress({
					assetName: asset.name,
					receivedBytes,
					totalBytes,
					state: "failed",
					error: failure.message,
				});
				void logger?.warn("update", "Download update asset failed", {
					assetName: asset.name,
					error: failure.message,
				});
				settle(() => {
					request?.abort();
					void discardTemp().then(
						() => reject(failure),
						() => reject(failure),
					);
				});
			};

			const promote = async () => {
				try {
					// 同目录 rename 是原子替换：renderer 只可能看到完整文件，不会看到半个安装包。
					await rename(tempPath, filePath);
				} catch (error) {
					fail(error);
					return;
				}
				settle(() => {
					this.verified.add(resolve(filePath));
					const elapsedSeconds = Math.max(0.001, (now() - startedAt) / 1000);
					onProgress({
						assetName: asset.name,
						receivedBytes,
						totalBytes,
						percent: 100,
						bytesPerSecond: receivedBytes / elapsedSeconds,
						state: "completed",
						filePath,
					});
					void logger?.info("update", "Download update asset completed", {
						assetName: asset.name,
						filePath,
						receivedBytes,
					});
					fulfill({ filePath, bytes: receivedBytes });
				});
			};

			const flush = () => {
				if (waitingDrain || settled || !output) return;
				while (pending.length > 0) {
					const chunk = pending.shift();
					if (!chunk) break;
					receivedBytes += chunk.length;
					const writable = output.write(chunk);
					emitProgress();
					if (!writable) {
						// 背压：write 返回 false 表示缓冲区已满，必须先等 drain 再继续写，
						// 否则慢盘会把整个安装包缓存在内存里。
						waitingDrain = true;
						response?.pause?.();
						output.once("drain", () => {
							waitingDrain = false;
							response?.resume?.();
							flush();
						});
						return;
					}
				}
				if (responseEnded) output.end();
			};

			const bindOutput = () => {
				const stream = openWriteStream(tempPath);
				output = stream;
				stream.once("error", (error: Error) => fail(error));
				stream.once("close", () => {
					streamClosed = true;
					for (const done of closeWaiters.splice(0)) done();
					if (!settled) void promote();
				});
			};

			abortTimer = setTimeout(() => {
				fail(new Error(`下载超时（${timeoutMs}ms）：${asset.name}`));
			}, timeoutMs);
			// 超时定时器不应阻止进程退出。
			abortTimer.unref?.();

			void logger?.info("update", "Download update asset started", {
				assetName: asset.name,
				url: asset.url,
			});

			let req: UpdateDownloadRequest;
			try {
				req = transport(asset.url, userAgent);
			} catch (error) {
				fail(error);
				return;
			}
			request = req;
			req.setHeader("User-Agent", userAgent);
			req.on("redirect", (_statusCode, _method, redirectUrl) => {
				// GitHub browser_download_url 通常会 302 到对象存储，必须显式跟随重定向。
				req.followRedirect();
				void logger?.debug("update", "Follow update download redirect", { redirectUrl });
			});
			req.on("error", (error) => fail(error));
			req.on("abort", () => fail(new Error("下载中断：请求被中止")));
			req.on("aborted", () => fail(new Error("下载中断：请求被中止")));
			req.on("response", (incoming) => {
				// 重定向由 followRedirect 内部消化，正常只会派发一个 response；
				// 若客户端异常再派发一个，直接忽略，避免开第二条写流把同一个文件写坏。
				if (settled || output) return;
				response = incoming;
				if (incoming.statusCode < 200 || incoming.statusCode >= 300) {
					fail(new Error(`下载失败：HTTP ${incoming.statusCode}`));
					return;
				}
				const contentLength = Number(incoming.headers["content-length"]);
				if (Number.isFinite(contentLength) && contentLength > 0) totalBytes = contentLength;
				try {
					// 先备好写流再挂 data 监听，避免首块数据到达时 output 还是空的。
					bindOutput();
				} catch (error) {
					fail(error);
					return;
				}
				incoming.on("data", (chunk) => {
					pending.push(chunk);
					flush();
				});
				incoming.on("end", () => {
					responseEnded = true;
					flush();
				});
				incoming.on("error", (error) => fail(error));
				incoming.on("aborted", () => fail(new Error("下载中断：连接被对端中止")));
			});
			req.end();
		});
	}
}
