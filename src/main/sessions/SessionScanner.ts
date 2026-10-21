import type { FileAdapter } from "../fs/adapters/fileAdapter";
import type { FileVersion } from "../fs/adapters/fileAdapter";
import { LocalFileAdapter } from "../fs/adapters/localFileAdapter";
import { WslFileAdapter } from "../fs/adapters/wslFileAdapter";
import { app } from "electron";
import { watch, type FSWatcher } from "chokidar";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { dirname as posixDirname, isAbsolute as posixIsAbsolute, join as posixJoin } from "node:path/posix";
import type { SessionSummary } from "../../shared/types";
import { getCodexSessionThreadInfo } from "../../shared/codexSessionMeta";
import { inferParentCandidatesFromPath, scoreSubagentConfidence, SUBAGENT_CONFIDENCE_THRESHOLD } from "./subagentParentInference";
import type { Worker } from "node:worker_threads";
import { SessionFileOps } from "./SessionFileOps";
import { isJsonRecord, parseSessionText, readEntries } from "./sessionEntries";
import { extractSessionSummaryFacts, type SessionSummaryFacts } from "./sessionSummaryFacts";
import { SessionParsePool } from "./sessionParsePool";
import { toWslLinuxPath, type WslEnvironment } from "../wsl/WslPaths";
import { SessionSummaryCache } from "./sessionSummaryCache";

/** 本地模式扫描并发度：readFile/stat 是异步 IO，32 路足够打满磁盘吞吐且不爆句柄。 */
const SCAN_CONCURRENCY_LOCAL = 32;

/** WSL 模式扫描并发度：每个 stat/read 都 spawn 一个 wsl.exe（100~300ms 进程启动），
 *  8 路并发已能占满 wsl.exe 吞吐，数百文件全并发会进程句柄爆炸。 */
const SCAN_CONCURRENCY_WSL = 8;

/**
 * watcher 索引的有效期：即使监听正常，也至少每 5 分钟重走一次整棵树。
 * watcher 会漏事件（休眠唤醒、网络盘、句柄丢失、事件队列溢出），只靠增量索引
 * 会让漏掉的会话永远不出现；定期全量遍历是兜底，不是性能主路径。
 */
const WATCHER_INDEX_TTL_MS = 5 * 60_000;

/**
 * 不再出现在扫描根列表中的 watcher 保留时长。
 * 项目切换时常会出现 list(project) 与 list() 交替调用；立即关闭会让 watcher
 * 反复重建。闲置一段时间后再关闭，既不抖动，也不会让监听句柄无限增长。
 */
const ROOT_IDLE_TTL_MS = 10 * 60_000;

/**
 * 以固定并发度映射数组。
 * 替代无限制的 Promise.all：会话文件可能上千，本地模式避免同时持有上千个
 * 文件句柄/主线程同步解析，WSL 模式避免同时 spawn 上千个 wsl.exe。
 * 结果按输入顺序返回，与 Promise.all 语义一致。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onResult?: (result: R) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  if (workerCount === 0) return results;
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const result = await fn(items[index], index);
      results[index] = result;
      // 每完成一个文件就上报，供首屏渐进返回（见 SessionScanner.list 的部分结果窗口）。
      onResult?.(result);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 首次扫描在无摘要缓存时要整读全部 JSONL（实测 0.86GB 约 9.5s）。这里给调用方一个
 * 短等待窗口：窗口内完成就返回完整结果；未完成则先返回已解析的尾部快照，完整结果
 * 落盘后通过 sessions:changed 事件触发渲染层刷新。窗口取 1.2s——足够覆盖热缓存扫描，
 * 又不至于让冷启动首屏等满整轮。
 */
const PARTIAL_SCAN_WAIT_MS = 1_200;

/**
 * 小文件不值得付 worker 启动/消息往返成本；主线程解析几十 KB JSONL 只需微秒级。
 * 阈值按单文件指纹大小判断，大会话（历史/工具输出密集）才进入 worker 池。
 */
const PARSE_WORKER_MIN_BYTES = 256 * 1024;

interface ScanJob {
  /** 完整扫描结果（含缓存命中与新解析文件），按 updatedAt 倒序。 */
  promise: Promise<SessionSummary[]>;
  /** 扫描过程中的已解析摘要；完成前可被读取。 */
  partial: SessionSummary[];
  done: boolean;
  /** 是否已有调用方拿到过部分结果；只有这种情况才需要在完成时通知刷新。 */
  deliveredPartial: boolean;
}

export class SessionScanner {
  private readonly root = join(app.getPath("home"), ".omp", "agent", "sessions");
  private readonly codexRoot = join(app.getPath("home"), ".codex", "sessions");
  /** WSL 配置由主进程统一解析；内部保留 home 字段以维持扫描代码的单一 Linux 路径语义。 */
  private wslConfig: { distro: string; user: string; home: string } | null = null;
  /** 文件访问适配器：configureWsl/clearWsl 时按环境选择 Local/Wsl 实现。 */
  private fileAdapter: FileAdapter = new LocalFileAdapter();
  /** 比 renderer watchdog 更短，确保超时前先终止实际扫描，避免后台请求堆积。 */
  private scanTimeoutMs = 18_000;
  /** 摘要解析 worker 池；未注入工厂时为 null（测试或纯 Node 环境走主线程）。 */
  private readonly parsePool: SessionParsePool | null;
  private readonly summaryCache = new SessionSummaryCache<SessionSummary | null>();
  private summaryCacheFileSetKey = "";
  /**
   * isSameProject 内容校验的结果缓存：key 为文件路径，值是该文件对每个项目的匹配布尔。
   * 只有「父目录 cwd 会话」才需要整读内容匹配项目路径（isParentSessionForProject），
   * 这里缓存「某个项目是否在该文件里出现过」，避免重复扫描时对同一文件反复整读。
   * 内存 + 磁盘双层：否则每次冷启动首屏都要把所有 home/父目录会话整读一遍
   * （实测 1.2s，项目嵌套时更久）。值只有布尔，不缓存全文。
   * 随 summaryCache 的 fileSetKey 变化一起修剪。
   */
  private readonly projectMatchCache = new SessionSummaryCache<Record<string, boolean>>(
    "session-project-match-cache.json",
  );
  /**
   * isSessionFile 校验结果的指纹缓存：父会话候选文件（<stem>.jsonl）只在子会话
   * 结束时才更新，每次扫描对每个候选父做 stat + readHead(4096) 的成本可省。
   * 与 projectMatchCache 同一处修剪。
   */
  private readonly sessionFileCheckCache = new Map<string, { version: FileVersion; valid: boolean }>();
  /**
   * 最近一次 list() 解析出的会话扫描根目录。
   * 默认 ~/.omp/agent/sessions，加上 settings 中的 sessionDir（如项目 .omp/sessions）。
   * 供子会话父路径推断作为边界。
   */
  private activeScanRoots: string[] = [];

