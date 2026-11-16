/**
 * 工具参数推导：把工具调用的 meta.args 投影成 diff / 改动行数 / 修改文件清单。
 *
 * 为什么成模块：`write|edit|patch` 的工具名规则、oldText/newText 的多写法兼容、
 * 「同一路径再次修改要移到末尾」的顺序语义，三者共同定义右侧 Files 抽屉与会话摘要的数据源。
 * 之前这段推导挂在 App 根 useMemo 上，transcript 每次 50ms 增量都会唤醒根组件；现在只在
 * 真正需要（打开 diff）时按快照算一次，因此必须是一个可独立调用、可独立测试的深模块。
 */
import type { ChatMessage } from "../../../shared/types";
import { toolArgPath } from "../../../shared/sessionDisplayContract";
import type { SessionModifiedFile } from "../components/app/types";

/** 工具参数对象化：唯一实现是 shared 契约的 toolArgSummary/toolArgPath 内部解析，
 *  渲染层只需要对象本身（diff/改动行数），因此保留这一层薄封装。 */
export function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		let parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "string" && parsed.trim()) {
			try { parsed = JSON.parse(parsed); } catch { return undefined; }
		}
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

export function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (edits) {
		const parts = edits.map((edit: unknown) => {
			if (!edit || typeof edit !== "object") return null;
			const e = edit as Record<string, unknown>;
			const oldText = String(e.oldText ?? e.old_text ?? "");
			const newText = String(e.newText ?? e.new_text ?? "");
			return { oldText, newText };
		}).filter((p): p is { oldText: string; newText: string } => p !== null);
		if (parts.length === 0) return undefined;
		return {
			oldText: parts.map(p => p.oldText).join("\n"),
			newText: parts.map(p => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

export function getToolNewContent(toolName: string, args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (!toolName) return undefined;
	if (/write|create/i.test(toolName)) {
		const a = args as Record<string, unknown>;
		return typeof a.content === "string" ? a.content : typeof a.text === "string" ? a.text : typeof a.data === "string" ? a.data : typeof a.body === "string" ? a.body : undefined;
	}
	if (/edit|patch/i.test(toolName)) {
		const diff = getToolEditDiff(args);
		return diff?.newText;
	}
	return undefined;
}

export function getToolChangedLineCount(toolName: string, args: any): number {
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return 0; }
	}
	if (!toolName) return 0;
	if (/edit|patch/i.test(toolName)) {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		if (edits) {
			return edits.reduce((total: number, edit: any) => {
				const oldLines = countTextLines(String(edit?.oldText ?? edit?.old_text ?? ""));
				const newLines = countTextLines(String(edit?.newText ?? edit?.new_text ?? ""));
				return total + Math.max(oldLines, newLines);
			}, 0);
		}
		return Math.max(countTextLines(String(args?.oldText ?? args?.old_text ?? "")), countTextLines(String(args?.newText ?? args?.new_text ?? "")));
	}
	if (/write|create/i.test(toolName)) {
		return countTextLines(String(args?.content ?? args?.text ?? args?.data ?? args?.body ?? ""));
	}
	return 0;
}

/**
 * 从工具消息里归并出「当前会话修改过的文件」。
 *
 * 之前这段推导挂在 App 根 useMemo 上，导致 transcript 每次 50ms 增量都要唤醒根组件；
 * 现在只在真正需要（打开 diff）时按当前 transcript 快照计算一次，点击路径可接受 O(n)。
 */
export function buildModifiedFiles(messages: ChatMessage[]): SessionModifiedFile[] {
	const byPath = new Map<string, SessionModifiedFile>();
	for (const msg of messages) {
		if (msg.role !== "tool") continue;
		const toolName: string | undefined = msg.meta?.toolName as string | undefined;
		const args: unknown = msg.meta?.args;
		const status: string = String(msg.meta?.status ?? "done");
		// 只收集文件写入/编辑类的工具调用，作为右侧 Files 与会话结束摘要的统一数据源。
		if (!toolName || !/write|edit|create|patch/i.test(toolName)) continue;
		const filePath = toolArgPath(args);
		if (!filePath) continue;
		const previous = byPath.get(filePath);
		// 同一路径再次被修改时移动到 Map 末尾，右侧修改清单才能按"最新修改"展示。
		if (previous) byPath.delete(filePath);
		// originalContent 不再存储到消息 meta 中（full file 会使会话体积过大）。
		// diff 展示时使用工具参数（oldText/newText）显示变动区域。
		byPath.set(filePath, {
			path: filePath,
			toolName,
			status: status === "running" ? "running" : (previous?.status ?? status),
			changedLines: (previous?.changedLines ?? 0) + getToolChangedLineCount(toolName, args),
			originalContent: "",
			content: getToolNewContent(toolName, args) ?? previous?.content,
		});
	}
	return Array.from(byPath.values());
}
