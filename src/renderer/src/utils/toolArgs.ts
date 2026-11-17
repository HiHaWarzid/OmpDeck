/**
 * 工具参数推导：把工具调用的 meta.args 投影成 diff 目标。
 *
 * 为什么成模块：`write|edit|patch` 的工具名规则、oldText/newText 的多写法兼容、
 * 「同一路径再次修改要移到末尾」的顺序语义，三者共同定义「这条工具调用展示哪份 diff」，
 * 卡片上的 diff chip 与 `diffFilePath` 的兜底索引都读它。
 * 之前这段推导挂在 App 根 useMemo 上，transcript 每次 50ms 增量都会唤醒根组件；现在只在
 * 真正需要（打开 diff）时按快照算一次，因此必须是一个可独立调用、可独立测试的深模块。
 */
import type { ChatMessage } from "../../../shared/types";
import { toolArgPath } from "../../../shared/sessionDisplayContract";
import type { DiffTarget } from "../components/app/types";

/** 「写整份文件」的工具族：write/create 的 content 就是执行后的完整内容。 */
function isFileWriteTool(toolName: string): boolean {
	return /write|create/i.test(toolName);
}

/** 「改文件片段」的工具族：edit/patch 只带 oldText/newText。 */
function isFileEditTool(toolName: string): boolean {
	return /edit|patch/i.test(toolName);
}

/** 会改动文件的工具族：卡片出 diff、兜底索引收录，两处必须是同一个范围。 */
function isFileMutatingTool(toolName: string): boolean {
	return isFileWriteTool(toolName) || isFileEditTool(toolName);
}

/** 工具参数对象化：唯一实现是 shared 契约的 toolArgSummary/toolArgPath 内部解析，
 *  渲染层只需要对象本身（diff 的 oldText/newText），因此保留这一层薄封装。 */
function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
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

function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
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

function getToolNewContent(toolName: string, args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (!toolName) return undefined;
	if (isFileWriteTool(toolName)) {
		const a = args as Record<string, unknown>;
		return typeof a.content === "string" ? a.content : typeof a.text === "string" ? a.text : typeof a.data === "string" ? a.data : typeof a.body === "string" ? a.body : undefined;
	}
	if (isFileEditTool(toolName)) {
		const diff = getToolEditDiff(args);
		return diff?.newText;
	}
	return undefined;
}

/**
 * 一次工具调用的 diff 目标：路径 + 前/后文本。
 *
 * 「哪些工具能出 diff、内容取自哪个键」只有这一处规则；卡片上的「查看 diff」与
 * `diffFilePath` 的兜底索引都读它，否则 `data`/`body` 形式的写入会出现
 * 「卡片有 chip、点开却没有内容」的落差。
 * `originalContent` 为空串表示新建：write/create 没有执行前内容。
 */
export function getToolDiffTarget(
	toolName: string,
	args: unknown,
): DiffTarget | undefined {
	if (!toolName || !isFileMutatingTool(toolName)) return undefined;
	const path = toolArgPath(args);
	if (!path) return undefined;
	if (isFileWriteTool(toolName)) {
		const content = getToolNewContent(toolName, args);
		if (content === undefined) return undefined;
		return { path, originalContent: "", content };
	}
	// edit/patch：不存储 full file originalContent，只展示变动区域
	const parsed = parseToolArgs(args);
	if (!parsed) return undefined;
	const diff = getToolEditDiff(parsed);
	if (!diff) return undefined;
	return { path, originalContent: diff.oldText, content: diff.newText };
}

/**
 * 按会话快照归并出「路径 → 该文件当前展示用的前/后文本」。
 *
 * 之前这段推导挂在 App 根 useMemo 上，导致 transcript 每次 50ms 增量都要唤醒根组件；
 * 现在只在真正需要（打开 diff）时按当前 transcript 快照计算一次，点击路径可接受 O(n)。
 * 同一路径多次修改时后写覆盖先写，并且**保留插入顺序的最后一次**——调用方按路径取值，
 * 顺序只影响将来若把它渲染成清单时的展示次序。
 */
export function buildDiffTargetIndex(messages: ChatMessage[]): Map<string, DiffTarget> {
	const byPath = new Map<string, DiffTarget>();
	for (const msg of messages) {
		if (msg.role !== "tool") continue;
		const toolName: string | undefined = msg.meta?.toolName as string | undefined;
		if (!toolName || !isFileMutatingTool(toolName)) continue;
		// 收录条件是「带路径的写/改工具」，与能否解析出内容无关：参数里没有可识别的
		// 内容键（或工具只带了路径）时，文件仍然被改过，只是没有可展示的内容。
		const filePath = toolArgPath(msg.meta?.args);
		if (!filePath) continue;
		const target = getToolDiffTarget(toolName, msg.meta?.args);
		const previous = byPath.get(filePath);
		// 同一路径再次被修改时移到 Map 末尾，维持「最后修改的排在最后」。
		if (previous) byPath.delete(filePath);
		byPath.set(filePath, {
			path: filePath,
			originalContent: target?.originalContent ?? previous?.originalContent ?? "",
			content: target?.content ?? previous?.content,
		});
	}
	return byPath;
}
