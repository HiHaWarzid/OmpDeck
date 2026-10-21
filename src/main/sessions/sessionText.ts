/**
 * 会话消息文本提取（纯函数）。
 *
 * 独立于 SessionFileOps：后者依赖 electron.shell，扫描 worker 只需要文本提取，
 * 不能把 Electron 主进程模块拖进 worker 线程。
 */

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
