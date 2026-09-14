import { open, readFile, stat } from "node:fs/promises";

import type { FileVersion } from "../fs/adapters/fileAdapter";

/**
 * 会话条目读取模块 —— 会话 JSONL「读取 → 解码 → 逐行解析」的唯一实现。
 *
 * 设计动机（deep module）：
 *   - 迁移前同一件事有三套实现：SessionScanner.readSummary/readCachedText（自带 BOM 守卫）、
 *     SessionFileOps.readMessages/readSessionMeta（无守卫）、SessionJsonl.readDisplayMessages/
 *     parseArchives（无守卫）。编码差异只在其中一条路径被处理，UTF-8 BOM 文件在另外两条
 *     路径上首行解析失败、UTF-16 文件则在三条路径上表现互不一致。
 *   - 查看器路径此前没有任何字节上限：40MB 的 JSONL 会被整份读进主进程再逐行 JSON.parse。
 *     这里把「字节预算 → 截断到完整行 → 指纹」作为读取的一等公民，调用方只消费结果。
 *
 * 依赖方向：除 node:fs 的定位读外不依赖任何模块；FileAdapter（本地/WSL）在结构上即满足
 * SessionEntriesIo，因此扫描与文件操作两侧直接传入适配器，测试可注入计字节的假 IO。
 */

/** 编码嗅探窗口（字符）：UTF-16 按 utf8 解码后前 4KB 必然出现 NUL，足够判型。 */
const ENCODING_SNIFF_CHARS = 4096;

/** 尾窗读取初始窗口：大会话只需读末尾 ~1MB 即可覆盖最近几十轮对话。 */
const TAIL_READ_INITIAL_BYTES = 1024 * 1024;

/** 尾窗读取总窗口上限：单行 JSON（巨型工具结果）超过此值时不再扩展。 */
export const TAIL_READ_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 会话读取默认字节预算：与 AgentManager 的 MAX_AUTO_HISTORY_LOAD_BYTES 同量级（5MB）。
 * 超过这个体积的会话本来就不会被自动加载，读取接口按同一上限收敛，避免另一条路径
 * （查看器）把同一份巨型文件整读进内存。
 */
export const SESSION_READ_MAX_BYTES = 5 * 1024 * 1024;

/** 全量/头部读取端口。FileAdapter 结构上即满足本接口（read/readHead/stat 签名一致）。 */
export interface SessionEntriesIo {
  read(path: string, signal?: AbortSignal): Promise<string>;
  readHead(path: string, maxBytes: number, signal?: AbortSignal): Promise<string>;
  stat(path: string, signal?: AbortSignal): Promise<FileVersion>;
}

/**
 * 尾窗读取端口：额外需要「按字节定位读」。
 * 只有本地 host 路径的读取方（SessionJsonl 的尾窗家族）实现它——WSL 适配器每次定位读
 * 都要 spawn 一个 wsl.exe，而尾窗读取本来就是为「单文件几十 MB」的本地会话准备的。
 */
export interface SessionTailEntriesIo extends SessionEntriesIo {
  readRange(path: string, start: number, length: number): Promise<string>;
}

/** 读取结果：调用方只消费这里，不再自己 split/parse。 */
export interface SessionEntriesFile {
  /** 逐行 JSON.parse 成功的值（含非对象 JSON，调用方按需收窄） */
  entries: unknown[];
  /** 解码后的原文（截断时只含完整行；不可读时为空串） */
  raw: string;
  /** 是否受字节预算/尾窗限制丢掉了部分内容 */
  truncated: boolean;
  /** mtimeMs + size：调用方缓存的失效键 */
  fingerprint: FileVersion;
  /** UTF-16/二进制等非 JSONL 文本：真时 entries 为空，调用方应按「不可读」处理而不是空会话 */
  unreadable: boolean;
  /** 解析失败的行数：>0 时调用方可标记 degraded */
  malformedLines: number;
}

export interface ReadEntriesOptions {
  /** 字节预算；超过时只读头部并截断到最后一个完整行 */
  maxBytes?: number;
  /** 调用方已拿到的指纹（扫描管线批量预取），提供时跳过本次 stat */
  fingerprint?: FileVersion;
  signal?: AbortSignal;
}

export interface ReadTailEntriesOptions {
  /** 至少收集多少完整行（不足时按 2x 向前扩展窗口） */
  minLines: number;
  /** 尾窗总上限：单行 JSON 超过它时不再扩展 */
  maxBytes: number;
}

/**
 * 编码守卫：剥 UTF-8 BOM，并把非 JSONL 文本判为不可读。
 *
 * BOM 只在文件首字符出现，但会让首行 JSON.parse 失败——会话头信息（name/cwd 等）随之丢失，
 * 所以三条读取路径都必须先剥离（此前只有 SessionScanner 做）。
 *
 * UTF-16 等双字节编码按 utf8 解码后几乎必然出现 NUL 字节，且每行都无法解析；这类文件不是
 * 合法 JSONL，直接判定不可读并隐藏，避免显示成「空会话」的幽灵条目。
 */
function decodeSessionText(raw: string): { text: string; unreadable: boolean } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.slice(0, ENCODING_SNIFF_CHARS).includes("\u0000")) {
    return { text: "", unreadable: true };
  }
  return { text, unreadable: false };
}

