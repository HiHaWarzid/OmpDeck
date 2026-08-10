export type FileTreeNode = {
	name: string;
	path: string;
	relativePath: string;
	type: "file" | "directory";
	children?: FileTreeNode[];
};

export type SessionSummary = {
	id: string;
	filePath: string;
	projectPath?: string;
	name?: string;
	/** 子会话：关联的父会话文件路径。有该字段时不在会话列表顶层显示，而是嵌套在父会话下。 */
	parentSessionPath?: string;
	preview: string;
	updatedAt: number;
	messageCount: number;
	/** 会话来源：pi 原生、Codex 导入、Claude 导入、OpenCode 导入 */
	source?: "pi" | "codex" | "claude" | "opencode";
	/** 标记此会话文件来自 WSL，rename/delete/copy 等操作需走 wsl.exe */
	wsl?: boolean;
	/**
	 * 会话文件部分损坏（存在无法解析的 JSONL 行，如截断写入/编码残留）。
	 * 列表仍展示该会话，但 messageCount 与预览可能不完整，UI 应给出提示。
	 */
	degraded?: boolean;
	codexSessionId?: string;
	codexThreadSource?: "user" | "subagent";
	codexParentThreadId?: string;
	codexAgentRole?: string;
	codexAgentNickname?: string;
};

// ── 会话导入统一类型 ───────────────────────────────────
// 三个源（OpenCode / Claude / Codex）共用一套类型，消除重复定义。
// Codex 线程元数据（threadSource 等）作为可选属性，仅 Codex 源有值。

export type ImportStatus = "new" | "current" | "outdated";

export type ImportSummary = {
	id: string;
	sourcePath: string;
	targetPath: string;
	cwd: string;
	title: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	status: ImportStatus;
	sourceSize: number;
	importedSourceMtime?: number;
	// Codex 线程元数据：子代理会话溯源，仅 Codex 源有值
	threadSource?: "user" | "subagent";
	parentThreadId?: string;
	agentRole?: string;
	agentNickname?: string;
};

export type ImportResult = {
	id: string;
	sourcePath: string;
	targetPath?: string;
	title?: string;
	success: boolean;
	overwritten?: boolean;
	messageCount?: number;
	error?: string;
};

export type ImportReport = {
	results: ImportResult[];
	imported: number;
	failed: number;
};

// ── 旧类型别名（renderer 零感知，渐进迁移） ────────────
export type CodexImportStatus = ImportStatus;
export type CodexSessionSummary = ImportSummary;
export type CodexImportResult = ImportResult;
export type CodexImportReport = ImportReport;
export type ClaudeImportStatus = ImportStatus;
export type ClaudeSessionSummary = ImportSummary;
export type ClaudeImportResult = ImportResult;
export type ClaudeImportReport = ImportReport;
export type OpenCodeImportStatus = ImportStatus;
export type OpenCodeSessionSummary = ImportSummary;
export type OpenCodeImportResult = ImportResult;
export type OpenCodeImportReport = ImportReport;
