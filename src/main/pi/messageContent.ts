/**
 * 宿主注入的内部指令只给模型看，展示前剥离。
 * 飞书桥接已移除，但历史会话文件中仍可能残留这些标记与动作标记，
 * 因此保留只读清洗逻辑，避免旧会话在时间线里露出内部提示。
 */
function stripHostInjections(text: string): string {
	return text
		.replace(/\[PIDECK_HOST_INSTRUCTION\][\s\S]*?\[\/PIDECK_HOST_INSTRUCTION\]\s*/g, "")
		.replace(/\n{0,2}\[OmpDeck 飞书能力\][\s\S]*$/, "")
		.replace(/\[(SEND_FILE|CREATE_DOC):[^\]]*\]/g, "")
		.trim();
}

function stripCpaCompletionMarker(text: string): string {
	// CPA uses this final-line sentinel for transport completion; it is not user-visible content.
	return text.replace(/(?:^|\r?\n)<CPA_DONE>\s*$/, "");
}

/**
 * 将 pi/RPC 的 content 字段转换为桌面端消息正文。
 * 兼容部分 Anthropic-compatible 服务把同一段 assistant 文本拆成多个 {type:"text"}
 * content item 的情况：这些 item 只是流式分片，不代表 Markdown 段落边界，不能用换行拼接，
 * 否则中文会被渲染成一行一个短片段的“竖排”消息。
 */
export function extractMessageText(content: unknown): string {
	if (typeof content === "string") {
		// 宿主指令 / 能力提示只给模型看，UI 与历史展示前剥离。
		return stripCpaCompletionMarker(stripHostInjections(content));
	}
	if (!Array.isArray(content)) return "";

	let text = "";
	for (const item of content) {
		if (typeof item === "string") {
			text += item;
			continue;
		}
		if (!item || typeof item !== "object") continue;

		const typed = item as Record<string, unknown>;
		if (typed.type === "image") continue;
		if (typed.type === "thinking") {
			const thinking = String(typed.thinking ?? "");
			if (thinking) {
				// thinking 是独立语义块，保留为标签块；前后补边界，避免和正文黏在一起。
				const prefix = text && !text.endsWith("\n") ? "\n" : "";
				text += `${prefix}<thinking>${thinking}</thinking>`;
			}
			continue;
		}

		// text item 可能是模型流式分片，也可能已经包含 Markdown 换行；原样串接即可保留格式。
		text += String(typed.text ?? "");
	}

	return stripCpaCompletionMarker(stripHostInjections(text));
}

/**
 * 从 pi/RPC content 数组中提取 thinking 块的纯文本（不含标签包裹）。
 * 与 AgentManager.extractThinking 逻辑一致，用于会话文件直接读取场景。
 */
export function extractThinkingRaw(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const typed = item as Record<string, unknown>;
			if (typed.type !== "thinking") return "";
			return String(typed.thinking ?? typed.text ?? "");
		})
		.filter(Boolean)
		.join("\n");
}