/**
 * 逐行解析：跳过空行、隔离单行解析失败。
 * 单行 JSON 损坏（进程中断导致的截断写入、并发写竞争）不应拖垮整个会话，
 * 因此失败只计数不抛出，由调用方决定是否隐藏/标记 degraded。
 */
export function parseSessionText(raw: string): {
  entries: unknown[];
  malformedLines: number;
  unreadable: boolean;
  text: string;
} {
  const decoded = decodeSessionText(raw);
  if (decoded.unreadable) {
    return { entries: [], malformedLines: 0, unreadable: true, text: "" };
  }
  const entries: unknown[] = [];
  let malformedLines = 0;
  for (const line of decoded.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      malformedLines += 1;
    }
  }
  return { entries, malformedLines, unreadable: false, text: decoded.text };
}

/**
 * JSONL 行解析结果的最小对象形状守卫：保留 unknown 收窄，调用方逐字段检查，
 * 不做内联断言式的成员访问（行是外部持久化数据，字段类型不可信）。
 */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 读取整份文件（或预算内的头部），返回解析结果与指纹。 */
export async function readEntries(
  io: SessionEntriesIo,
  filePath: string,
  options: ReadEntriesOptions = {},
): Promise<SessionEntriesFile> {
  const fingerprint = options.fingerprint ?? (await io.stat(filePath, options.signal));
  const budget = options.maxBytes;
  if (budget !== undefined && fingerprint.size > budget) {
    // 超预算只读头部，并回退到最后一个完整行：半个 JSON 行既解析不出来，
    // 又会被调用方当成损坏行计数，截断必须在行边界发生。
    const head = await io.readHead(filePath, budget, options.signal);
    const lastBreak = head.lastIndexOf("\n");
    const parsed = parseSessionText(lastBreak >= 0 ? head.slice(0, lastBreak + 1) : "");
    return {
      entries: parsed.entries,
      raw: parsed.text,
      truncated: true,
      fingerprint,
      unreadable: parsed.unreadable,
      malformedLines: parsed.malformedLines,
    };
  }
  const parsed = parseSessionText(await io.read(filePath, options.signal));
  return {
    entries: parsed.entries,
    raw: parsed.text,
    truncated: false,
    fingerprint,
    unreadable: parsed.unreadable,
    malformedLines: parsed.malformedLines,
  };
}

/**
 * 从文件尾部读取最近若干完整行（含文件末尾未换行的残行，与旧整文件 split 行为一致）。
 * 窗口不足时按 2x 向前扩展，直到收集够 minLines 或到达文件头 / 达到 maxBytes 上限。
 * 窗口首行若从字节中部开始（UTF-8 多字节字符可能被截断），整行丢弃——该行必然不是
 * 我们需要的尾部最近行，且避免了解码损坏。
 */
export async function readTailEntries(
  io: SessionTailEntriesIo,
  filePath: string,
  options: ReadTailEntriesOptions,
): Promise<SessionEntriesFile> {
  const fingerprint = await io.stat(filePath);
  const size = fingerprint.size;
  const empty: SessionEntriesFile = {
    entries: [],
    raw: "",
    truncated: false,
    fingerprint,
    unreadable: false,
    malformedLines: 0,
  };
  if (size === 0) return empty;

  const limit = Math.min(size, options.maxBytes);
  let readSize = Math.min(TAIL_READ_INITIAL_BYTES, limit);
  for (;;) {
    const start = size - readSize;
    const text = await io.readRange(filePath, start, readSize);
    const firstBreak = text.indexOf("\n");
    // 窗口内首个换行之前的部分可能跨窗口边界（不完整行），丢弃；
    // 整个文件就是一个超长行时（start===0），它就是唯一且完整的行。
    const completeFrom = firstBreak === -1 ? (start === 0 ? 0 : -1) : firstBreak + 1;
    if (completeFrom >= 0) {
      const window = text.slice(completeFrom);
      // 已确认完整的行数（最后一段可能残，不计数）
      const completeCount = window.split("\n").length - 1;
      if (start === 0 || completeCount >= options.minLines || readSize >= limit) {
        const parsed = parseSessionText(window);
        return {
          entries: parsed.entries,
          raw: parsed.text,
          // start > 0 说明文件头部还有更早的内容没有进窗口
          truncated: start > 0,
          fingerprint,
          unreadable: parsed.unreadable,
          malformedLines: parsed.malformedLines,
        };
      }
    }
    const nextSize = Math.min(readSize * 2, limit);
    if (nextSize <= readSize) return empty;
    readSize = nextSize;
  }
}

/**
 * node:fs 端口实现（本地 host 路径）：SessionJsonl 的整读/头读/尾窗读共用。
 * readRange 用定位读而不是「全量读后 slice」，尾窗读取才不会把整个文件读进内存。
 */
export const nodeEntriesIo: SessionTailEntriesIo = {
  read: (path) => readFile(path, "utf8"),
  readHead: async (path, maxBytes) => {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  },
  stat: async (path) => {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  },
  readRange: async (path, start, length) => {
    if (length <= 0) return "";
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  },
};
