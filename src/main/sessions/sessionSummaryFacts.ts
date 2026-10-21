import type { SessionSummary } from "../../shared/types";
import { isJsonRecord, type SessionEntriesFile } from "./sessionEntries";
import { extractText } from "./sessionText";

/**
 * 会话摘要的「纯解析」部分。
 *
 * 从 SessionScanner.readSummary 抽出：只遍历已解析的 JSONL 条目并收集字段，
 * 不做文件读取、路径推断、缓存或 WSL 判断。这样同一份逻辑既能在主进程执行，
 * 也能在 worker_threads 中执行，避免两条实现逐渐漂移。
 */

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 取候选字段中第一个非空字符串。
 * JSONL 行是外部持久化数据，字段类型不可信：早先把行当 any 处理时，非字符串的
 * name/cwd 会被塞进 string 变量，并在后续 cleanTitle/normalize 的 .replace 上抛错。
 */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export interface SessionSummaryFacts {
  /** 可解析行数；为 0 时调用方必须隐藏该会话。 */
  parsedLines: number;
  /** 损坏行数，用于 degraded 标记。 */
  malformedLines: number;
  /** UTF-16/二进制等无法解码的文件。 */
  unreadable: boolean;
  /** 解码后为空（含只有空白）的文件。 */
  rawEmpty: boolean;
  name?: string;
  projectPath?: string;
  preview: string;
  firstUserText: string;
  firstAssistantText: string;
  messageCount: number;
  source: SessionSummary["source"];
  codexSessionId?: string;
  codexThreadSource?: SessionSummary["codexThreadSource"];
  codexParentThreadId?: string;
  codexAgentRole?: string;
  codexAgentNickname?: string;
  codexSourcePath?: string;
  latestSessionInfoName?: string;
  titleSlotName?: string;
  latestTitleChangeName?: string;
  sessionHeaderTitle?: string;
  forkParentSession?: string;
  hasSubagentChildMarker: boolean;
}

export type SessionTextParseResult = Pick<SessionEntriesFile, "entries" | "malformedLines" | "unreadable" | "raw">;

/** 从解析结果中提取摘要事实；调用方负责补上路径推断与标题清理。 */
export function extractSessionSummaryFacts(parsed: SessionTextParseResult): SessionSummaryFacts {
  let name: string | undefined;
  let projectPath: string | undefined;
  let preview = "空会话";
  let firstUserText = "";
  let firstAssistantText = "";
  let messageCount = 0;
  let source: SessionSummary["source"] = "pi";
  let codexSessionId: string | undefined;
  let codexThreadSource: SessionSummary["codexThreadSource"];
  let codexParentThreadId: string | undefined;
  let codexAgentRole: string | undefined;
  let codexAgentNickname: string | undefined;
  let codexSourcePath: string | undefined;
  let latestSessionInfoName: string | undefined;
  /** omp 原生标题：首行定长 title 槽 + 末尾 title_change（重命名记录）。 */
  let titleSlotName: string | undefined;
  let latestTitleChangeName: string | undefined;
  /** 会话头里的 title/titleSource：没有 title 槽的旧文件仍可读到。 */
  let sessionHeaderTitle: string | undefined;
  let forkParentSession: string | undefined;
  let hasSubagentChildMarker = false;

  for (const parsedEntry of parsed.entries) {
    // JSONL 行可能是合法 JSON 但非对象（null/字符串/数字），访问属性前先判空，避免 TypeError。
    if (!isJsonRecord(parsedEntry)) continue;
    const entry = parsedEntry;
    const data = isJsonRecord(entry.data) ? entry.data : undefined;
    const header = isJsonRecord(entry.header) ? entry.header : undefined;
    const sessionRecord = isJsonRecord(entry.session) ? entry.session : undefined;
    const nestedSession = data && isJsonRecord(data.session) ? data.session : undefined;
    const entryType = typeof entry.type === "string" ? entry.type : undefined;
    if (entryType === "session_info") {
      // Forked sessions may contain an older copied name; only the latest marker is authoritative.
      latestSessionInfoName = optionalString(entry.name ?? data?.name);
    }
    // omp 原生标题：title 槽在首行原地更新，title_change 是追加式变更记录；
    // 后者可能比槽位更新（例如槽位写入失败），因此读标题时优先取最后一条。
    if (entryType === "title") {
      titleSlotName = optionalString(entry.title) ?? titleSlotName;
    }
    if (entryType === "title_change") {
      latestTitleChangeName = optionalString(entry.title) ?? latestTitleChangeName;
    }
    if (entryType === "session") {
      sessionHeaderTitle ||= optionalString(entry.title);
      forkParentSession ||= optionalString(entry.parentSession ?? header?.parentSession);
    }
    // 检测显式子会话标记：支持任何 "*.child-session" 格式，
    // 不仅限于 pi-subagents，未来其他扩展也可沿用此约定。
    if (entryType === "custom" && typeof entry.customType === "string" && entry.customType.endsWith(".child-session")) {
      hasSubagentChildMarker = true;
    }
    // 扫描前几行的非消息条目，检测导入来源标记
    if (source === "pi") {
      if (entryType === "codex_import") {
        source = "codex";
        codexSessionId = optionalString(entry.codexSessionId);
        codexSourcePath = optionalString(entry.sourcePath);
        codexThreadSource = entry.threadSource === "subagent" ? "subagent" : "user";
        codexParentThreadId = optionalString(entry.parentThreadId);
        codexAgentRole = optionalString(entry.agentRole);
        codexAgentNickname = optionalString(entry.agentNickname);
      }
      else if (entryType === "claude_import") source = "claude";
      else if (entryType === "opencode_import") source = "opencode";
    }

    name ||= firstString(entry.sessionName, entry.name, data?.name, header?.name, sessionRecord?.name);
    projectPath ||= firstString(
      entry.cwd,
      entry.projectPath,
      header?.cwd,
      data?.cwd,
      sessionRecord?.cwd,
      nestedSession?.cwd,
    );

    const message = entry.message ?? data?.message ?? entry;
    if (isJsonRecord(message) && message.role) {
      messageCount += 1;
      const text = extractText(message.content).trim();
      if (text && preview === "空会话") preview = text;
      if (text && message.role === "user" && !firstUserText) firstUserText = text;
      if (text && message.role === "assistant" && !firstAssistantText) firstAssistantText = text;
    }
  }

  return {
    parsedLines: parsed.entries.length,
    malformedLines: parsed.malformedLines,
    unreadable: parsed.unreadable,
    rawEmpty: !parsed.raw.trim(),
    name,
    projectPath,
    preview,
    firstUserText,
    firstAssistantText,
    messageCount,
    source,
    codexSessionId,
    codexThreadSource,
    codexParentThreadId,
    codexAgentRole,
    codexAgentNickname,
    codexSourcePath,
    latestSessionInfoName,
    titleSlotName,
    latestTitleChangeName,
    sessionHeaderTitle,
    forkParentSession,
    hasSubagentChildMarker,
  };
}
