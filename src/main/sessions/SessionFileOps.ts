import { randomUUID } from "node:crypto";
import { app, shell } from "electron";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type { FileAdapter } from "../fs/adapters/fileAdapter";
import type { SessionSummary } from "../../shared/types";

/**
 * 会话文件操作模块 —— 从 SessionScanner 中抽出的纯文件操作（rename/copy/delete/
 * exportHtml/readMessages/readSessionMeta/readSessionRawText），与扫描管线解耦。
 *
 * 设计动机（deep module）：
 *   - SessionScanner 原本把扫描管线（collect→fingerprint→cache）、摘要打分与六个
 *     文件操作混在一个 1191 行的类里。文件操作不关心扫描/缓存/项目过滤，
 *     只依赖「文件适配器 + 会话根路径 + 摘要读取」，收拢为本模块后职责单一。
 *   - WSL/本地适配器随环境切换（SessionScanner.configureWsl 会替换实例），
 *     因此通过 getAdapter 访问器每次操作时读取当前适配器，避免持有过期实例。
 *   - copy/exportHtml 需要会话名称/消息数，通过 readSummary 回调注入，
 *     由扫描方（SessionScanner）提供，保持本模块不依赖扫描实现。
 *
 * 依赖方向：SessionFileOps 不依赖 SessionScanner（readSummary 注入），
 * 不依赖 AgentManager/RPC；可在无 Electron/无 WSL 环境下用 stub 测试。
 */

/** SessionFileOps 的注入依赖。 */
export interface SessionFileOpsDeps {
  /** 当前文件访问适配器（WSL/本地随环境切换，每次操作读取最新实例）。 */
  getAdapter: () => FileAdapter;
  /** 本地默认会话根目录（回收站降级 .trash 的存放位置）。 */
  localSessionsRoot: string;
  /** 当前环境默认会话根目录（WSL 时为 Linux 路径），删除安全防护用。 */
  getDefaultSessionsRoot: () => string;
  /** 读取会话摘要（copy/exportHtml 需要名称/消息数）。 */
  readSummary: (filePath: string) => Promise<SessionSummary | null>;
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
  private appendSessionInfoLine(raw: string, name: string, extra?: Record<string, unknown>): string {
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
      ...extra,
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

  /**
   * 复制会话文件并追加新的 session_info 名称记录（pi 原生格式，见 rename/#114）。
   * 这不是 CLI 的 fork：不裁剪会话树，只生成一个可独立打开/继续的新历史会话文件。
   * 支持 WSL 路径。
   */
  async copy(filePath: string): Promise<SessionSummary> {
    const raw = await this.deps.getAdapter().read(filePath);
    const current = await this.deps.readSummary(filePath).catch(() => null);
    const copyName = `${current?.name || "Untitled"} copy`;
    const targetPath = await this.nextCopyPath(filePath);
    // copiedFrom 作为附加字段保留来源信息；pi 会忽略未知字段，不影响加载。
    const content = this.appendSessionInfoLine(raw, copyName, { copiedFrom: filePath });
    await this.deps.getAdapter().write(targetPath, content);
    const summary = await this.deps.readSummary(targetPath);
    if (!summary) throw new Error("复制后的会话文件无法读取");
    return summary;
  }

  /** 将历史 JSONL 会话直接导出为基础 HTML，支持 WSL 路径 */
  async exportHtml(filePath: string): Promise<{ path: string }> {
    const summary = await this.deps.readSummary(filePath);
    if (!summary) throw new Error("会话文件无法读取");
    const raw = await this.deps.getAdapter().read(filePath);
    const rows = raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const data = typeof entry.data === "object" && entry.data !== null
          ? (entry.data as Record<string, unknown>)
          : undefined;
        const message = (entry.message ?? data?.message ?? entry) as Record<string, unknown> | undefined;
        const role = message && typeof message.role === "string" ? message.role : "";
        if (!message || !role) return "";
        const text = extractText(message.content).trim();
        if (!text) return "";
        return `<section class=\"msg ${this.escapeHtml(role)}\"><h2>${this.escapeHtml(role)}</h2><pre>${this.escapeHtml(text)}</pre></section>`;
      } catch {
        return "";
      }
    }).filter(Boolean).join("\n");
    const title = summary.name || "Untitled";
    const html = `<!doctype html><html><head><meta charset=\"utf-8\"><title>${this.escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:920px;margin:32px auto;padding:0 20px;color:#1f2937}.msg{border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:12px 0;background:#fff}.msg h2{margin:0 0 8px;font-size:13px;color:#64748b}.msg pre{white-space:pre-wrap;margin:0;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}</style></head><body><h1>${this.escapeHtml(title)}</h1><p>${new Date(summary.updatedAt).toLocaleString()} · ${summary.messageCount} messages</p>${rows}</body></html>`;
    const safeName = title.replace(/[\\/:*?\"<>|]/g, "_").slice(0, 80) || "session";
    const targetPath = join(app.getPath("downloads"), `${safeName}-${Date.now()}.html`);
    await writeFile(targetPath, html, "utf8");
    return { path: targetPath };
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

  private async nextCopyPath(filePath: string): Promise<string> {
    const dir = dirname(filePath);
    const ext = extname(filePath) || ".jsonl";
    const base = basename(filePath, ext);
    for (let index = 1; index < 1000; index += 1) {
      const suffix = index === 1 ? "copy" : `copy-${index}`;
      const candidate = join(dir, `${base}-${suffix}${ext}`);
      // 两个实现都支持存在性检查；WSL 走 wsl.exe test，本地走 existsSync。
      if (!(await this.deps.getAdapter().exists(candidate))) return candidate;
    }
    throw new Error("无法生成唯一的复制会话文件名");
  }

  private escapeHtml(value: string) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  }
}