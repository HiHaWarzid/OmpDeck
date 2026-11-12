import { isJsonRecord, type SessionLine } from "./sessionEntries";

/**
 * 会话投影模块 —— 把「已解析的 JSONL 行」解释成会话语义的唯一实现。
 *
 * 设计动机（deep module）：迁移前同一份条目被两套无关管线各自解释：
 *   - 扫描管线（sessions/sessionSummaryFacts）扫标题槽、导入来源、首条消息；
 *   - 查看管线（pi/sessionJsonl.readDisplayMessages）沿 parentId 回溯活动分支、
 *     再按最后一次压缩切出当前上下文；
 *   - 分页/导航管线（readRecentMessages / readOlderMessages / findEntryOffset /
 *     readRecentUserPrompts）各自 split + JSON.parse + 累加字节数，重复了四遍
 *     「哪一行是一条消息」的规则。
 * 本模块只做纯变换（无 fs、无 RPC、无 blob 解析），因此可以在 worker、主进程、
 * 测试中复用；文件 IO 仍在 sessionEntries（行 + 绝对字节偏移）。
 *
 * 依赖方向：仅依赖 sessionEntries 的解析结果，不依赖 pi/ 运行时。
 */

/** 一条消息行：会话文件里唯一的对话单位，entryId 与起始偏移用于编辑/分页定位。 */
export interface MessageLine {
  entryId: string;
  message: unknown;
  offset: number;
}

/**
 * `type === "message"` 且带 message 与 id 的条目——pi/omp 原生会话的消息行规则。
 * 返回 undefined 表示「不是消息行」，调用方不需要再摸一遍字段类型。
 */
export function asMessageEntry(
  value: unknown,
): { entryId: string; message: unknown } | undefined {
  if (!isJsonRecord(value)) return undefined;
  if (value.type !== "message") return undefined;
  if (typeof value.id !== "string" || !value.id) return undefined;
  if (!value.message) return undefined;
  return { entryId: value.id, message: value.message };
}

/** 从行序列中取消息行（保持文件顺序），偏移沿用 sessionEntries 的绝对字节偏移。 */
export function messageLines(lines: readonly SessionLine[]): MessageLine[] {
  const messages: MessageLine[] = [];
  for (const line of lines) {
    const entry = asMessageEntry(line.value);
    if (entry) messages.push({ ...entry, offset: line.offset });
  }
  return messages;
}

/** 活动分支上的条目：只保留分支/压缩判定需要的字段（其余字段不进时间线）。 */
export interface BranchEntry {
  id: string;
  parentId: string | null;
  type: string;
  message?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  timestamp?: string;
}

export interface ActiveBranch {
  /** 从根到叶的活动分支（文件内顺序的子序列） */
  branch: BranchEntry[];
  /** 当前上下文窗口内的消息条目（最后一次压缩的保留段起，只含 message 行） */
  currentMessages: BranchEntry[];
  /** 参与当前上下文的最后一次压缩条目（无压缩时为 undefined） */
  lastCompaction?: BranchEntry;
}

/**
 * 沿 parentId 从最后一个条目（pi 的当前叶节点）回溯出活动分支。
 *
 * 分支语义：文件按追加顺序排列，分支切换只改变 parentId 链，因此「最后一个条目」
 * 就是当前叶节点；回溯遇到的环（损坏文件）在 seen 处截断。
 * 压缩语义：上下文 = summary + firstKeptEntryId 起的保留消息 + 后续消息，
 * 不能只取 compaction 之后，否则会漏掉压缩时明确保留的尾部消息。
 */
export function selectActiveBranch(entries: readonly unknown[]): ActiveBranch {
  const typed: BranchEntry[] = [];
  for (const entry of entries) {
    // 单行损坏已被 sessionEntries 隔离；缺 id 的条目无法参与分支回溯。
    if (!isJsonRecord(entry) || typeof entry.id !== "string") continue;
    typed.push({
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      type: typeof entry.type === "string" ? entry.type : "",
      message: entry.message,
      summary: typeof entry.summary === "string" ? entry.summary : undefined,
      firstKeptEntryId:
        typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
      tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    });
  }
  if (typed.length === 0) return { branch: [], currentMessages: [] };

  const byId = new Map(typed.map((entry) => [entry.id, entry]));
  const branch: BranchEntry[] = [];
  const seen = new Set<string>();
  let current: BranchEntry | undefined = typed[typed.length - 1];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  branch.reverse();

  const lastCompactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  const lastCompaction = lastCompactionIndex >= 0 ? branch[lastCompactionIndex] : undefined;
  const firstKeptIndex = lastCompaction?.firstKeptEntryId
    ? branch.findIndex((entry) => entry.id === lastCompaction.firstKeptEntryId)
    : -1;
  const currentStartIndex =
    firstKeptIndex >= 0 ? firstKeptIndex : lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0;
  const currentMessages = branch
    .slice(currentStartIndex)
    .filter((entry) => entry.type === "message" && entry.message);

  return { branch, currentMessages, lastCompaction };
}
