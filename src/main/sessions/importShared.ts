import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 会话导入管线中三个适配器（OpenCode / Claude / Codex）共享的纯函数。
 * 从原三个 Importer 中提取，消除完全相同的实现副本。
 * 设计依据：这些函数不依赖任何源格式，也不依赖 Electron 运行时，
 * 作为平级工具模块被 pipeline 与适配器各自按需引用。
 */

// ── 路径工具 ──────────────────────────────────────────────

/**
 * 将项目路径转为 pi 会话目录的安全 token。
 * Windows 路径 C:\Users\foo -> --C--Users-foo--，POSIX /home/foo -> --home-foo--。
 * 三个旧 Importer 中逐字相同的实现。
 */
export function safePathToken(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
	if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`;
	return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`;
}

/**
 * 将路径归一化为小写正斜杠形式，用于跨平台比较。
 */
export function normalizePath(path?: string): string {
	return String(path ?? "")
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

// ── ID 与标题 ────────────────────────────────────────────

export function hash(value: string): string {
	return createHash("sha1").update(value).digest("hex");
}

/**
 * 根据会话 ID 和序号生成 8 字符的稳定 entry ID。
 * 三个旧 Importer 中逐字相同的实现。
 */
export function makeId(sessionId: string, sequence: number): string {
	return hash(`${sessionId}:${sequence}`).slice(0, 8);
}

/**
 * 清理标题：去多余空白、拒绝 untitled、截断到 40 字符。
 * 三个旧 Importer 中逐字相同的实现。
 */
export function cleanTitle(value?: string): string {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text || /^untitled$/i.test(text)) return "";
	return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

// ── 文本提取 ─────────────────────────────────────────────

/**
 * 从 pi 消息 content 数组中提取纯文本，用于标题/预览。
 * 三个旧 Importer 中逐字相同的实现。
 * content 元素结构未知（来自外部源格式），用 unknown 后逐字段探测。
 */
type PiContentItem = {
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
};

export function extractPiText(content: unknown[]): string {
	return content
		.map((item) => {
			const obj = item as PiContentItem;
			return obj?.text ?? obj?.thinking ?? obj?.name ?? "";
		})
		.filter((v): v is string => typeof v === "string")
		.filter(Boolean)
		.join(" ");
}

// ── 用量占位 ─────────────────────────────────────────────

/**
 * pi 的上下文统计会读取 assistant.usage.totalTokens；
 * 导入的历史没有真实用量，用零值占位保证可继续对话。
 */
export function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// ── 导入元信息读取 ───────────────────────────────────────

type ImportMeta = { sourceMtime: number; sourceSize: number };
type ImportType = "opencode_import" | "claude_import" | "codex_import";

/**
 * 读取目标 pi 会话文件头部 8 行，提取上次导入时记录的源 mtime/size。
 * 用于判断源文件是否已更新（new / current / outdated 三态）。
 * importType 区分不同源写入的 import 标记字段名。
 */
export async function readImportMeta(
	targetPath: string,
	importType: ImportType,
): Promise<ImportMeta | undefined> {
	try {
		const raw = await readFile(targetPath, "utf8");
		for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === importType) {
				return {
					sourceMtime: Number(entry.sourceMtime),
					sourceSize: Number(entry.sourceSize),
				};
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * 计算目标 pi 会话文件路径。
 * filePrefix 区分源（opencode_ / claude_ / codex_），id 经 safePathToken 后归入项目子目录。
 */
export function buildTargetPath(
	piRoot: string,
	projectPath: string,
	filePrefix: string,
	rawId: string,
): string {
	const id = rawId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(piRoot, safePathToken(projectPath), `${filePrefix}${id}.jsonl`);
}

// ── 状态判定 ─────────────────────────────────────────────

/**
 * 比对源文件 mtime/size 与上次导入记录，返回导入状态三态。
 * 三个旧 Importer 中逐字相同的逻辑。
 */
export function computeImportStatus(
	importMeta: ImportMeta | undefined,
	sourceMtime: number,
	sourceSize: number,
): "new" | "current" | "outdated" {
	if (!importMeta) return "new";
	if (importMeta.sourceMtime === sourceMtime && importMeta.sourceSize === sourceSize) {
		return "current";
	}
	return "outdated";
}
