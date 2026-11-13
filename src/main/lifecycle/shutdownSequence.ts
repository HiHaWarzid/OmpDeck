/**
 * 进程停机顺序（shutdown sequence）——退出与重启共用的唯一停机路径。
 *
 * 背景：原来的 `shutdownServices` 只是 index.ts 里的一个函数，两条退出路径
 * （before-quit 的同步 fire-and-forget、restartApp 的 async await）靠注释约定顺序，
 * 靠人工保证「顺序只改一处」。这里把三件真正会出 bug 的事收进一个 module：
 *
 * 1. **顺序**：先刷盘（settings + 摘要缓存），再停对外服务（Tailscale Serve → Web），
 *    再关终端/agent 进程，最后本地收尾。刷盘没完成就停服务会丢最后一次 update；
 *    先停 Web 再撤 Serve 会短暂留下指向死端口的入口。
 * 2. **同步性**：`awaitFlush: false` 来自 Electron 的同步 `before-quit` handler，
 *    刷盘与 stop 必须同步启动（尤其 `markCleanExit` 要在进程被系统收走前写完），
 *    不能推到 microtask——否则下次启动会把正常退出误判成崩溃恢复。
 * 3. **幂等**：`restartApp` 会先 await 一次停机，随后 `app.quit()` 又触发 before-quit。
 *    第二次调用必须是空操作，否则 `stopAll()` / `closeAll()` 会跑两遍。
 *
 * 错误策略：刷盘失败只告警不阻塞停机（`warn`）；停机步骤本身的异常由 adapter 吞掉，
 * 与旧实现一致——停机中途抛错会让剩余步骤被跳过，退出反而更不干净。
 */

export type ShutdownPorts = {
	/** 设置落盘（内存态 → settings.json） */
	flushSettings(): Promise<void> | void;
	/** 会话摘要缓存落盘 */
	flushSummaryCache(): Promise<void> | void;
	/** 写「干净退出」标记；必须在进程存活期间同步完成 */
	markCleanExit(): void;
	/** 撤掉 Tailscale Serve（独立进程，不等待结果） */
	stopRemoteAccess(): Promise<void> | void;
	/** 停止对外 HTTP 服务，不再接受新请求 */
	stopWebService(): Promise<void> | void;
	/** 关闭会话目录 watcher，释放目录句柄 */
	closeSessionScanner(): Promise<void> | void;
	/** 关闭全部终端 pty */
	closeTerminals(): void;
	/** 停止全部 pi agent 进程（长耗时，fire-and-forget） */
	stopAgents(): Promise<void> | void;
	/** 停止桌面宠物巡逻 */
	stopPet(): void;
	/** 停止速记（QuickGen）进程 */
	stopQuickGen(): void;
	/** 性能水位落盘 */
	dumpPerf(): void;
	/** 刷盘失败等非致命错误 */
	warn(message: string, error?: unknown): void;
};

export class ShutdownSequence {
	private pending: Promise<void> | null = null;

	constructor(private readonly ports: ShutdownPorts) {}

	/** 是否已经进入过停机流程（重复调用为空操作）。 */
	get started(): boolean {
		return this.pending !== null;
	}

	/**
	 * @param awaitFlush true → 返回的 Promise 在刷盘完成后才 stop（restartApp 用）；
	 *                   false → 同步启动 stop，刷盘只 fire-and-forget（before-quit 用）。
	 */
	run({ awaitFlush }: { awaitFlush: boolean }): Promise<void> | void {
		if (this.pending) return this.pending;

		const flush = Promise.all([
			// 逐个 catch：任一路失败都要让另一路继续，且不能吞掉后面的 stop。
			Promise.resolve()
				.then(() => this.ports.flushSettings())
				.catch((error) => this.ports.warn("Failed to flush settings on shutdown", error)),
			Promise.resolve()
				.then(() => this.ports.flushSummaryCache())
				.catch(() => undefined),
		]);
		const stop = () => {
			this.ports.markCleanExit();
			void this.ports.stopRemoteAccess();
			void this.ports.stopWebService();
			void this.ports.closeSessionScanner();
			this.ports.closeTerminals();
			void this.ports.stopAgents();
			this.ports.stopPet();
			this.ports.stopQuickGen();
			this.ports.dumpPerf();
		};

		if (!awaitFlush) {
			// 同步路径：stop 必须在本函数返回前执行（见文件头注释第 2 点）。
			void flush;
			stop();
			this.pending = Promise.resolve();
			return;
		}
		this.pending = flush.then(stop);
		return this.pending;
	}
}
