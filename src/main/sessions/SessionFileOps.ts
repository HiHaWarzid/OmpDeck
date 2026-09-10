import { randomUUID } from "node:crypto";
import { shell } from "electron";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { FileAdapter } from "../fs/adapters/fileAdapter";

/**
 * 会话文件操作模块 —— 从 SessionScanner 中抽出的纯文件操作（rename/delete/
 * readMessages/readSessionMeta/readSessionRawText），与扫描管线解耦。
 *
 * 设计动机（deep module）：
 *   - SessionScanner 原本把扫描管线（collect→fingerprint→cache）、摘要打分与文件
 *     操作混在一个类里。文件操作不关心扫描/缓存/项目过滤，只依赖文件适配器与
 *     会话根路径，收拢为本模块后职责单一。
 *   - WSL/本地适配器随环境切换（configureWsl 会替换实例），因此通过 getAdapter
 *     访问器每次操作时读取当前适配器，避免持有过期实例。
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

export class SessionFileOps {
  private readonly deps: SessionFileOpsDeps;

  constructor(deps: SessionFileOpsDeps) {
    this.deps = deps;
  }

  // ── 会话操作：rename / delete / copy / exportHtml / readMessages ─

  /**
   * 重命名会话：按 pi 原生格式在 JSONL 末尾追加 session_info 记录。
   *
   * pi 要求会话文件首条可解析记录必须是 type:"session"（buildSessionInfo 中
   * 否则直接返回 null），旧版在文件头前置 {"sessionName":...} 会让 pi 完全无法
   * 加载该会话（/resume 中也不可见，见 #114）。pi 原生 /rename 的做法是末尾追加
   * {type:"session_info", id, parentId, timestamp, name}，读取时取最后一条。
   *
   * 顺带剔除旧版应用写入的 sessionName 私有行，修复已被破坏的会话文件。
   * 支持 WSL 路径。
   */
  async rename(filePath: string, newName: string): Promise<void> {
    const raw = await this.deps.getAdapter().read(filePath);
    const output = this.appendSessionInfoLine(raw, newName);
    await this.deps.getAdapter().write(filePath, output);
  }

  /**
   * 在 JSONL 文本末尾追加 pi 原生 session_info 记录，返回新文本。
   *
   * id/parentId 规则与 pi SessionManager 一致：id 为文件内不冲突的 8 位十六进制，
   * parentId 指向追加前最后一条带 id 的记录（没有则 null，由 pi 视为新根）。
   * 会话树靠 parentId 串联，指向最后一片叶子可保持链条完整。
   *
   * 同时剔除旧版应用的 {"sessionName":...} 私有行（无 type 字段）：pi 无法识别，
   * 位于文件头时会破坏首行校验导致整个会话无法加载（#114 的存量受损文件）。
   */
  private appendSessionInfoLine(raw: string, name: string): string {
    // 与 pi appendSessionInfo 相同的清洗规则：换行折叠为空格，避免破坏 JSONL 行结构。
    const sanitized = name.replace(/[\r\n]+/g, " ").trim();
    const ids = new Set<string>();
    let lastId: string | null = null;
    const keptLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let isLegacyNameLine = false;
      try {
        const parsed = JSON.parse(trimmed);
        // 判定旧版私有格式：带 sessionName 且无 type；pi 原生记录一律有 type。
        isLegacyNameLine =
          typeof parsed.sessionName === "string" && typeof parsed.type !== "string";
        if (!isLegacyNameLine && typeof parsed.id === "string" && parsed.id) {
          ids.add(parsed.id);
          lastId = parsed.id;
        }
      } catch {
        // 不可解析的行原样保留，不做破坏性清理
      }
      if (!isLegacyNameLine) keptLines.push(trimmed);
    }
    // 与 pi generateId 一致：randomUUID 前 8 位，冲突时重试
    let id = randomUUID().slice(0, 8);
    while (ids.has(id)) id = randomUUID().slice(0, 8);
    const entry = {
      type: "session_info",
      id,
      parentId: lastId,
      timestamp: new Date().toISOString(),
      name: sanitized,
    };
    keptLines.push(JSON.stringify(entry));
    return `${keptLines.join("\n")}\n`;
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
    const raw = await this.deps.getAdapter().read(filePath);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const messages: Array<{ role: string; content: string; timestamp: number }> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type && entry.type !== "message") continue;
        if (entry.sessionName && !entry.message) continue;
        const message = (entry.message ?? (entry.data as Record<string, unknown> | undefined)?.message ?? entry) as Record<string, unknown> | undefined;
        if (!message?.role) continue;
        const content = extractText(message.content).trim();
        if (!content) continue;
        if (message.role !== "user" && message.role !== "assistant") continue;
        messages.push({ role: String(message.role), content, timestamp: Number(entry.ts ?? entry.timestamp ?? Date.now()) });
      } catch { console.warn(`[SessionFileOps] 跳过无法解析的 JSONL 行: ${filePath}`); }
    }
    return messages;
  }

  /** 统一读取本地/WSL 会话原文，供 Viewer 与 AgentManager 共享转换管线。 */
  async readSessionRawText(filePath: string): Promise<string> {
    return this.deps.getAdapter().read(filePath);
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
    const raw = await this.readSessionRawText(filePath);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let provider: string | undefined;
    let modelId: string | undefined;
    let thinkingLevel: string | undefined;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "model_change") {
          provider = typeof entry.provider === "string" ? entry.provider : provider;
          modelId = typeof entry.modelId === "string" ? entry.modelId : modelId;
        } else if (entry.type === "thinking_level_change") {
          thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : thinkingLevel;
        }
      } catch { /* skip malformed lines */ }
    }
    return { provider, modelId, thinkingLevel };
  }

}