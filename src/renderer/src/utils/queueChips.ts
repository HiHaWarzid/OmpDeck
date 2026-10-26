import type { AgentQueuedMessages } from "../../../shared/types";

/** 本地「投递结果未知」提示：omp 可能已接收，不能重试也不能伪造撤回。 */
export type UncertainPrompt = {
	id: string;
	text: string;
	error: string;
};

/** 待发送轨道的一行：服务端队列 chip，或本地未知投递提示。 */
export type QueuePanelRow =
	| { kind: "queued"; key: string; queue: "steering" | "followUp"; text: string }
	| { kind: "uncertain"; key: string; id: string; text: string; error: string };

/** 待发送轨道最多展示的行数；超出靠面板滚动，不挤占输入框。 */
export const QUEUED_PROMPT_VISIBLE = 3;

/**
 * 面板行 = omp 队列（steering 在前、followUp 在后，各自保序）+ 本地未知投递提示。
 * 队列文本允许重复（omp 也按首条匹配撤回），key 必须带下标避免碰撞。
 */
export function buildQueueRows(
	queued: AgentQueuedMessages | undefined,
	uncertain?: UncertainPrompt[],
): QueuePanelRow[] {
	const rows: QueuePanelRow[] = [];
	const pushQueue = (
		queue: "steering" | "followUp",
		messages: string[] | undefined,
	) => {
		for (const [index, text] of (messages ?? []).entries()) {
			rows.push({ kind: "queued", key: `${queue}:${index}:${text}`, queue, text });
		}
	};
	pushQueue("steering", queued?.steering);
	pushQueue("followUp", queued?.followUp);
	for (const item of uncertain ?? []) {
		rows.push({
			kind: "uncertain",
			key: `uncertain:${item.id}`,
			id: item.id,
			text: item.text,
			error: item.error,
		});
	}
	return rows;
}
