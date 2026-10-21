import { randomUUID } from "node:crypto";
import { shell } from "electron";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { FileAdapter } from "../fs/adapters/fileAdapter";
import { isJsonRecord, readEntries, type ReadEntriesOptions, type SessionEntriesFile } from "./sessionEntries";

/**
 * 会话文件操作模块 —— 从 SessionScanner 中抽出的纯文件操作（rename/delete/
 * readMessages/readSessionMeta/readSessionFile），与扫描管线解耦。
 *
 * 设计动机（deep module）：
 *   - SessionScanner 原本把扫描管线（collect→fingerprint→cache）、摘要打分与文件
 *     操作混在一个类里。文件操作不关心扫描/缓存/项目过滤，只依赖文件适配器与
 *     会话根路径，收拢为本模块后职责单一。
 *   - WSL/本地适配器随环境切换（configureWsl 会替换实例），因此通过 getAdapter
 *     访问器每次操作时读取当前适配器，避免持有过期实例。
 *
 * 读取半部分（解码/逐行解析/字节预算）委托给 sessionEntries 的单一实现；
 * 写入半部分（原生标题槽/title_change、回收站回退删除、modifyLines 写回）留在本模块。
 *
 * 依赖方向：不依赖 SessionScanner、不依赖 AgentManager/RPC；
 * 可在无 WSL 环境下用 stub 适配器测试。
 */

/** SessionFileOps 的注入依赖。 */
export interface SessionFileOpsDeps {
  /** 当前文件访问适配器（WSL/本地随环境切换，每次操作读取最新实例）。 */
  getAdapter: () => FileAdapter;
  /** 本地默认会话根目录（回收站降级 .trash 的存放位置）。 */
  localSessionsRoot: string;
  /** 当前环境默认会话根目录（WSL 时为 Linux 路径），删除安全防护用。 */
  getDefaultSessionsRoot: () => string;
}

