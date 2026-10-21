import type { SessionSummaryFacts } from "./sessionSummaryFacts";

/** 主进程 → 解析 worker：只传路径，worker 自己读文件，避免整份 JSONL 跨线程复制。 */
export interface SessionParseRequest {
  id: number;
  filePath: string;
}

/** 解析 worker → 主进程：只回传摘要事实，不回传整份条目。 */
export type SessionParseResponse =
  | { id: number; ok: true; facts: SessionSummaryFacts }
  | { id: number; ok: false; error: string };
