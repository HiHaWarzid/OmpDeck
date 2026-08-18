import { basename as posixBasename, dirname as posixDirname, join as posixJoin } from "node:path/posix";

/**
 * 从子会话文件路径向上逐层生成候选父会话路径（纯函数，无 I/O）。
 *
 * 目录结构约定：父会话 <stem>.jsonl 与子会话目录 <stem>/ 相邻，
 * 子会话文件位于 <stem>/ 下任意深度（深度上限 10 层）。
 *
 * 路径风格兼容两种环境：
 *   - Windows 本地：反斜杠路径（LocalFileAdapter.collectJsonl 由 path.join 产出）。
 *     node:path/posix 只认 '/'，直接对反斜杠路径调用 posixDirname 会把整条路径
 *     塌缩成 '.'，导致推断恒失败——必须先统一为 '/' 遍历，返回时再还原为反斜杠，
 *     与父会话自身 filePath 的分隔符保持一致。
 *   - WSL：Linux posix 路径，原样处理。
 *
 * 边界：不超出扫描根，避免把其他项目/其他根目录的会话误判为父会话。
 *
 * @param filePath 子会话文件路径（.jsonl）
 * @param normalizedRoot 扫描根，已归一化（统一 '/'、小写、去尾部斜杠）
 * @returns 从近到远的候选父会话路径（与 filePath 同风格分隔符）；无候选时为空数组
 */
export function inferParentCandidatesFromPath(
  filePath: string,
  normalizedRoot: string,
): string[] {
  if (!filePath.toLowerCase().endsWith(".jsonl")) return [];
  // Windows 反斜杠统一为 '/' 作为 posix 遍历起点；WSL 路径原样。
  let currentDir = posixDirname(filePath.replace(/\\/g, "/"));
  const useBackslash = filePath.includes("\\");
  const candidates: string[] = [];

  for (let depth = 0; depth < 10; depth += 1) {
    // 到达或超出扫描根：停止。
    const normalizedDir = currentDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (normalizedDir === normalizedRoot || !normalizedDir.startsWith(`${normalizedRoot}/`)) break;

    // 每一层检查「本目录的同级 <dirname>.jsonl」：父目录 + 本目录名 + .jsonl。
    const dirName = posixBasename(currentDir);
    if (!dirName) break;
    const parentDir = posixDirname(currentDir);
    const candidate = posixJoin(parentDir, `${dirName}.jsonl`);
    candidates.push(useBackslash ? candidate.replace(/\//g, "\\") : candidate);
    currentDir = parentDir;
  }

  return candidates;
}

// ── 子会话置信度打分（纯函数） ────────────────────────────

/**
 * 子会话置信度打分输入：readSummary 扫描中采集的各信号。
 * 全部为布尔/可选字符串，打分本身不触达文件系统，便于单测。
 */
export interface SubagentSignalInput {
  /** 路径布局推断出父会话（强信号） */
  pathInferred: boolean;
  /** 显式 customType: "*.child-session" 标记（强信号） */
  customMarker: boolean;
  /** 最近一条 session_info 的名称（弱信号：以 "subagent-" 开头） */
  sessionName: string | undefined;
  /** session header 中的 parentSession 引用（弱信号） */
  parentSessionRef: string | undefined;
}

/**
 * 子会话置信度打分：强信号 2 分，弱信号 1 分。
 * 兼容不同扩展的子会话存储方式（路径布局 / 显式标记 / 命名模式 / header 引用），
 * ≥ SUBAGENT_CONFIDENCE_THRESHOLD 判定为子会话。
 */
export function scoreSubagentConfidence(input: SubagentSignalInput): number {
  let score = 0;
  if (input.pathInferred) score += 2;
  if (input.customMarker) score += 2;
  if (input.sessionName?.startsWith("subagent-")) score += 1;
  if (input.parentSessionRef) score += 1;
  return score;
}

/** 子会话判定置信度阈值：≥ 此分数判定为子会话（SessionScanner.readSummary 使用）。 */
export const SUBAGENT_CONFIDENCE_THRESHOLD = 2;
