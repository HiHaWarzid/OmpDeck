import { app } from "electron";
import { appendFile, mkdir, open, readdir, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

const MAX_LIVE = 200;
/** 写入文件时 data 字段 JSON 序列化后的最大字节数，超过则截断 */
const MAX_DATA_BYTES = 2_048;
/** 日志文件保留天数，超过自动删除 */
const RETENTION_DAYS = 30;
/** getFromFile 单文件尾部读取上限：查询只要最近 limit 条，不必整读 30MB+ 文件 */
const GET_TAIL_BYTES = 4 * 1024 * 1024;
/** 待写队列的序列化字节上限：RPC 洪峰时丢弃新条目，避免日志本身把主进程内存打爆 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

function formatDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface RpcLogEntry {
  id: string;
  agentId: string;
  direction: string;
  summary: string;
  time: number;
  data?: unknown;
}

/**
 * RPC 日志服务。
 * - 按 Agent 分文件：userData/logs/rpc/rpc-<agentId>-YYYY-MM-DD.jsonl
 * - 写入时截断大 data（超过 2KB 脱敏保存），大幅减少文件体积
 * - 首次写入前 + 每次跨日：把非当日文件 gzip，并清理超过 30 天的文件
 * - 保持小型环形缓冲区（200 条）供实时展示
 */
export class RpcLogger {
  /** RPC 日志独立子目录，不和 app 日志混在一起 */
  private readonly dir = join(app.getPath("userData"), "logs", "rpc");
  private live: RpcLogEntry[] = [];
  /** 最近写入的日期，用于触发跨日 gzip */
  private lastWriteDate = "";
  /** 首次写入前执行的目录收尾（补压缩遗留日志 + 清过期文件），只调度一次 */
  private sweepPromise: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * 有界写入队列。此前每 push 一次就串一条 `.then()`，RPC 洪峰下队列长度和已序列化
   * 字符串都无上限；这里改为数组 + 单条 drain 循环，并按字节数封顶。
   */
  private pendingWrites: Array<{ filePath: string; line: string; bytes: number }> = [];
  private pendingBytes = 0;
  private draining = false;
  /** 本轮队列溢出期间被丢弃的条目数；只打印一次聚合告警，避免刷屏。 */
  private droppedEntries = 0;
  private dropWarningLogged = false;

  /** 写入一条 RPC 日志，同时追加到文件与环形缓冲区 */
  push(entry: RpcLogEntry) {
    // 环形缓冲区：保留最近 MAX_LIVE 条
    if (this.live.length >= MAX_LIVE) {
      this.live.splice(0, this.live.length - MAX_LIVE + 1);
    }
    this.live.push(entry);
    this.ensureInitialized();

    // 先序列化再入队：队列字节数就是真实待写体积，超限时直接丢弃，避免积压无限增长。
    let line: string;
    try {
      line = this.serializeEntry(entry);
    } catch (error) {
      // 旧实现把序列化放在异步写链里，异常不会回抛给 RPC 调用方；这里保持同样的容错，
      // 否则一条含循环引用等非法 data 的日志就能打断正在处理的 RPC。
      console.warn("Failed to serialize RPC log entry:", error);
      line = JSON.stringify({ ...entry, data: { _unserializable: true } });
    }
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (this.pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.droppedEntries += 1;
      // 每个溢出周期只告警一次；具体丢弃条数在队列排空时聚合上报。
      if (!this.dropWarningLogged) {
        this.dropWarningLogged = true;
        console.warn(`RPC log write queue exceeded ${MAX_PENDING_BYTES} bytes; dropping new entries`);
      }
      return;
    }

    const safeAgentId = this.sanitizeAgentId(entry.agentId);
    const dateStr = formatDate(new Date(entry.time));

    // 跨日：把此前所有非当日的 .jsonl 补压缩（含本次运行开始前就遗留的），顺带清过期文件。
    if (this.lastWriteDate && this.lastWriteDate !== dateStr) this.scheduleSweep();
    this.lastWriteDate = dateStr;

    this.pendingWrites.push({
      filePath: join(this.dir, `rpc-${safeAgentId}-${dateStr}.jsonl`),
      line,
      bytes,
    });
    this.pendingBytes += bytes;
    this.startDrain();
  }

  /** 启动单条 drain 循环；已在 drain 时直接返回，避免 promise 链随写入量增长。 */
  private startDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.writeQueue = this.drainPending()
      .catch((error) => {
        console.warn("Failed to write RPC log:", error);
      })
      .finally(() => {
        this.draining = false;
        // 安全网：drain 收尾与 finally 之间若恰好有新 push，重新启动，避免条目滞留。
        if (this.pendingWrites.length > 0) this.startDrain();
      });
  }

  /** 顺序写队列（分批次处理，避免 shift 的 O(n²) 移动）。 */
  private async drainPending(): Promise<void> {
    // 目录一次建好；即使创建失败也继续尝试 append，由单条 catch 记录错误。
    await mkdir(this.dir, { recursive: true }).catch(() => undefined);
    while (this.pendingWrites.length > 0) {
      const batch = this.pendingWrites;
      this.pendingWrites = [];
      for (const item of batch) {
        this.pendingBytes -= item.bytes;
        try {
          await appendFile(item.filePath, `${item.line}\n`, "utf8");
        } catch (error) {
          console.warn("Failed to write RPC log:", error);
        }
      }
    }
    if (this.droppedEntries > 0) {
      // 队列排空后一次性上报本轮丢弃量，恢复告警状态供下一轮溢出使用。
      console.warn(`Dropped ${this.droppedEntries} RPC log entries due to full write queue`);
      this.droppedEntries = 0;
      this.dropWarningLogged = false;
    }
  }

  /** 获取实时缓冲区（最近 MAX_LIVE 条） */
  getLive(): RpcLogEntry[] {
    return [...this.live];
  }

  /**
   * 从文件读取日志。
   * 按 agentId 和日期范围过滤，倒序返回最近 limit 条。
   * 只读取未压缩的 .jsonl 文件（当天和近期尚未 gzip 的），跨日文件已被 gzip，不影响最近 7 天查询。
   *
   * 只读每个文件的尾部字节：查询只要最近 limit 条，而单份文件可达 37MB（8.7 万行），
   * 整读 + `split` + `push(...arr)` 会让主进程瞬时多出两份 37MB 字符串和 8.7 万元素数组
   * （spread 传参还有 V8 参数上限 RangeError 的风险）。
   */
  async getFromFile(options?: {
    agentId?: string;
    days?: number;
    limit?: number;
  }): Promise<RpcLogEntry[]> {
    await mkdir(this.dir, { recursive: true });
    const limit = Math.max(1, Math.min(options?.limit ?? 5000, 10000));
    const days = Math.max(1, options?.days ?? 7);

    // 按文件内日期倒序取最近 days 个日期；原来按文件名排序等于先按 agentId 排，取到的不是最近几天。
    const files = (await this.listFiles(options?.agentId, ".jsonl"))
      .map((name) => ({ name, date: name.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1] ?? "" }))
      .filter((item) => item.date)
      .sort((a, b) =>
        a.date === b.date ? b.name.localeCompare(a.name) : a.date < b.date ? 1 : -1,
      );
    const recentDates = [...new Set(files.map((item) => item.date))].slice(0, days);

    const lines: string[] = [];
    for (const date of recentDates) {
      for (const file of files) {
        if (file.date !== date) continue;
        const raw = await this.readTail(join(this.dir, file.name));
        const fileLines = raw.split(/\r?\n/).filter(Boolean);
        for (let i = fileLines.length - 1; i >= 0 && lines.length < limit; i -= 1) {
          lines.push(fileLines[i]);
        }
        if (lines.length >= limit) break;
      }
      if (lines.length >= limit) break;
    }

    return lines
      .slice(0, limit)
      .map((line) => {
        try { return JSON.parse(line) as RpcLogEntry; }
        catch { return null; }
      })
      .filter((e): e is RpcLogEntry => Boolean(e));
  }

  /** 读取文件尾部最多 GET_TAIL_BYTES 字节；从中间截断时丢掉不完整的首行。 */
  private async readTail(filePath: string): Promise<string> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(filePath, "r");
      const { size } = await handle.stat();
      const start = Math.max(0, size - GET_TAIL_BYTES);
      const length = size - start;
      if (length <= 0) return "";
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const text = buffer.toString("utf8");
      if (start === 0) return text;
      const firstNewline = text.indexOf("\n");
      return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** 获取 RPC 日志文件总大小（字节），可选按 agentId 过滤，含 gzip 文件 */
  async getSize(agentId?: string): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    const files = await this.listFiles(agentId);
    let total = 0;
    for (const file of files) {
      try {
        const s = await stat(join(this.dir, file));
        total += s.size;
      } catch { /* skip */ }
    }
    return total;
  }

  /** 清空 RPC 日志文件，可选按 agentId 过滤，含 gzip 文件 */
  async clear(agentId?: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const files = await this.listFiles(agentId);
    await Promise.all(
      files.map((file) => unlink(join(this.dir, file)).catch(() => undefined)),
    );
    if (agentId) {
      this.live = this.live.filter((e) => e.agentId !== agentId);
    } else {
      this.live = [];
    }
  }

  /** 将 agentId 中的不安全字符替换掉，避免跨目录访问 */
  private sanitizeAgentId(id: string): string {
    return id.replace(/[^\w-.~]/g, "_");
  }

  // ── 文件管理 ──

  /** 列出匹配的文件（默认同时匹配 .jsonl 和 .jsonl.gz）；异步 readdir，避免阻塞主进程。 */
  private async listFiles(agentId?: string, ext?: ".jsonl" | ".gz"): Promise<string[]> {
    // 硬读目录，不缓存，保证各方法拿到最新文件列表
    const files: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return files; // 目录不存在时返回空列表
    }
    for (const entry of entries) {
      // 只匹配 rpc-<agentId>-YYYY-MM-DD.jsonl 或 .jsonl.gz
      if (!/^rpc-[\w-]+-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(entry)) continue;
      if (agentId) {
        const prefix = `rpc-${this.sanitizeAgentId(agentId)}-`;
        if (!entry.startsWith(prefix)) continue;
      }
      if (ext === ".jsonl" && entry.endsWith(".gz")) continue;
      if (ext === ".gz" && !entry.endsWith(".gz")) continue;
      files.push(entry);
    }
    return files;
  }

  /** 删除超过保留天数的文件 */
  private async cleanOldFiles() {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const files = await this.listFiles();
    for (const file of files) {
      // 从文件名提取日期：rpc-<agentId>-YYYY-MM-DD.jsonl(.gz)?
      const match = file.match(/-(\d{4}-\d{2}-\d{2})\.jsonl/);
      if (!match) continue;
      const fileDate = new Date(match[1] + "T00:00:00Z").getTime();
      if (!isNaN(fileDate) && fileDate < cutoff) {
        await unlink(join(this.dir, file)).catch(() => undefined);
      }
    }
  }

  /** 将指定文件 gzip 压缩，压缩后删除原文件 */
  private async gzipFile(filePath: string) {
    const gzPath = filePath + ".gz";
    try {
      await pipeline(
        createReadStream(filePath),
        createGzip(),
        createWriteStream(gzPath),
      );
      await unlink(filePath).catch(() => undefined);
    } catch {
      await unlink(gzPath).catch(() => undefined);
    }
  }

  // ── 写入 ──

  /**
   * 目录级收尾：补压缩历史遗留的未压缩 .jsonl + 清理过期文件。
   *
   * 为什么不能只在跨日分支里做：原来的跨日 gzip 依赖 `lastWriteDate`（本次运行首次写的日期），
   * 进程重启后它等于当天日期，昨天的文件永远不会被压缩；清理还被 `Math.random() < 0.01`
   * 概率门控，可能整天不触发。实测 2026-10-16：目录里 33 个历史 .jsonl 未压缩，共 428MB
   * （gz 只有 102MB），整个 rpc 目录 837MB。改为「首次写入前 + 每次跨日」确定性执行，
   * 两个触发点都幂等（已压缩文件不在 .jsonl 列表里）。
   */
  private async initialize(): Promise<void> {
    const today = formatDate(new Date());
    const stale = (await this.listFiles(undefined, ".jsonl")).filter(
      (file) => !file.includes(`-${today}.jsonl`),
    );
    for (const file of stale) {
      await this.gzipFile(join(this.dir, file)).catch(() => undefined);
    }
    await this.cleanOldFiles().catch(() => undefined);
  }

  /** 首次写入前调度一次收尾，之后不再重复调度。 */
  private ensureInitialized(): void {
    if (!this.sweepPromise) this.scheduleSweep();
  }

  /**
   * 后台执行收尾，不阻塞写入链。
   * 首次升级启动可能要压缩 400MB+ 遗留日志（十几秒 IO）；写入链是内存里的 promise 队列，
   * 没有理由陪它一起等——压不动也只是占用磁盘，不影响正确性。
   */
  private scheduleSweep(): Promise<void> {
    this.sweepPromise = this.initialize().catch(() => undefined);
    return this.sweepPromise;
  }

  /**
   * 把 entry 转成最终写入的 JSONL 行。
   * data 只序列化一次：同一个字符串既用于判断是否需要截断，也直接拼进最终行，
   * 避免旧实现里「探测序列化一次 + 写盘再序列化一次」把数 MB 的响应处理两遍。
   */
  private serializeEntry(entry: RpcLogEntry): string {
    const serializedData = entry.data === undefined ? undefined : JSON.stringify(entry.data);
    const safeEntry = this.truncateData(entry, serializedData);
    if (safeEntry !== entry) return JSON.stringify(safeEntry);
    if (serializedData === undefined) return JSON.stringify(entry);

    // 未截断：拆出 data 后分别序列化，复用上面的 data 字符串。
    const head = { ...entry };
    delete head.data;
    const headJson = JSON.stringify(head);
    return headJson === "{}"
      ? `{"data":${serializedData}}`
      : `${headJson.slice(0, -1)},"data":${serializedData}}`;
  }

  /** 截断 data 字段：JSON 序列化超过 MAX_DATA_BYTES 时替换为脱敏摘要。 */
  private truncateData(entry: RpcLogEntry, serializedData?: string): RpcLogEntry {
    // 处理 direction === "send" 时提取精简命令
    if (entry.direction === "send") {
      const data = entry.data as Record<string, unknown> | undefined;
      if (data?.type === "bash") {
        return {
          ...entry,
          data: { type: "bash", command: (data.command as string ?? "").slice(0, 200) },
        };
      }
    }
    // 其余大 data 通用截断：RPC 日志默认落盘后，get_messages 对大会话返回的
    // 单行响应可达数 MB，直接写入会撑爆日志文件。保留类型与顶层键名便于诊断。
    const serialized = serializedData ?? (entry.data === undefined ? undefined : JSON.stringify(entry.data));
    if (serialized && serialized.length > MAX_DATA_BYTES) {
      const data = entry.data as Record<string, unknown> | undefined;
      return {
        ...entry,
        data: {
          _truncated: true,
          type: typeof data?.type === "string" ? data.type : undefined,
          keys:
            data && typeof data === "object"
              ? Object.keys(data).slice(0, 20)
              : undefined,
          size: serialized.length,
        },
      };
    }
    return entry;
  }
}