/** 从 JSONL 消息 content 中提取纯文本（string | 块数组）。 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const block = item as Record<string, unknown>;
        return String(block.text ?? block.thinking ?? "");
      }
      return "";
    }).filter(Boolean).join(" ");
  }
  return "";
}

/** 归一化路径用于比较（统一分隔符、去尾部斜杠、小写），与 SessionScanner 语义一致。 */
function normalize(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * omp 会话标题槽固定宽度（字节，含换行）。
 *
 * omp 把首行标题做成定长槽位，重命名时原地覆盖这一行而不是追加历史；
 * 尺寸必须与 @oh-my-pi/pi-coding-agent 的 SESSION_TITLE_SLOT_BYTES 一致，
 * 否则 omp 读取时会认为标题行损坏并退回 session 头/首条消息。
 */
const SESSION_TITLE_SLOT_BYTES = 256;
const TITLE_SLOT_TYPE = "title";
const TITLE_CHANGE_TYPE = "title_change";

/**
 * 生成 omp 原生定长标题槽：key 顺序与 omp serializeTitleSlot 保持一致，
 * 标题按码点二分截断到能放进 256 UTF-8 字节，剩余空间用空格填在 pad 里。
 * 返回文本以换行结尾，可直接作为 JSONL 的第一行。
 */
function serializeTitleSlot(title: string, updatedAt: string): string {
  const buildLine = (value: string, pad: string) =>
    `${JSON.stringify({
      type: TITLE_SLOT_TYPE,
      v: 1,
      title: value,
      source: "user",
      updatedAt,
      pad,
    })}\n`;

  // omp 用 [...title] 按码点截断；必须同样处理，避免把代理对劈成半个字符。
  const codePoints = [...title];
  let low = 0;
  let high = codePoints.length;
  let fitted = "";
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = codePoints.slice(0, middle).join("");
    if (Buffer.byteLength(buildLine(candidate, ""), "utf8") <= SESSION_TITLE_SLOT_BYTES) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const withoutPad = buildLine(fitted, "");
  const padBytes = SESSION_TITLE_SLOT_BYTES - Buffer.byteLength(withoutPad, "utf8");
  if (padBytes < 0) throw new Error("Session title slot metadata exceeds fixed slot size");
  return buildLine(fitted, " ".repeat(padBytes));
}

/**
 * 会话读取硬上限（字节）。
 *
 * readMessages / readSessionMeta 会把整份 JSONL 解析成对象数组，再随 IPC 结构化克隆
 * 给渲染层。正常会话远小于这个量级；超过 64MB 说明文件已不是「消息时间线」而是
 * 异常数据（例如单行巨型工具输出），此时既不截断也不分页，直接抛出可读错误，
 * 让调用方看到明确失败，而不是拿到一份被静默裁剪、看起来像完整历史的列表。
 */
const SESSION_READ_HARD_MAX_BYTES = 64 * 1024 * 1024;

export class SessionFileOps {
  private readonly deps: SessionFileOpsDeps;

  constructor(deps: SessionFileOpsDeps) {
    this.deps = deps;
  }

  // ── 会话操作：rename / delete / copy / exportHtml / readMessages ─

  /**
   * 重命名会话：写 omp 原生标题（首行定长 title 槽 + 末尾 title_change 记录）。
   *
   * 历史教训：旧实现追加 pi 的 {type:"session_info"}，omp 不认这条记录，
   * 列表即时刷新只是读到了旧格式；重启/换读 omp 原生标题后就“失效”了。
   * omp 的权威标题在首行 title 槽（重命名时原地覆盖），同时追加 title_change
   * 让查看器/会话树看到变更；两者缺一不可。
   *
   * 顺带剔除旧版应用写入的 sessionName 私有行和 session_info 旧记录，
   * 迁移已被旧格式改写的会话。支持 WSL 路径。
   */
  async rename(filePath: string, newName: string): Promise<void> {
    const raw = await this.deps.getAdapter().read(filePath);
    const output = this.rewriteTitle(raw, newName);
    await this.deps.getAdapter().write(filePath, output);
  }

  /**
   * 把 JSONL 文本改写成 omp 原生标题布局，返回新文本。
   *
   * 标题槽必须位于第一行（omp 只读首行），所以这里不是简单追加：
   *   1. 丢掉旧版私有 sessionName 行与 session_info 行；
   *   2. 找到已有 title 槽就原地替换，没有就插到文件最前面；
   *   3. 若存在 session 头，同步 title/titleSource，兼容只读头部的旧查看器；
   *   4. 末尾追加 title_change，parentId 指向最后一条带 id 的记录。
   */
  private rewriteTitle(raw: string, name: string): string {
    // 与 omp 相同的清洗规则：换行折叠为空格，避免破坏 JSONL 行结构。
    const sanitized = name.replace(/[\r\n]+/g, " ").trim();
    const now = new Date().toISOString();
    const ids = new Set<string>();
    let lastId: string | null = null;
    let titleSlot: string | null = null;
    const keptLines: string[] = [];

    for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // 不可解析的行原样保留，不做破坏性清理
        keptLines.push(trimmed);
        continue;
      }
      if (!isJsonRecord(parsed)) {
        keptLines.push(trimmed);
        continue;
      }

      const type = typeof parsed.type === "string" ? parsed.type : undefined;
      // 旧版应用私有格式：带 sessionName 且无 type（会破坏 pi 首行校验）。
      if (!type && typeof parsed.sessionName === "string") continue;
      // omp 不认 session_info；旧的桌面端重命名记录在迁移时清掉。
      if (type === "session_info") continue;
      // 定长标题槽只允许一个，统一放到第一行。
      if (type === TITLE_SLOT_TYPE) {
        if (!titleSlot) titleSlot = serializeTitleSlot(sanitized, now);
        continue;
      }
      // 同步会话头标题：部分读取路径在没有标题槽时依赖这里。
      if (type === "session") {
        parsed.title = sanitized;
        parsed.titleSource = "user";
        parsed.titleUpdatedAt = now;
        keptLines.push(JSON.stringify(parsed));
      } else {
        keptLines.push(trimmed);
      }

      if (typeof parsed.id === "string" && parsed.id) {
        ids.add(parsed.id);
        lastId = parsed.id;
      }
    }

    // 标题槽固定第一行；没有就新建。
    const outputLines = [titleSlot ?? serializeTitleSlot(sanitized, now), ...keptLines];

    // 会话树 id 为 8 位十六进制；与已有 id 冲突时重试。
    let id = randomUUID().slice(-8);
    while (ids.has(id)) id = randomUUID().slice(-8);
    outputLines.push(
      JSON.stringify({
        type: TITLE_CHANGE_TYPE,
        id,
        parentId: lastId,
        timestamp: now,
        title: sanitized,
        source: "user",
      }),
    );
    return `${outputLines.join("\n")}\n`;
  }

  /**
   * 删除会话文件，同时清理同级子会话目录（如果存在）。
   *
   * 目录结构约定：父会话 <stem>.jsonl 与子会话目录 <stem>/ 相邻。
   * 删除父会话时一并移除 <stem>/ 目录及其下所有子会话 JSONL，
   * 避免残留孤儿目录。仅删除单个子会话时（无同级目录）行为不变。
   */
  async delete(filePath: string): Promise<void> {
    // 先删除同级子会话目录（如果存在），再删除文件本身
    await this.deleteSiblingDir(filePath);

    // 优先使用系统回收站（Electron shell.trashItem），避免文件永久丢失。
    // 回收站不可用时（如 Linux 部分桌面环境），fallback 到 rename 到 .trash 子目录。
    try {
      await shell.trashItem(filePath);
    } catch {
      const trashDir = join(this.deps.localSessionsRoot, ".trash");
      try {
        await mkdir(trashDir, { recursive: true });
        const trashName = `${basename(filePath)}.${Date.now()}.deleted`;
        await rename(filePath, join(trashDir, trashName));
      } catch {
        await unlink(filePath);
      }
    }
  }

  /**
   * 获取 JSONL 文件同级子会话目录路径。
   * 例如 /path/to/stem.jsonl → /path/to/stem/
   * 如果 filePath 不以 .jsonl 结尾或求得的目录与 sessions 根相同，返回 undefined。
   */
  private getSiblingDir(filePath: string): string | undefined {
    if (!filePath.toLowerCase().endsWith(".jsonl")) return undefined;
    const dir = filePath.replace(/\.jsonl$/i, "");
    // 安全防护：不删除当前环境的 sessions 根目录（WSL 用 Linux 路径，本地用 Windows 路径）
    if (normalize(dir) === normalize(this.deps.getDefaultSessionsRoot())) return undefined;
    return dir;
  }

  /** 删除同级子会话目录（如果存在） */
  private async deleteSiblingDir(filePath: string): Promise<void> {
    const siblingDir = this.getSiblingDir(filePath);
    if (!siblingDir || !(await this.deps.getAdapter().existsDir(siblingDir))) return;
    try {
      // 优先使用回收站
      await shell.trashItem(siblingDir);
    } catch {
      // 回收站不可用时直接递归删除
      try {
        await this.deps.getAdapter().rmDir(siblingDir);
      } catch {
        // 目录删除失败不阻塞文件删除
      }
    }
  }

  /** 读取会话消息列表，支持 WSL 路径 */
  async readMessages(filePath: string): Promise<Array<{ role: string; content: string; timestamp: number }>> {
    const file = await this.readSessionFileWithinLimit(filePath);
    if (file.unreadable) return [];
    const messages: Array<{ role: string; content: string; timestamp: number }> = [];
    for (const raw of file.entries) {
      if (!isJsonRecord(raw)) continue;
      const entry = raw;
      if (entry.type && entry.type !== "message") continue;
      if (entry.sessionName && !entry.message) continue;
      const nested = isJsonRecord(entry.data) ? entry.data : undefined;
      const candidate = entry.message ?? nested?.message ?? entry;
      if (!isJsonRecord(candidate)) continue;
      const message = candidate;
      if (!message.role) continue;
      const content = extractText(message.content).trim();
      if (!content) continue;
      if (message.role !== "user" && message.role !== "assistant") continue;
      messages.push({
        role: String(message.role),
        content,
        timestamp: Number(entry.ts ?? entry.timestamp ?? Date.now()),
      });
    }
    if (file.malformedLines > 0) {
      console.warn(`[SessionFileOps] 跳过无法解析的 JSONL 行: ${filePath}`);
    }
    return messages;
  }

  /**
   * 统一读取本地/WSL 会话原文（含解码与逐行解析），供 Viewer 与 AgentManager 共享转换管线。
   * 预算超限时 raw 只含完整行，truncated 标记已截断。
   */
  async readSessionFile(filePath: string, options?: ReadEntriesOptions): Promise<SessionEntriesFile> {
    return readEntries(this.deps.getAdapter(), filePath, options);
  }

  /**
   * readMessages / readSessionMeta 共用的硬上限守卫。
   *
   * 先用适配器 stat 拿大小（WSL/本地同一 seam），超过 64MB 立即抛错；
   * 指纹顺手传给 readEntries，避免正常路径多一次 stat（I/O 次数与原来一致）。
   */
  private async readSessionFileWithinLimit(filePath: string): Promise<SessionEntriesFile> {
    const fingerprint = await this.deps.getAdapter().stat(filePath);
    if (fingerprint.size > SESSION_READ_HARD_MAX_BYTES) {
      const sizeMb = (fingerprint.size / (1024 * 1024)).toFixed(1);
      const limitMb = SESSION_READ_HARD_MAX_BYTES / (1024 * 1024);
      throw new Error(`会话文件过大（${sizeMb} MB），超过 ${limitMb} MB 读取上限: ${filePath}`);
    }
    return this.readSessionFile(filePath, { fingerprint });
  }

  /**
   * 从会话 JSONL 文件头部读取模型和思考级别信息。
   * 取最后一条 model_change / thinking_level_change 记录作为当前值。
   */
  async readSessionMeta(filePath: string): Promise<{
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
  }> {
    const file = await this.readSessionFileWithinLimit(filePath);
    let provider: string | undefined;
    let modelId: string | undefined;
    let thinkingLevel: string | undefined;
    for (const raw of file.entries) {
      if (!isJsonRecord(raw)) continue;
      if (raw.type === "model_change") {
        provider = typeof raw.provider === "string" ? raw.provider : provider;
        modelId = typeof raw.modelId === "string" ? raw.modelId : modelId;
      } else if (raw.type === "thinking_level_change") {
        thinkingLevel = typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : thinkingLevel;
      }
    }
    return { provider, modelId, thinkingLevel };
  }

}