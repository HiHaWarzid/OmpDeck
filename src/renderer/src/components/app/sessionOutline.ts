/**
 * 会话大纲：把 transcript 里的 user 消息投影成可跳转的大纲行。
 *
 * 缓存住在模块内部（WeakMap 以消息对象为键）：流式期间 transcript 每 50ms 更新一次，
 * 但历史 user 消息对象引用不变；未变化的消息返回同一个 item 对象，宿主才能保持 items
 * 数组引用稳定，避免大纲列表跟着流式刷新重建。
 */
import type { ChatMessage } from "../../../../shared/types";
import { formatTime, summarizeMessage } from "./format";

export type OutlineItem = {
	id: string;
	role: string;
	title: string;
	time: string;
};

// 流式期间 transcript 每 50ms 更新一次，但绝大多数历史 user 消息对象引用不变。
// 用 WeakMap 缓存每条消息的大纲项，避免反复跑摘要正则和 Intl 格式化；
// 未变化的消息返回同一个 item 对象，宿主据此保持 items 数组引用稳定。
const outlineItemCache = new WeakMap<
	ChatMessage,
	{ text: string; timestamp: number; item: OutlineItem | null }
>();

export function buildOutline(messages: ChatMessage[]): OutlineItem[] {
	const result: OutlineItem[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		const cached = outlineItemCache.get(message);
		// 同一对象也可能被原地改写（刷新/编辑），因此再核对一次文本与时间戳。
		let item = cached && cached.text === message.text && cached.timestamp === message.timestamp
			? cached.item
			: undefined;
		if (item === undefined) {
			const title = summarizeMessage(message.text);
			item = title
				? {
						id: message.id,
						role: message.role,
						title,
						time: formatTime(message.timestamp),
					}
				: null;
			outlineItemCache.set(message, {
				text: message.text,
				timestamp: message.timestamp,
				item,
			});
		}
		if (item) result.push(item);
	}
	return result;
}
