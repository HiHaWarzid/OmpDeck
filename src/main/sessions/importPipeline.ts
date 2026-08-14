import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ImportReport, ImportResult, ImportStatus, ImportSummary } from "../../shared/types";
import {
	buildTargetPath,
	computeImportStatus,
	readImportMeta,
	safePathToken,
} from "./importShared";

/**
 * 会话导入管线 -- 把外部编码助手（OpenCode / Claude / Codex）的历史会话
 * 统一导入为 pi 可读的 JSONL 格式。
 *
 * 设计：pipeline 拥有全部 8 步编排（scan / import / status / path / meta / convert / write / report），
 * 适配器只暴露 discover + convert 两个方法。pipeline 是 deep module：
 * 小 interface（scan + import），大 implementation（全部编排逻辑在此）。
 *
 * 路径通过构造函数注入，app.getPath() 只在 index.ts 实例化时调用一次，
 * 使 pipeline 和适配器可在 Electron 上下文外构造（可测试）。
 */

export type { ImportReport, ImportResult, ImportStatus, ImportSummary } from "../../shared/types";

export type ImportSource = "opencode" | "claude" | "codex";

// ── 适配器 interface ────────────────────────────────────

/**
 * discover：从源格式中扫描项目相关的会话，返回解析后的原始会话列表。
 * convert：将单个解析后的会话转为 pi JSONL 格式。
 *
 * 适配器只负责"读源格式"和"转 pi 格式"，所有编排逻辑在 pipeline 中。
 */
export interface SourceAdapter {
	/** 源标识，用于 pipeline 路由和 import type tag */
	readonly source: ImportSource;
	/** JSONL 文件前缀，如 "opencode_" / "claude_" / "codex_" */
	readonly filePrefix: string;
	/** 扫描源中属于该项目的会话 */
	discover(projectPath: string): Promise<ParsedSession[]>;
	/** 将单个会话转为 pi JSONL 格式 */
	convert(projectPath: string, session: ParsedSession): ConvertedSession;
	/**
	 * 轻量摘要（可选）：scan 列表只需要 title/preview/messageCount。
	 * 实现应跳过完整 pi JSONL 行构造（convert 的 raw 是大头），只遍历源条目
	 * 提取三项，且必须与 convert 的结果完全一致。未提供时 pipeline 回退 convert。
	 */
	summarize?(projectPath: string, session: ParsedSession): { title: string; preview: string; messageCount: number };
}

/**
 * 适配器 discover 返回的解析后会话。
 * meta 和 entries 的结构由各源格式决定，pipeline 不关心其内部形状。
 */
export interface ParsedSession {
	/** 源中的会话标识 */
	id: string;
	/** 源文件路径（或 SQLite 中虚拟路径如 db#sessionId） */
	sourcePath: string;
	/** 源文件大小（字节） */
	sourceSize: number;
	/** 源文件最后修改时间（ms） */
	sourceMtime: number;
	/** 源格式原始元数据 */
	meta: Record<string, unknown>;
	/** 源格式原始条目（消息列表） */
	entries: unknown;
	/** 会话 cwd（用于 summary） */
	cwd: string;
	/** 创建时间戳（ms） */
	createdAt: number;
	/** 更新时间戳（ms） */
	updatedAt: number;
	/** 可选的线程元数据（Codex） */
	threadSource?: "user" | "subagent";
	parentThreadId?: string;
	agentRole?: string;
	agentNickname?: string;
}

/**
 * 适配器 convert 返回的转换结果。
 */
export interface ConvertedSession {
	/** pi JSONL 格式的完整文件内容 */
	raw: string;
	/** 会话标题 */
	title: string;
	/** 预览文本 */
	preview: string;
	/** 消息条数 */
	messageCount: number;
}

// ── pipeline ────────────────────────────────────────────

export class ImportPipeline {
	private readonly adapters = new Map<ImportSource, SourceAdapter>();
	private readonly piRoot: string;

	constructor(piRoot: string) {
		this.piRoot = piRoot;
	}

	registerAdapter(adapter: SourceAdapter): void {
		this.adapters.set(adapter.source, adapter);
	}

	private getAdapter(source: ImportSource): SourceAdapter {
		const adapter = this.adapters.get(source);
		if (!adapter) throw new Error(`No adapter registered for source: ${source}`);
		return adapter;
	}