  /**
   * 每个扫描根的增量文件索引（normalizedRoot → 文件路径集合）。
   * 首次扫描写入，之后由 chokidar 的 add/unlink 事件增删，避免每次 list() 全量 readdir。
   */
  private readonly rootFileIndex = new Map<string, Set<string>>();
  /** 每个扫描根最近一次全量遍历的时间戳；缺失或超过 TTL 时重走整棵树。 */
  private readonly rootIndexWalkedAt = new Map<string, number>();
  /** 每个扫描根最近一次出现在扫描请求中的时间，用于闲置清理 watcher。 */
  private readonly rootLastSeenAt = new Map<string, number>();
  private readonly rootWatchers = new Map<string, FSWatcher>();
  /**
   * 扫描根并发引用计数：关闭“已不再使用的根” watcher 前需确认没有其他并发扫描
   * 仍在使用它，否则不同项目的并发 list() 会互相关闭对方的监听。
   */
  private readonly rootActiveScans = new Map<string, number>();

  /**
   * 会话文件操作（rename/delete/readMessages/readSessionMeta/readSessionFile）。
   * 适配器随 configureWsl 替换，经 getAdapter 访问器每次读取最新实例。
   * 对外直接暴露该模块：handler 调用的就是真正实现，不再经本类转发。
   */
  readonly fileOps = new SessionFileOps({
    getAdapter: () => this.fileAdapter,
    localSessionsRoot: this.root,
    getDefaultSessionsRoot: () => this.defaultSessionsRoot,
  });

  constructor(
    private readonly options: {
      /** 冷扫描完整结束后通知渲染层刷新（只在本次调用返回过部分结果时触发）。 */
      onScanSettled?: () => void;
      /** 测试注入用：部分结果等待窗口，默认 1.2s。 */
      partialWaitMs?: number;
      /** 生产注入：创建摘要解析 worker；缺省时在调用线程解析（测试/无 worker 环境）。 */
      createParseWorker?: () => Worker;
      /** 摘要解析 worker 数，默认 2。 */
      parseWorkerCount?: number;
    } = {},
  ) {
    this.parsePool = options.createParseWorker
      ? new SessionParsePool({
          createWorker: options.createParseWorker,
          size: options.parseWorkerCount,
        })
      : null;
  }

