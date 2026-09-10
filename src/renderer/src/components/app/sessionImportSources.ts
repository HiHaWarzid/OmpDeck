import type { PiDesktopApi } from "../../../../shared/api";
import type { ImportReport, ImportSummary } from "../../../../shared/types";
import type { TranslationKey } from "../../i18n";

/**
 * 会话导入源描述表 —— 三个导入源（Codex / Claude / OpenCode）的唯一差异清单。
 *
 * 三者共用同一套类型（ImportSummary/ImportReport）与同一套交互（扫描 → 勾选 → 导入 →
 * 报告），此前在 App 里各写一份 6 个 useState + 5 个 handler、在 ImportModals 里各写一个
 * 近乎相同的弹框。差异只有三处：api 命名空间、勾选默认策略、文案前缀（Codex 另有子代理
 * 分组展示）。集中到本表后，新增第四个源 = 加一行。
 */

export type ImportSourceId = "codex" | "claude" | "opencode";

/** 一个导入源的全部差异点。 */
export interface ImportSourceDescriptor {
  id: ImportSourceId;
  scan: (projectId: string) => Promise<ImportSummary[]>;
  import: (projectId: string, sourcePaths: string[]) => Promise<ImportReport>;
  /**
   * 扫描完成后的默认勾选集合。
   * Codex：默认勾选父会话（子代理会话不单列，避免重复导入）；其余源默认不勾选，
   * 因为导入会覆盖同名目标副本。
   */
  defaultSelection: (sessions: ImportSummary[]) => string[];
  /** 全选候选：Codex 排除子代理会话（它们随父会话导入）。 */
  selectablePaths: (sessions: ImportSummary[]) => string[];
  /** 是否按父子线程分组展示子代理（目前仅 Codex 有线程元数据）。 */
  grouped: boolean;
  labels: {
    title: TranslationKey;
    scanning: TranslationKey;
    emptyTitle: TranslationKey;
    emptyDesc: TranslationKey;
    importCount: TranslationKey;
    selectNone: TranslationKey;
    importing: TranslationKey;
    importSelected: TranslationKey;
    importDone: TranslationKey;
    scanFailed: TranslationKey;
    importFailed: TranslationKey;
    statusCurrent: TranslationKey;
    statusNew: TranslationKey;
    statusOutdated: TranslationKey;
    /** 子代理分组相关（grouped 为 true 时使用）。 */
    subagent?: TranslationKey;
    showSubagents?: TranslationKey;
    hideSubagents?: TranslationKey;
    orphanSubagents?: TranslationKey;
  };
}

/** 非子代理会话（Codex 线程元数据为空的也视为普通会话）。 */
function parentSessions(sessions: ImportSummary[]): ImportSummary[] {
  return sessions.filter((session) => session.threadSource !== "subagent");
}

export function createImportSources(api: PiDesktopApi): Record<ImportSourceId, ImportSourceDescriptor> {
  return {
    codex: {
      id: "codex",
      scan: (projectId) => api.codexSessions.scan(projectId),
      import: (projectId, sourcePaths) => api.codexSessions.import(projectId, sourcePaths),
      defaultSelection: (sessions) => parentSessions(sessions).map((session) => session.sourcePath),
      selectablePaths: (sessions) => parentSessions(sessions).map((session) => session.sourcePath),
      grouped: true,
      labels: {
        title: "codex.title",
        scanning: "codex.scanning",
        emptyTitle: "codex.emptyTitle",
        emptyDesc: "codex.emptyDesc",
        importCount: "codex.importCount",
        selectNone: "codex.selectNone",
        importing: "codex.importing",
        importSelected: "codex.importSelected",
        importDone: "codex.importDone",
        scanFailed: "codex.scanFailed",
        importFailed: "codex.importFailed",
        statusCurrent: "codex.status.current",
        statusNew: "codex.status.new",
        statusOutdated: "codex.status.outdated",
        subagent: "codex.subagent",
        showSubagents: "codex.showSubagents",
        hideSubagents: "codex.hideSubagents",
        orphanSubagents: "codex.orphanSubagents",
      },
    },
    claude: {
      id: "claude",
      scan: (projectId) => api.claudeSessions.scan(projectId),
      import: (projectId, sourcePaths) => api.claudeSessions.import(projectId, sourcePaths),
      defaultSelection: () => [],
      selectablePaths: (sessions) => sessions.map((session) => session.sourcePath),
      grouped: false,
      labels: {
        title: "claude.title",
        scanning: "claude.scanning",
        emptyTitle: "claude.emptyTitle",
        emptyDesc: "claude.emptyDesc",
        importCount: "claude.importCount",
        selectNone: "claude.selectNone",
        importing: "claude.importing",
        importSelected: "claude.importSelected",
        importDone: "claude.importDone",
        scanFailed: "claude.scanFailed",
        importFailed: "claude.importFailed",
        statusCurrent: "claude.status.current",
        statusNew: "claude.status.new",
        statusOutdated: "claude.status.outdated",
      },
    },
    opencode: {
      id: "opencode",
      scan: (projectId) => api.openCodeSessions.scan(projectId),
      import: (projectId, sourcePaths) => api.openCodeSessions.import(projectId, sourcePaths),
      defaultSelection: () => [],
      selectablePaths: (sessions) => sessions.map((session) => session.sourcePath),
      grouped: false,
      labels: {
        title: "opencode.title",
        scanning: "opencode.scanning",
        emptyTitle: "opencode.emptyTitle",
        emptyDesc: "opencode.emptyDesc",
        importCount: "opencode.importCount",
        selectNone: "opencode.selectNone",
        importing: "opencode.importing",
        importSelected: "opencode.importSelected",
        importDone: "opencode.importDone",
        scanFailed: "opencode.scanFailed",
        importFailed: "opencode.importFailed",
        statusCurrent: "opencode.status.current",
        statusNew: "opencode.status.new",
        statusOutdated: "opencode.status.outdated",
      },
    },
  };
}