	/**
	 * 扫描指定源的会话，返回按更新时间降序排列的摘要列表。
	 * 编排：discover -> 逐个 toSummary -> 排序
	 */
	async scan(source: ImportSource, projectPath: string): Promise<ImportSummary[]> {
		const adapter = this.getAdapter(source);
		const sessions = await adapter.discover(projectPath);
		const summaries = await Promise.all(
			sessions.map((session) => this.toSummary(adapter, session, projectPath)),
		);
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * 导入指定源的会话到 pi 会话目录。
	 * 编排：逐个 importOne（解析 -> getTargetPath -> readImportMeta -> convert -> mkdir+write -> 汇总）
	 */
	async import(
		source: ImportSource,
		projectPath: string,
		sourcePaths: string[],
	): Promise<ImportReport> {
		const adapter = this.getAdapter(source);
		// discover 一次拿到所有会话，按 sourcePath 索引，避免逐文件重复解析
		const sessions = await adapter.discover(projectPath);
		const bySourcePath = new Map(sessions.map((s) => [s.sourcePath, s]));

		const results: ImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(adapter, projectPath, sourcePath, bySourcePath.get(sourcePath)));
		}
		return {
			results,
			imported: results.filter((r) => r.success).length,
			failed: results.filter((r) => !r.success).length,
		};
	}

	/**
	 * 导入单个会话。
	 * OpenCode 的 sourcePath 是虚拟路径（db#sessionId），需要从 discover 结果中查找；
	 * Claude/Codex 的 sourcePath 是真实文件路径，importOne 内部会重新读取。
	 * 因此 parsed 参数可选：有则直接用，无则由适配器在 convert 时处理。
	 */
	private async importOne(
		adapter: SourceAdapter,
		projectPath: string,
		sourcePath: string,
		parsed?: ParsedSession,
	): Promise<ImportResult> {
		try {
			if (!parsed) throw new Error(`${adapter.source} session not found: ${sourcePath}`);
			const targetPath = buildTargetPath(this.piRoot, projectPath, adapter.filePrefix, parsed.id);
			const existing = await readImportMeta(targetPath, this.importType(adapter.source));
			const converted = adapter.convert(projectPath, parsed);
			await mkdir(join(this.piRoot, safePathToken(projectPath)), { recursive: true });
			await writeFile(targetPath, converted.raw, "utf8");
			return {
				id: parsed.id,
				sourcePath,
				targetPath,
				title: converted.title,
				success: true,
				overwritten: Boolean(existing),
				messageCount: converted.messageCount,
			};
		} catch (error) {
			return {
				id: sourcePath,
				sourcePath,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * 为单个会话生成摘要，包含导入状态三态判定。
	 */
	private async toSummary(
		adapter: SourceAdapter,
		session: ParsedSession,
		projectPath: string,
	): Promise<ImportSummary> {
		const targetPath = buildTargetPath(this.piRoot, projectPath, adapter.filePrefix, session.id);
		const importMeta = await readImportMeta(targetPath, this.importType(adapter.source));
		// 轻量摘要：适配器提供 summarize 时跳过完整 JSONL 行构造（scan 只消费
		// title/preview/messageCount，convert 的 raw 对 N 个会话是纯浪费）
		let summary: { title: string; preview: string; messageCount: number };
		if (adapter.summarize) {
			summary = adapter.summarize(projectPath, session);
		} else {
			const converted = adapter.convert(projectPath, session);
			summary = {
				title: converted.title,
				preview: converted.preview,
				messageCount: converted.messageCount,
			};
		}
		const status = computeImportStatus(importMeta, session.sourceMtime, session.sourceSize);

		return {
			id: session.id,
			sourcePath: session.sourcePath,
			targetPath,
			cwd: session.cwd,
			title: summary.title,
			preview: summary.preview,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			messageCount: summary.messageCount,
			status,
			sourceSize: session.sourceSize,
			importedSourceMtime: importMeta?.sourceMtime,
			threadSource: session.threadSource,
			parentThreadId: session.parentThreadId,
			agentRole: session.agentRole,
			agentNickname: session.agentNickname,
		};
	}

	/**
	 * 将 source 映射为 pi JSONL 中的 import type tag。
	 */
	private importType(source: ImportSource): "opencode_import" | "claude_import" | "codex_import" {
		switch (source) {
			case "opencode":
				return "opencode_import";
			case "claude":
				return "claude_import";
			case "codex":
				return "codex_import";
		}
	}
}
