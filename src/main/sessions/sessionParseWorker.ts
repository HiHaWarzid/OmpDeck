import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import { parseSessionText } from "./sessionEntries";
import { extractSessionSummaryFacts } from "./sessionSummaryFacts";
import type { SessionParseRequest, SessionParseResponse } from "./sessionParseProtocol";

/**
 * 会话摘要解析 worker。
 *
 * 每次请求自己读取完整 JSONL 并解析，主进程只接收小的摘要事实对象：
 * 读取/解码/JSON.parse 的 CPU 不再占用主进程事件循环，也不会把整份文件
 * 通过结构化克隆搬回主线程。扫描用到的指纹由主进程预先 stat 并传入缓存。
 */

const port = parentPort;
if (!port) throw new Error("sessionParseWorker requires worker_threads");

port.on("message", async (request: SessionParseRequest) => {
  let response: SessionParseResponse;
  try {
    const raw = await readFile(request.filePath, "utf8");
    const parsed = parseSessionText(raw);
    response = {
      id: request.id,
      ok: true,
      facts: extractSessionSummaryFacts({
        entries: parsed.entries,
        malformedLines: parsed.malformedLines,
        unreadable: parsed.unreadable,
        raw: parsed.text,
      }),
    };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
});
