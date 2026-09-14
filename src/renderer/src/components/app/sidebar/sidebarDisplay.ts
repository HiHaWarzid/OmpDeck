import type { Project, SessionSummary } from "../../../../../shared/types";
import { t } from "../../../i18n";

/**
 * 侧栏行文案与谓词（批次 5c）：随侧栏抽取一起从 App.tsx 模块作用域搬出来，
 * 供侧栏组件与 App 侧复用（项目行、子会话行标题、拖拽守卫）。
 * 这些是「展示口径」，与 sidebarProjection（数据结构口径）分开，避免投影模块变成杂物间。
 */

export function displayProjectDirectoryName(project: Project) {
	if (isChatProject(project)) return "Chat";
	const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalizedPath.split("/").pop() || project.name || project.path;
}

export function isChatProject(project?: Project) {
	return project?.kind === "chat";
}

export function formatCodexSubagentName(session: SessionSummary) {
	const label = [session.codexAgentNickname, session.codexAgentRole]
		.filter(Boolean)
		.join(" · ");
	return label || session.name || t("app.codexSubagent");
}

/** pi 原生子会话名称：优先使用会话名，回退到 "子会话" */
export function formatPiSubagentName(session: SessionSummary) {
	return session.name || t("app.piSubagent");
}