  /**
   * wsl.exe 命令与启动模式。优先绝对路径，
   * 文件不存在时回退到 shell PATH 查找。
   */
  private resolveWslExe(): { command: string; shell: boolean } {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const candidates = process.arch === "ia32"
      ? [join(systemRoot, "Sysnative", "wsl.exe"), join(systemRoot, "System32", "wsl.exe")]
      : [join(systemRoot, "System32", "wsl.exe")];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { command: candidate, shell: false };
    }
    return { command: "wsl", shell: true };
  }
  /** @deprecated 使用 resolveWslExe() 代替 */
  private get wslExePath(): string {
    return this.resolveWslExe().command;
  }
  /** 是否需要 shell 模式来查找 wsl.exe */
  private get wslShell(): boolean {
    return this.resolveWslExe().shell;
  }

  async configureWsl(environment: WslEnvironment | null): Promise<void> {
    this.wslConfig = environment
      ? { distro: environment.distro, user: environment.user, home: environment.linuxHome }
      : null;
    // 按环境选择文件访问适配器：WSL 走 wsl.exe，本地走 node:fs。
    this.fileAdapter = this.wslConfig
      ? new WslFileAdapter({
          distro: this.wslConfig.distro,
          user: this.wslConfig.user,
          wslExePath: this.resolveWslExe().command,
          wslShell: this.resolveWslExe().shell,
        })
      : new LocalFileAdapter();
    // 环境切换时只重置“本轮扫描键”，并从磁盘重新装载缓存；不要把另一环境的磁盘缓存清空。
    this.summaryCacheFileSetKey = "";
    await this.summaryCache.reloadFromDisk();
    await this.projectMatchCache.reloadFromDisk();
  }

  /** 清除 WSL 配置 */
  clearWsl(): void {
    this.wslConfig = null;
    this.fileAdapter = new LocalFileAdapter();
    this.summaryCacheFileSetKey = "";
    void this.summaryCache.reloadFromDisk();
    void this.projectMatchCache.reloadFromDisk();
  }

  /** WSL 中 pi 默认 session 目录（基于动态获取的 home） */
  private get wslSessionsDir(): string {
    return `${this.wslConfig!.home}/.omp/agent/sessions`;
  }

  /** 当前环境下的默认会话根目录（全局 encoded-cwd 布局） */
  private get defaultSessionsRoot(): string {
    return this.wslConfig ? this.wslSessionsDir : this.root;
  }

  /** 判断文件路径是否为 WSL Linux 路径（以 / 开头且属于当前 WSL 配置） */
  private isWslPath(filePath: string): boolean {
    if (!this.wslConfig) return false;
    // WSL 路径是 Linux 绝对路径（以 / 开头且不以盘符开头）
    return filePath.startsWith("/") && !/^[A-Za-z]:/.test(filePath);
  }

  /** 进行中的原始扫描（按扫描根共享）：并发 list() 合并为同一轮扫描。 */
  private readonly scanJobs = new Map<string, ScanJob>();

  async list(projectPath?: string): Promise<SessionSummary[]> {
    // 匹配用路径：WSL 模式下转 /mnt/...，与会话 JSONL 内 cwd 对齐。
    const normalizedProjectPath = projectPath && this.wslConfig
      ? toWslLinuxPath(projectPath, this.wslConfig)
      : projectPath;

    // 扫描根 = 默认全局 sessions + 项目/全局 sessionDir（如 <project>/.omp/sessions）。
    // pi/omp 配置 sessionDir 后不再写 encoded-cwd 子目录，必须额外扫该路径。
    const scanRoots = await this.resolveScanRoots(projectPath, normalizedProjectPath);

    // 原始扫描结果与项目无关（项目归属在共享结果之上逐调用方过滤），因此快速连点、
    // 周期同步、多项目同时展开会合并为同一轮扫描：慢扫描时后到的请求直接复用
    // 进行中的结果，而不是叠加多轮全量扫描互相拖慢，最终谁也拿不到列表。
    const job = this.scanShared(scanRoots);
    const summaries = await this.awaitScan(job);

    if (!normalizedProjectPath) return summaries;
    // 异步 isSameProject 过滤（自定义 sessionDir 下的文件也会按 cwd/路径归属判断）
    const matched = await this.filterByProject(summaries, normalizedProjectPath);
    return summaries.filter((_, i) => matched[i]);
  }

  /**
   * 等待共享扫描：热缓存通常立即完成；冷扫描超过窗口时先返回已解析的部分结果，
   * 完整结果完成后由 onScanSettled 通知渲染层再取一次（那时已是热缓存，毫秒级）。
   */
  private async awaitScan(job: ScanJob): Promise<SessionSummary[]> {
    if (!job.done) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.options.partialWaitMs ?? PARTIAL_SCAN_WAIT_MS);
      });
      let outcome: "done" | "timeout";
      try {
        outcome = await Promise.race([
          job.promise.then(() => "done" as const),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (outcome === "timeout" && !job.done && job.partial.length > 0) {
        job.deliveredPartial = true;
        // 部分结果按 UI 同一排序规则输出；拷贝避免调用方改动内部快照。
        return [...job.partial].sort((a, b) => b.updatedAt - a.updatedAt);
      }
    }
    return job.promise;
  }

  /**
   * 按扫描根共享进行中的原始扫描（不按项目过滤，排序已完成）。
   * 只有扫描根不同的并发调用（如不同项目配置了不同 sessionDir）才会各自扫描。
   */
  private scanShared(scanRoots: string[]): ScanJob {
    const key = scanRoots.map((root) => this.normalize(root)).join("\n");
    const inFlight = this.scanJobs.get(key);
    if (inFlight) return inFlight;

    const partial: SessionSummary[] = [];
    const startedAt = Date.now();
    let job!: ScanJob;
    // 整个 scanOnce 也纳入 watchdog：本地 fs 调用不可中断，若只依赖 signal 传递，
    // 卡在 readFile/stat 上的扫描会让共享 promise 永远 pending，后续 list() 全部挂死。
    let scan: Promise<SessionSummary[]>;
    scan = this.withScanWatchdog(
      "Session scan",
      (signal) => this.scanOnce(scanRoots, signal, (summary) => {
        if (summary) partial.push(summary);
      }),
    ).finally(() => {
      job.done = true;
      if (process.env.PIDECK_PERF === "1") {
        const elapsed = Date.now() - startedAt;
        console.log(
          `[perf] session scan ${elapsed}ms parsed=${partial.length} partial=${job.deliveredPartial}`,
        );
      }
      // 只清理自己注册的条目：期间可能有新调用注册了同 key 的新一轮扫描。
      if (this.scanJobs.get(key) === job) this.scanJobs.delete(key);
    });
    job = { promise: scan, partial, done: false, deliveredPartial: false };
    this.scanJobs.set(key, job);
    // 部分结果已经返回过，就必须在完整扫描成功后唤醒渲染层；
    // 否则 UI 会长期停留在首屏截断的列表上。失败不通知，避免磁盘持续异常时
    // 18s 超时 → 重扫 → 再超时的无限循环（保留部分列表，用户可手动刷新）。
    void scan.then(
      () => this.notifyScanSettled(job),
      () => undefined,
    );
    return job;
  }

  private notifyScanSettled(job: ScanJob): void {
    if (!job.deliveredPartial) return;
    try {
      this.options.onScanSettled?.();
    } catch {
      // 通知失败不能影响扫描结果本身。
    }
  }

  /**
   * 扫描 watchdog：超时同时 abort（WSL 下能真正终止 wsl.exe）并让外层 promise reject
   * （本地模式下 fs 调用不响应 signal，只能靠 race 解挂）。
   * 底层扫描被放弃后仍可能自行结束，Promise.race 已挂好 handler，不会产生未处理拒绝。
   */
  private async withScanWatchdog<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new Error(`${label} timed out`);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, this.scanTimeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async scanOnce(
    scanRoots: string[],
    signal: AbortSignal,
    onResult?: (summary: SessionSummary | null) => void,
  ): Promise<SessionSummary[]> {
    const rethrowAbort = <T>(fallback: T) => (error: unknown): T => {
      if (signal.aborted) throw signal.reason ?? error;
      return fallback;
    };

    // 重启后先恢复磁盘摘要缓存，避免全量重读 JSONL。
    await this.summaryCache.ensureLoaded();
    await this.projectMatchCache.ensureLoaded();
    this.activeScanRoots = scanRoots;

    // WSL 模式 vs 本地模式：互斥扫描，不会同时展示两个环境的会话。
    // 文件访问统一走 fileAdapter，两个环境共用同一条扫描路径。
    const files = await this.collectFromRoots(scanRoots, signal).catch(rethrowAbort([] as string[]));
    const fileSetKey = [...files].sort().join("\n");
    if (fileSetKey !== this.summaryCacheFileSetKey) {
      // 仅修剪当前环境下已消失文件，保留未变化会话的摘要命中（含磁盘恢复的条目）。
      this.summaryCache.prune(files, this.wslConfig ? "wsl" : "local");
      // 同步修剪项目匹配结果缓存，避免已删除会话的条目长期残留。
      this.projectMatchCache.prune(files, this.wslConfig ? "wsl" : "local");
      const fileSet = new Set(files.map((f) => this.normalize(f)));
      // 父会话校验缓存同样只保留当前扫描集合内的条目。
      for (const key of this.sessionFileCheckCache.keys()) {
        if (!fileSet.has(this.normalize(key))) this.sessionFileCheckCache.delete(key);
      }
      this.summaryCacheFileSetKey = fileSetKey;
    }

    // 指纹预取：WSL 模式下 statMany 把 N 次 wsl.exe spawn 合并为 ceil(N/100) 次，
    // readSummary 直接消费预取结果；本地模式无 statMany，保持逐文件 stat。
    const prefetchedVersions = this.fileAdapter.statMany
      ? await this.fileAdapter.statMany(files, signal).catch(() => undefined)
      : undefined;

    const summaries = await mapWithConcurrency(
      files,
      this.wslConfig ? SCAN_CONCURRENCY_WSL : SCAN_CONCURRENCY_LOCAL,
      (file) =>
        this.readSummary(file, signal, prefetchedVersions?.get(file)).catch(rethrowAbort(null)),
      onResult,
    );
    signal.throwIfAborted();

    return summaries
      .filter((summary): summary is SessionSummary => Boolean(summary))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 在共享扫描结果上按项目归属过滤；同样受 watchdog 约束，
   * 避免过滤阶段的文件读取（父目录会话内容校验）无界等待。
   */
  private async filterByProject(summaries: SessionSummary[], projectPath: string): Promise<boolean[]> {
    return this.withScanWatchdog("Session filter", async (signal) => {
      const matched = await mapWithConcurrency(
        summaries,
        this.wslConfig ? SCAN_CONCURRENCY_WSL : SCAN_CONCURRENCY_LOCAL,
        (summary) => this.isSameProject(summary, projectPath, signal),
      );
      signal.throwIfAborted();
      return matched;
    });
  }

  /**
   * 解析本次应扫描的会话根目录。
   * 始终包含默认全局目录（保留历史会话）；若 settings 配置了 sessionDir 且目录存在则追加。
   *
   * @param hostProjectPath 项目原始路径（通常是 Windows 路径，用于读 .omp/settings.json）
   * @param runtimeProjectPath 运行时 cwd 路径（WSL 下已是 /mnt/...，用于解析相对 sessionDir）
   */
  private async resolveScanRoots(
    hostProjectPath?: string,
    runtimeProjectPath?: string,
  ): Promise<string[]> {
    const roots: string[] = [this.defaultSessionsRoot];
    if (!hostProjectPath || !runtimeProjectPath) return roots;

    const configured = await this.resolveConfiguredSessionDir(hostProjectPath, runtimeProjectPath);
    if (!configured) return roots;

    const normalizedConfigured = this.normalize(configured);
    if (roots.some((root) => this.normalize(root) === normalizedConfigured)) return roots;

    const exists = await this.fileAdapter.existsDir(configured);
    if (exists) roots.push(configured);
    return roots;
  }

  /**
   * 读取 pi 的 sessionDir 配置并解析为可扫描绝对路径。
   * 优先级：项目 `.omp/settings.json` > 全局 `~/.omp/agent/settings.json`。
   */
  /** 读取 pi 的 sessionDir 配置并解析为可扫描绝对路径。
   * 优先级：项目 `.omp/settings.json` > 全局 `~/.omp/agent/settings.json`。
   * 文件访问统一走 fileAdapter（WSL 读 Linux 路径，本地读 Windows 路径）。
   */
  private async resolveConfiguredSessionDir(
    hostProjectPath: string,
    runtimeProjectPath: string,
  ): Promise<string | undefined> {
    const projectSettingsPath = join(this.toHostReadablePath(hostProjectPath), ".omp", "settings.json");
    const projectRaw = await this.readSessionDirSetting(projectSettingsPath);

    const globalSettingsPath = this.wslConfig
      ? `${this.wslConfig.home}/.omp/agent/settings.json`
      : join(app.getPath("home"), ".omp", "agent", "settings.json");
    const globalRaw = await this.readSessionDirSetting(globalSettingsPath);

    const raw = projectRaw ?? globalRaw;
    if (!raw) return undefined;
    return this.resolveSessionDirPath(raw, runtimeProjectPath);
  }

  private async readSessionDirSetting(settingsPath: string): Promise<string | undefined> {
    try {
      if (!(await this.fileAdapter.exists(settingsPath))) return undefined;
      const raw = await this.fileAdapter.read(settingsPath);
      const parsed = JSON.parse(raw) as { sessionDir?: unknown };
      return typeof parsed.sessionDir === "string" && parsed.sessionDir.trim()
        ? parsed.sessionDir.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 将 sessionDir 配置解析为扫描用绝对路径。
   * 对齐 pi：展开 `~`；相对路径相对项目 cwd（非 settings 文件目录）。
   */
  private resolveSessionDirPath(sessionDir: string, projectCwd: string): string {
    const expanded = this.expandHomePrefix(sessionDir);
    if (this.wslConfig) {
      const normalized = expanded.replace(/\\/g, "/");
      if (posixIsAbsolute(normalized)) return normalized;
      if (/^[A-Za-z]:[\\/]/.test(expanded)) {
        return toWslLinuxPath(expanded, this.wslConfig);
      }
      return posixJoin(projectCwd.replace(/\\/g, "/"), normalized);
    }
    if (isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) {
      return resolve(expanded);
    }
    return resolve(projectCwd, expanded);
  }

  /** 展开 `~` / `~/...`；WSL 下使用 WSL home */
  private expandHomePrefix(input: string): string {
    const home = this.wslConfig?.home ?? app.getPath("home");
    if (input === "~") return home;
    if (input.startsWith("~/") || input.startsWith("~\\")) {
      return this.wslConfig
        ? `${home}/${input.slice(2).replace(/\\/g, "/")}`
        : join(home, input.slice(2));
    }
    return input;
  }

  /**
   * 把可能的 /mnt/<drive>/... 转成 Windows 盘符路径，便于宿主 fs 读取项目 settings。
   * 非 /mnt 的 Linux 路径保持原样（由 WSL 链路处理）。
   */
  private toHostReadablePath(path: string): string {
    const match = path.replace(/\\/g, "/").match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (!match) return path;
    return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
  }

  private async collectFromRoots(roots: string[], signal?: AbortSignal): Promise<string[]> {
    const all: string[] = [];
    const seen = new Set<string>();
    const rootKeys = roots.map((root) => this.normalize(root));
    const now = Date.now();
    for (const key of rootKeys) {
      this.rootActiveScans.set(key, (this.rootActiveScans.get(key) ?? 0) + 1);
      this.rootLastSeenAt.set(key, now);
    }
    try {
      for (const root of roots) {
        const rootKey = this.normalize(root);
        // WSL 会话根是 Linux 路径，Windows 上的 chokidar 无法监听：保持逐次全量遍历。
        const cachedIndex = this.wslConfig ? undefined : this.rootFileIndex.get(rootKey);
        const lastWalkAt = this.rootIndexWalkedAt.get(rootKey) ?? 0;
        const fresh =
          cachedIndex !== undefined &&
          this.rootWatchers.has(rootKey) &&
          Date.now() - lastWalkAt < WATCHER_INDEX_TTL_MS;

        let files: string[];
        if (fresh && cachedIndex) {
          files = [...cachedIndex];
        } else {
          files = await this.fileAdapter.collectJsonl(root, signal).catch(() => [] as string[]);
          // 扫描被取消时不能把不完整结果写进索引，否则 5 分钟内的后续扫描会看到残缺列表。
          if (signal?.aborted) throw signal.reason ?? new Error("Session scan aborted");
          // WSL 路径无法被 chokidar 监听，索引永远无法保持新鲜，不保存以免白占内存。
          if (!this.wslConfig) {
            this.rootFileIndex.set(rootKey, new Set(files));
            this.rootIndexWalkedAt.set(rootKey, Date.now());
            this.ensureRootWatcher(rootKey, root);
          }
        }

        for (const file of files) {
          const key = this.normalize(file);
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(file);
        }
      }
      // 扫描根会随项目切换（自定义 sessionDir）而变；关闭不再被任何进行中扫描使用的根 watcher，
      // 避免为每个打开过的项目长留监听句柄。
      await this.pruneInactiveRootState(new Set(rootKeys));
      return all;
    } finally {
      for (const key of rootKeys) {
        const next = (this.rootActiveScans.get(key) ?? 1) - 1;
        if (next <= 0) this.rootActiveScans.delete(key);
        else this.rootActiveScans.set(key, next);
      }
    }
  }

  /**
   * 为扫描根建立 chokidar 监听；已有监听时不重复创建。
   * 监听不可用（不存在/权限/UNC）时静默退回全量遍历——watcher 只是加速，不能影响可用性。
   */
  private ensureRootWatcher(rootKey: string, root: string): void {
    if (this.wslConfig) return;
    if (this.rootWatchers.has(rootKey)) return;

    let watcher: FSWatcher;
    try {
      // 不设 glob：chokidar 4 的默认行为就是递归监听整个目录，add/unlink 直接给出文件路径。
      // persistent: false 避免监听句柄单独撑住事件循环（Electron 主进程自身有生命周期）。
      watcher = watch(root, { ignoreInitial: true, ignorePermissionErrors: true, persistent: false });
    } catch {
      return;
    }
    this.rootWatchers.set(rootKey, watcher);

    // 目录增删意味着索引可能整段漏掉：清掉遍历时间戳，下次扫描强制重走该根。
    const markStale = () => {
      if (this.rootWatchers.get(rootKey) !== watcher) return;
      this.rootIndexWalkedAt.delete(rootKey);
    };
    watcher.on("add", (filePath) => {
      if (this.rootWatchers.get(rootKey) !== watcher) return;
      if (!filePath.toLowerCase().endsWith(".jsonl")) return;
      this.rootFileIndex.get(rootKey)?.add(filePath);
    });
    watcher.on("unlink", (filePath) => {
      if (this.rootWatchers.get(rootKey) !== watcher) return;
      this.rootFileIndex.get(rootKey)?.delete(filePath);
    });
    watcher.on("addDir", markStale);
    watcher.on("unlinkDir", markStale);
    watcher.on("error", markStale);
    // 首次遍历(fs.watch 建立 + chokidar 初始 crawl)与刚才的 walk 之间存在窗口：
    // 期间新建的文件会被 ignoreInitial 当成初始内容吞掉。ready 后强制再走一次，
    // 把窗口缩到「下一次轮询」，而不是等满 5 分钟 TTL。
    watcher.on("ready", markStale);
  }

  /**
   * 清理闲置的根状态。只有「本轮未使用 + 无并发扫描引用 + 闲置超过 ROOT_IDLE_TTL_MS」
   * 三个条件同时满足才关闭，避免项目切换时 watcher 抖动，也避免监听句柄无限增长。
   */
  private async pruneInactiveRootState(activeRootKeys: Set<string>): Promise<void> {
    const now = Date.now();
    const isIdle = (rootKey: string) =>
      !activeRootKeys.has(rootKey) &&
      (this.rootActiveScans.get(rootKey) ?? 0) === 0 &&
      now - (this.rootLastSeenAt.get(rootKey) ?? 0) >= ROOT_IDLE_TTL_MS;

    const closing: Promise<void>[] = [];
    for (const [rootKey, watcher] of [...this.rootWatchers]) {
      if (!isIdle(rootKey)) continue;
      this.rootWatchers.delete(rootKey);
      closing.push(watcher.close().catch(() => undefined));
    }
    for (const rootKey of [...this.rootFileIndex.keys()]) {
      if (!isIdle(rootKey)) continue;
      this.rootFileIndex.delete(rootKey);
      this.rootIndexWalkedAt.delete(rootKey);
    }
    for (const rootKey of [...this.rootLastSeenAt.keys()]) {
      if (!isIdle(rootKey)) continue;
      this.rootLastSeenAt.delete(rootKey);
    }
    await Promise.all(closing);
  }

  /** 应用退出时关闭所有会话目录监听；再次调用扫描会按需重建。 */
  async close(): Promise<void> {
    const watchers = [...this.rootWatchers.values()];
    this.rootWatchers.clear();
    this.rootFileIndex.clear();
    this.rootIndexWalkedAt.clear();
    this.rootLastSeenAt.clear();
    this.rootActiveScans.clear();
    await Promise.all([
      ...watchers.map((watcher) => watcher.close().catch(() => undefined)),
      this.parsePool?.dispose() ?? Promise.resolve(),
    ]);
  }

  /**
   * 从文件路径推断父会话文件路径。
   *
   * 算法：从子会话文件所在目录向上遍历，在每一层检查同级目录中是否存在
   * <dirname>.jsonl 文件，并校验其内容为合法 Pi Agent 会话 JSONL。
   * 候选路径的生成是纯路径运算（见 inferParentCandidatesFromPath），此处只做
   * 存在性与合法性校验。
   *
   * 支持的布局（任一扩展都可用）：
   *   - pi-subagents:  <stem>/<run-id>/run-N/session.jsonl → 父 = <stem>.jsonl
   *   - Claude Code 式: <stem>/subagents/agent-<id>.jsonl    → 父 = <stem>.jsonl
   *   - 自定义嵌套:     <stem>/any/deep/path/session.jsonl   → 父 = <stem>.jsonl
   *   - omp:            <stem>/<label>.jsonl                 → 父 = <stem>.jsonl
   *
   * 深度限制 10 层，且不超出 sessions 根目录，避免误判和性能问题。
   */
  private async inferParentSessionFromPath(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
    // 仅处理 .jsonl 文件
    if (!filePath.toLowerCase().endsWith(".jsonl")) return undefined;

    // 自定义 sessionDir 与默认根并存时，以包含该文件的最近扫描根为边界。
    const normalizedRoot = this.normalize(this.findSessionsRootForFile(filePath));

    for (const candidateParent of inferParentCandidatesFromPath(filePath, normalizedRoot)) {
      if ((await this.fileAdapter.exists(candidateParent, signal)) && (await this.isSessionFile(candidateParent, signal))) {
        return candidateParent;
      }
    }

    return undefined;
  }

  /**
   * 快速校验文件是否为 Pi Agent 会话 JSONL（非备份/导出/重命名残留）。
   * 真实会话的首行通常是 omp 的 `type: "title"` 定长标题槽（旧会话为 `type: "session"`）；
   * 兼容旧版应用重命名后前置的 sessionName 元数据，但要求随后仍出现 type 字段，
   * 不能只凭任意 JSON 对象误判为父会话。
   */
  private async isSessionFile(filePath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const info = await this.fileAdapter.stat(filePath, signal);
      const version = { mtimeMs: info.mtimeMs, size: info.size };
      const cached = this.sessionFileCheckCache.get(filePath);
      if (cached && cached.version.mtimeMs === version.mtimeMs && cached.version.size === version.size) {
        return cached.valid;
      }
      const valid = this.hasSessionHeader(await this.fileAdapter.readHead(filePath, 4096, signal));
      this.sessionFileCheckCache.set(filePath, { version, valid });
      return valid;
    } catch {
      return false;
    }
  }

  private hasSessionHeader(raw: string): boolean {
    // 头部窗口内出现带 type 的对象即认定为会话文件（头部 4KB 足够容纳 pi 的首条 session 记录）；
    // 解析与编码守卫与整读路径共用同一实现。
    for (const parsed of parseSessionText(raw).entries.slice(0, 12)) {
      if (isJsonRecord(parsed) && typeof parsed.type === "string") return true;
    }
    return false;
  }

  private async readSummary(
    filePath: string,
    signal?: AbortSignal,
    prefetchedVersion?: FileVersion,
  ): Promise<SessionSummary | null> {
    // 先读取轻量文件指纹；未变化时复用摘要，避免周期扫描反复读取和解析全部 JSONL。
    // 指纹优先用 scanOnce 的批量预取结果（WSL 单次进程拿全部），缺失时回退单文件 stat。
    const isWsl = this.isWslPath(filePath);
    const version =
      prefetchedVersion ?? (await this.fileAdapter.stat(filePath, signal));
    const cached = this.summaryCache.get(filePath, version);
    if (cached !== undefined) return cached;

    const facts = await this.readSummaryFacts(filePath, version, isWsl, signal);
    return this.buildSummaryFromFacts(filePath, version, isWsl, facts, signal);
  }

  /**
   * 读取 → 解码 → 逐行解析。
   *
   * 本地文件交给 worker 池，主进程只接收摘要事实；WSL 路径必须经 wsl.exe 适配器，
   * 无法在普通 worker 中复用，保留主线程读取。worker 不可用/崩溃时回退主线程，
   * 功能正确性优先于性能。
   */
  private async readSummaryFacts(
    filePath: string,
    version: FileVersion,
    isWsl: boolean,
    signal?: AbortSignal,
  ): Promise<SessionSummaryFacts> {
    if (this.parsePool && !isWsl && version.size >= PARSE_WORKER_MIN_BYTES) {
      try {
        return await this.parsePool.parse(filePath, signal);
      } catch (error) {
        // 扫描取消不是解析失败，直接向上抛出，避免无意义的整文件重读。
        if (signal?.aborted) throw error;
      }
    }

    // 读取 → 解码 → 逐行解析由 sessionEntries 独占（BOM/UTF-16 守卫的唯一实现）；
    // 复用已取到的指纹，避免同一次扫描对同一文件重复 stat。
    const file = await readEntries(this.fileAdapter, filePath, { fingerprint: version, signal });
    return extractSessionSummaryFacts({
      entries: file.entries,
      malformedLines: file.malformedLines,
      unreadable: file.unreadable,
      raw: file.raw,
    });
  }

  private async buildSummaryFromFacts(
    filePath: string,
    version: FileVersion,
    isWsl: boolean,
    facts: SessionSummaryFacts,
    signal?: AbortSignal,
  ): Promise<SessionSummary | null> {
    // 不可读（UTF-16/二进制）、空文件、全部行损坏：隐藏，而不是显示成"空会话"的幽灵条目。
    if (facts.unreadable || facts.rawEmpty || facts.parsedLines === 0) {
      this.summaryCache.set(filePath, version, null);
      return null;
    }

    // 检测子会话：任意扩展产生的内部 worker/reviewer 会话。
    // 不在顶层列表显示，而是设置 parentSessionPath 供 UI 嵌套渲染。
    //
    // 采用分层信号打分机制（scoreSubagentConfidence 纯函数，见 subagentParentInference）：
    //   强信号（2分）：路径布局匹配、显式 customType 标记
    //   弱信号（1分）：子会话命名模式、parentSession header 引用
    //   置信度阈值：≥ SUBAGENT_CONFIDENCE_THRESHOLD 判定为子会话
    const pathInferredParent = await this.inferParentSessionFromPath(filePath, signal);
    // 会话名优先级：title_change（最新重命名）> title 槽 > 会话头标题 > 旧版 session_info。
    // 旧桌面端只写 session_info，保留在末尾兜底，保证已有会话不丢名字。
    const explicitSessionName =
      facts.latestTitleChangeName || facts.titleSlotName || facts.sessionHeaderTitle || facts.latestSessionInfoName;

    const confidenceScore = scoreSubagentConfidence({
      pathInferred: Boolean(pathInferredParent),
      customMarker: facts.hasSubagentChildMarker,
      sessionName: explicitSessionName,
      parentSessionRef: facts.forkParentSession,
    });

    let parentSessionPath: string | undefined;
    if (facts.source === "pi" && confidenceScore >= SUBAGENT_CONFIDENCE_THRESHOLD) {
      // 优先复用上面已完成的路径推断，避免重复遍历文件系统/WSL。
      parentSessionPath = pathInferredParent;
      // 路径推断失败时，尝试使用 forkParentSession header 引用的父路径
      if (!parentSessionPath && facts.forkParentSession) {
        const normalizedForkParent = facts.forkParentSession.replace(/\\/g, "/");
        const resolved = isWsl
          ? posixJoin(posixDirname(filePath), normalizedForkParent)
          // forkParentSession 可能来自 fork header 的绝对 Windows 路径；
          // path.join 在 Windows 上不会以盘符根路径重置，需用 resolve。
          : resolve(dirname(filePath), facts.forkParentSession);
        const normalizedResolved = this.normalize(resolved);
        const normalizedSessionsRoot = this.normalize(this.findSessionsRootForFile(filePath));
        // header 来自外部 JSONL；仅允许引用当前 sessions 根目录内的现有文件，避免路径穿越或误挂载。
        const isInsideSessionsRoot =
          normalizedResolved !== normalizedSessionsRoot &&
          normalizedResolved.startsWith(`${normalizedSessionsRoot}/`);
        const resolvedExists = isInsideSessionsRoot && (await this.fileAdapter.exists(resolved, signal));
        if (resolvedExists) {
          parentSessionPath = resolved;
        }
      }
    }

    if (facts.source === "codex" && facts.codexSourcePath && !facts.codexParentThreadId) {
      const fallbackInfo = await this.readCodexThreadInfo(facts.codexSourcePath);
      if (fallbackInfo) {
        facts.codexThreadSource = fallbackInfo.threadSource;
        facts.codexParentThreadId = fallbackInfo.parentThreadId;
        facts.codexAgentRole = fallbackInfo.agentRole;
        facts.codexAgentNickname = fallbackInfo.agentNickname;
      }
    }

    // 显式标题优先；旧版应用的 sessionName 私有行及其他字段仅作降级回退。
    let inferredName = this.cleanTitle(explicitSessionName) || this.cleanTitle(facts.name) || this.cleanTitle(facts.firstUserText) || this.cleanTitle(facts.firstAssistantText) || "Untitled";

    // omp/pi 子代理会话常没有显式标题（title 为空），且首条消息都是 task 工具的固定前缀
    // （"Complete the assignment below, thoroughly: ..."），此时名字会退化成同一条截断文本，
    // 展开后整组子会话无法区分。子会话布局下文件名即代理标签（如 AgentManagerApi），
    // 无显式标题时用文件名作为名字；session.jsonl 这类通用名无区分度，仍保持消息回退。
    if (parentSessionPath && !explicitSessionName && !facts.name) {
      const fileLabel = basename(filePath).replace(/\.jsonl$/i, "");
      if (fileLabel && fileLabel !== "session") {
        inferredName = this.cleanTitle(fileLabel) ?? inferredName;
      }
    }

    const summary: SessionSummary = {
      id: filePath,
      filePath,
      projectPath: facts.projectPath ? this.normalize(facts.projectPath) : this.inferProjectPathFromFile(filePath),
      name: inferredName,
      preview: facts.preview.slice(0, 160),
      updatedAt: version.mtimeMs,
      messageCount: facts.messageCount,
      source: facts.source,
      codexSessionId: facts.codexSessionId,
      codexThreadSource: facts.codexThreadSource,
      codexParentThreadId: facts.codexParentThreadId,
      codexAgentRole: facts.codexAgentRole,
      codexAgentNickname: facts.codexAgentNickname,
      parentSessionPath,
      // 标记 WSL 来源，供 rename/delete/copy/readMessages 等操作识别
      wsl: isWsl || undefined,
      // 部分行损坏时标记 degraded，供 UI 提示 messageCount/预览可能不完整。
      degraded: facts.malformedLines > 0 ? true : undefined,
    };
    this.summaryCache.set(filePath, version, summary);
    return summary;
  }

  /** 应用退出前刷盘，保证本轮扫描结果可被下次启动复用；超时即放弃，不阻塞退出。 */
  async flushSummaryCache(): Promise<void> {
    await Promise.all([
      this.summaryCache.flushWithTimeout(),
      this.projectMatchCache.flushWithTimeout(),
    ]);
  }

  private async readCodexThreadInfo(sourcePath: string) {
    try {
      const root = this.normalize(this.codexRoot);
      const target = this.normalize(sourcePath);
      if (target !== root && !target.startsWith(`${root}/`)) return undefined;
      // 与 omp 会话共用同一条读取/解析管线；codex 的 session_meta 只出现在头部若干行。
      const file = await readEntries(this.fileAdapter, sourcePath);
      for (const entry of file.entries.slice(0, 16)) {
        if (!isJsonRecord(entry) || entry.type !== "session_meta") continue;
        const payload = isJsonRecord(entry.payload) ? entry.payload : undefined;
        if (payload) return getCodexSessionThreadInfo(payload);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private cleanTitle(value?: string) {
    const text = value?.replace(/\s+/g, " ").trim();
    if (!text || /^untitled$/i.test(text)) return undefined;
    return text.length > 32 ? `${text.slice(0, 32)}…` : text;
  }

  private inferProjectPathFromFile(filePath: string) {
    const normalized = filePath.replace(/\\/g, "/");
    // 默认布局：~/.omp/agent/sessions/<encoded-cwd>/...
    const marker = "/.omp/agent/sessions/";
    const index = normalized.toLowerCase().indexOf(marker);
    if (index !== -1) {
      const encoded = normalized.slice(index + marker.length).split("/")[0];
      return this.decodeSessionDir(encoded);
    }
    // 常见项目级 sessionDir：<project>/.omp/sessions/...
    const customMarker = "/.omp/sessions/";
    const customIndex = normalized.toLowerCase().lastIndexOf(customMarker);
    if (customIndex !== -1) {
      return this.normalize(normalized.slice(0, customIndex));
    }
    return undefined;
  }

  /** 找到包含 filePath 的最近（最长路径）扫描根。 */
  private findSessionsRootForFile(filePath: string): string {
    const normalizedFile = this.normalize(filePath);
    const roots = this.activeScanRoots.length > 0
      ? this.activeScanRoots
      : [this.defaultSessionsRoot];

    let bestRoot = this.defaultSessionsRoot;
    let bestLen = -1;
    for (const root of roots) {
      const normalizedRoot = this.normalize(root);
      if (
        normalizedFile === normalizedRoot ||
        normalizedFile.startsWith(`${normalizedRoot}/`)
      ) {
        if (normalizedRoot.length > bestLen) {
          bestRoot = root;
          bestLen = normalizedRoot.length;
        }
      }
    }
    return bestRoot;
  }

  private decodeSessionDir(encoded: string) {
    // pi 会把 cwd 存成 --C--Users-name-project--（Windows）或 --mnt-c-Users-name-project--（WSL）等目录名；
    // 这里只用于展示和匹配，不写回 session。
    const trimmed = encoded.replace(/^--|--$/g, "");
    // WSL /mnt/ 路径：--mnt-c-Users-...--
    if (trimmed.startsWith("mnt-")) {
      return "/" + trimmed.replace(/-/g, "/");
    }
    // Windows 路径：--C--Users-...--
    const drive = trimmed.match(/^([A-Za-z])--(.+)$/);
    if (drive) return `${drive[1]}:/${drive[2].replace(/-/g, "/")}`.replace(/\//g, "\\");
    // 其他 Linux/WSL 路径
    return trimmed.replace(/-/g, "/");
  }

  private async isSameProject(summary: SessionSummary, projectPath: string, signal?: AbortSignal) {
    const normalizedProject = this.normalize(projectPath);
    const normalizedSessionProject = summary.projectPath ? this.normalize(summary.projectPath) : "";
    if (normalizedSessionProject === normalizedProject) return true;
    if (await this.isParentSessionForProject(normalizedSessionProject, normalizedProject, summary.filePath, signal)) return true;

    // 项目级自定义 sessionDir（如 <project>/.omp/sessions）下的文件默认归属该项目。
    // 该布局不再使用 encoded-cwd 子目录，safePathToken 无法从路径反推项目。
    if (this.isUnderProjectSessionDir(summary.filePath, projectPath)) return true;

    const filePathMatch = this.normalize(summary.filePath).includes(this.safePathToken(projectPath));
    if (!filePathMatch && summary.parentSessionPath) {
    }
    return filePathMatch;
  }

  /**
   * 判断会话文件是否位于项目的自定义 sessionDir 扫描根下。
   * activeScanRoots 中除默认全局根外的目录即配置的 sessionDir。
   */
  private isUnderProjectSessionDir(filePath: string, projectPath: string): boolean {
    const normalizedFile = this.normalize(filePath);
    const defaultRoot = this.normalize(this.defaultSessionsRoot);
    const normalizedProject = this.normalize(projectPath);
    for (const root of this.activeScanRoots) {
      const normalizedRoot = this.normalize(root);
      if (normalizedRoot === defaultRoot) continue;
      if (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)) {
        // 相对 sessionDir 通常落在项目目录内；绝对共享目录仍靠 cwd 过滤。
        if (normalizedRoot === normalizedProject || normalizedRoot.startsWith(`${normalizedProject}/`)) {
          return true;
        }
      }
    }
    return false;
  }

  private async isParentSessionForProject(sessionProject: string, projectPath: string, filePath: string, signal?: AbortSignal) {
    // 早期用户常在 home 目录启动 pi 再操作子项目；这类历史 session 的 cwd 是父目录，
    // 但文件内容可能明确提到当前项目。仅对父目录 session 做内容校验，避免把无关 home 会话全部展示到子项目下。
    if (!sessionProject || !projectPath.startsWith(`${sessionProject}/`)) return false;
    let version: FileVersion;
    try {
      version = await this.fileAdapter.stat(filePath, signal);
    } catch {
      return false;
    }
    const matches = this.projectMatchCache.get(filePath, version);
    const cached = matches?.[projectPath];
    if (cached !== undefined) return cached;
    let matched: boolean;
    try {
      // 只需要子串命中，不需要逐行 JSON.parse：直接整读原文（BOM/UTF-16 文件在扫描摘要阶段
      // 已被判为不可读并隐藏，不会走到这里），比 readEntries 少一次全文解析。
      const raw = await this.fileAdapter.read(filePath, signal);
      matched = raw.replace(/\\/g, "/").toLowerCase().includes(projectPath);
    } catch {
      // 读取失败（含扫描取消）：按不匹配处理但不落缓存，下次扫描重试，避免瞬时错误把会话永久隐藏。
      return false;
    }
    // 同一文件对多个项目各存一个布尔；版本未变即可跨重启复用。
    this.projectMatchCache.set(filePath, version, { ...matches, [projectPath]: matched });
    return matched;
  }

  private normalize(path: string) {
    return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  private safePathToken(path: string) {
    const normalized = path.replace(/\\/g, "/");
    const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
    if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`.toLowerCase();
    return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`.toLowerCase();
  }
}
