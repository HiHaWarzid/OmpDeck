/**
 * 会话扫描的指纹缓存：内存 + 磁盘双层。
 *
 * - 命中条件：文件路径 + 版本（mtimeMs + size）
 * - 运行期内用 Map 加速周期扫描
 * - 重启后从 userData 磁盘缓存恢复，避免全量重读 JSONL
 * - 写盘采用 debounce + 原子 rename，失败静默（缓存失效只是慢，不能影响主流程）
 *
 * 泛型 V 供不同派生数据复用（摘要、项目匹配布尔等），各自使用独立缓存文件。
 */

import { app } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renameWithRetry } from "../utils/fsRetry";

export interface SessionFileVersion {
  mtimeMs: number;
  size: number;
}

interface CacheEntry<V> {
  version: SessionFileVersion;
  value: V;
}

interface DiskCacheFile<V> {
  /** schema 版本，不兼容时整表丢弃 */
  version: number;
  entries: Record<string, CacheEntry<V>>;
}

/**
 * 磁盘缓存 schema 版本：不兼容时整表丢弃（见 loadFromDisk）。
 * 2：修复 Windows 本地子会话父路径推断（posix 函数误用于反斜杠路径），
 *    旧缓存中的摘要缺失 parentSessionPath 且不会因文件未变而重推断，必须丢弃重建。
 * 3：子会话无显式标题时改用文件名作为名字（此前退化成 task 工具固定前缀的首条消息，
 *    整组子会话同名无法区分）；旧缓存里的名字不会因文件未变而重推断，必须丢弃重建。
 */
const DISK_SCHEMA_VERSION = 3;
const SAVE_DEBOUNCE_MS = 2_000;

export class SessionSummaryCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly filePath: string;
  private dirty = false;
  /**
   * dirty 代数：写盘是异步的，快照之后的 set/prune 不能被本次成功写盘清掉 dirty，
   * 否则这些新条目要等到下一次写入才会落盘。捕获开始时的代数即可判断。
   */
  private dirtyGeneration = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private saving: Promise<void> | null = null;

  constructor(fileName = "session-summary-cache.json") {
    this.filePath = join(app.getPath("userData"), fileName);
  }

  /** 启动时加载磁盘缓存；可重复调用，只执行一次 */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFromDisk()
      .catch(() => {
        // 损坏/缺失都当冷启动，不阻塞扫描
      })
      .finally(() => {
        this.loaded = true;
      });
    return this.loadPromise;
  }

  get(filePath: string, version: SessionFileVersion): V | undefined {
    const entry = this.store.get(filePath);
    if (!entry) return undefined;
    if (
      entry.version.mtimeMs !== version.mtimeMs ||
      entry.version.size !== version.size
    ) {
      this.store.delete(filePath);
      this.markDirty();
      return undefined;
    }
    return entry.value;
  }

  set(filePath: string, version: SessionFileVersion, value: V): void {
    const prev = this.store.get(filePath);
    // 内容与版本都相同则跳过，减少无意义写盘
    if (
      prev &&
      prev.version.mtimeMs === version.mtimeMs &&
      prev.version.size === version.size &&
      prev.value === value
    ) {
      return;
    }
    this.store.set(filePath, { version, value });
    this.markDirty();
  }

  /**
   * 只修剪“当前环境”下已消失的条目。
   * - local：只动 Windows 路径缓存，保留 WSL 路径
   * - wsl：只动 Linux 路径缓存，保留 Windows 路径
   * 这样切换 WSL/本地时不会互相踩盘。
   */
  prune(keepPaths: Iterable<string>, mode: "local" | "wsl" = "local"): void {
    const keep = new Set(keepPaths);
    let removed = false;
    for (const key of this.store.keys()) {
      const isWslPath = key.startsWith("/") && !/^[A-Za-z]:/.test(key);
      if (mode === "local" && isWslPath) continue;
      if (mode === "wsl" && !isWslPath) continue;
      if (!keep.has(key)) {
        this.store.delete(key);
        removed = true;
      }
    }
    if (removed) this.markDirty();
  }

  /**
   * 清空内存缓存。
   * persist=true 时同步写空盘；WSL 切换等场景应传 false，避免误删另一环境磁盘缓存。
   */
  clear(options?: { persist?: boolean }): void {
    if (this.store.size === 0) return;
    this.store.clear();
    if (options?.persist) this.markDirty();
  }

  /** 丢弃内存态并允许重新从磁盘加载（用于环境切换后恢复对应环境缓存）。 */
  async reloadFromDisk(): Promise<void> {
    this.store.clear();
    this.loaded = false;
    this.loadPromise = null;
    await this.ensureLoaded();
  }

  /** 立即刷盘（应用退出前可调用） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
  }

  /**
   * 带超时的刷盘：退出流程不能因为磁盘慢/被杀软锁住而无限等待。
   * 超时后底层写入仍可能在后台完成，但调用方已解挂；缓存写丢只影响下次启动的扫描速度。
   */
  async flushWithTimeout(ms = 2_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.dirtyGeneration += 1;
    // 非重置式 debounce：只有第一个 dirty 调度刷盘，写盘窗口内的后续 set() 不再推迟计时。
    // 重置式 debounce 在持续扫描（每轮都有 set/prune）时可能永远等不到 2s 静默窗口。
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveToDisk();
    }, SAVE_DEBOUNCE_MS);
    // 防止 Node 因 timer 挂起进程；Electron 主进程通常不需要，但更安全
    this.saveTimer.unref?.();
  }

  private async loadFromDisk(): Promise<void> {
    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as DiskCacheFile<V>;
    if (!parsed || parsed.version !== DISK_SCHEMA_VERSION || !parsed.entries) {
      return;
    }
    for (const [path, entry] of Object.entries(parsed.entries)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !entry.version ||
        typeof entry.version.mtimeMs !== "number" ||
        typeof entry.version.size !== "number"
      ) {
        continue;
      }
      this.store.set(path, entry);
    }
  }

  private async saveToDisk(): Promise<void> {
    if (!this.dirty) return;
    // 串行化写盘，避免并发 rename 踩踏
    if (this.saving) {
      await this.saving;
      if (!this.dirty) return;
    }
    this.saving = this.writeAtomic().finally(() => {
      this.saving = null;
    });
    await this.saving;
  }

  private async writeAtomic(): Promise<void> {
    // 快照在当前 tick 内同步完成，先记下代数：写盘期间新增的 dirty 不能被本次成功清除。
    const generationAtSnapshot = this.dirtyGeneration;
    try {
      const entries: Record<string, CacheEntry<V>> = {};
      for (const [path, entry] of this.store) {
        entries[path] = entry;
      }
      const payload: DiskCacheFile<V> = {
        version: DISK_SCHEMA_VERSION,
        entries,
      };
      const dir = dirname(this.filePath);
      await mkdir(dir, { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmpPath, JSON.stringify(payload), "utf8");
      // Windows 杀软/云同步可能瞬时锁住刚写出的 tmp，rename 走退避重试避免误判失败
      await renameWithRetry(tmpPath, this.filePath);
      if (this.dirtyGeneration === generationAtSnapshot) this.dirty = false;
    } catch {
      // 写盘失败保留 dirty，下次 set/flush 再试
    }
  }
}
