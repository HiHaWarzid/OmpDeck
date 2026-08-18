import type { ChatMessage } from "./types";

/**
 * 消息数组的内容版本（纯函数，W6-18 从 /api/state 指纹内联逻辑提取，共享给
 * 主进程各消息流消费方）。
 *
 * 版本 = `长度:末条id:末条timestamp:末条文本长度`。可检出：
 *   - 流式追加（长度 + 末条变化）
 *   - 末条消息就地更新（id/timestamp/text 任一变化，如工具结果落写）
 *   - 消息增删（长度变化）
 * 不检出：中部消息的就地更新（末条未变）。这与 WebServiceManager /api/state 指纹的
 * 历史语义完全一致（web UI 600ms 轮询，只有尾部变化才需要重新序列化缓存）。
 *
 * 与主进程消息推送的 messageDirtyFrom/replaceFrom（下标级变更追踪，增量传输）互补：
 * 那边是「从哪条下标开始变」，这边是「整条流的内容签名」，用于缓存失效判断。
 *
 * 返回值仅供同进程内比较（缓存键/指纹），不落盘、不上网，不承诺跨版本稳定。
 */
export function messageStreamVersion(messages: readonly ChatMessage[]): string {
	const last = messages[messages.length - 1];
	return [
		messages.length,
		last?.id ?? "",
		last?.timestamp ?? 0,
		last?.text?.length ?? 0,
	].join(":");
}