import { useCallback, useMemo, useReducer } from "react";
import type { ImportReport, ImportSummary, Project } from "../../../shared/types";
import type { ImportSourceDescriptor, ImportSourceId } from "../components/app/sessionImportSources";

/**
 * 会话导入流程（扫描 → 勾选 → 导入 → 报告）—— 一个状态机，三个导入源共用。
 *
 * 此前 App 里每源各写 6 个 useState（project/sessions/selected/loading/running/report）
 * 与 5 个 handler，三份几乎逐字相同，只在 api 命名空间、默认勾选与文案前缀上不同。
 * 这里收成一个 reducer，源差异全部落在 ImportSourceDescriptor 表，副作用与文案由
 * 调用方注入（hook 不碰 i18n、不碰 toast、不碰会话列表刷新）。
 *
 * 同一时刻只可能打开一个导入弹框，因此只保留一份流程状态，用 sourceId 记住当前源。
 */

export type ImportPhase = "idle" | "scanning" | "ready" | "importing" | "done";

export interface SessionImportFlow {
  phase: ImportPhase;
  /** 当前流程所属导入源；未打开时为 null。 */
  sourceId: ImportSourceId | null;
  project: Project | null;
  sessions: ImportSummary[];
  selectedPaths: string[];
  report: ImportReport | null;
  allSelected: boolean;
  /** 打开弹框（指定源）并立即扫描。 */
  open(sourceId: ImportSourceId, project: Project): Promise<void>;
  close(): void;
  /** 重新扫描（等价弹框里的刷新按钮）。 */
  refresh(): Promise<void>;
  toggle(sourcePath: string): void;
  toggleAll(): void;
  runImport(): Promise<void>;
}

type State = {
  phase: ImportPhase;
  sourceId: ImportSourceId | null;
  project: Project | null;
  sessions: ImportSummary[];
  selectedPaths: string[];
  report: ImportReport | null;
};

type Action =
  | { type: "open"; sourceId: ImportSourceId; project: Project }
  | { type: "close" }
  | { type: "scanStart"; clearReport: boolean }
  | { type: "scanDone"; sessions: ImportSummary[]; selectedPaths: string[] }
  | { type: "scanFailed" }
  | { type: "toggle"; sourcePath: string }
  | { type: "toggleAll"; allPaths: string[] }
  | { type: "importStart" }
  | { type: "importDone"; report: ImportReport }
  | { type: "importFailed" };

const IDLE: State = {
  phase: "idle",
  sourceId: null,
  project: null,
  sessions: [],
  selectedPaths: [],
  report: null,
};

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "open":
      return { ...IDLE, phase: "scanning", sourceId: action.sourceId, project: action.project };
    case "close":
      return IDLE;
    case "scanStart":
      return { ...state, phase: "scanning", report: action.clearReport ? null : state.report };
    case "scanDone":
      return {
        ...state,
        phase: "ready",
        sessions: action.sessions,
        selectedPaths: action.selectedPaths,
      };
    case "scanFailed":
      // 扫描失败保留弹框（用户可点刷新重试），只结束 loading
      return { ...state, phase: "ready" };
    case "toggle": {
      const selected = state.selectedPaths.includes(action.sourcePath)
        ? state.selectedPaths.filter((path) => path !== action.sourcePath)
        : [...state.selectedPaths, action.sourcePath];
      return { ...state, selectedPaths: selected };
    }
    case "toggleAll": {
      const all = action.allPaths;
      const everythingSelected =
        all.length > 0 && all.every((path) => state.selectedPaths.includes(path));
      return { ...state, selectedPaths: everythingSelected ? [] : all };
    }
    case "importStart":
      return { ...state, phase: "importing", report: null };
    case "importDone":
      return { ...state, phase: "done", report: action.report };
    case "importFailed":
      // 失败后回到可重试状态，保留勾选与已扫描列表
      return { ...state, phase: "ready" };
    default:
      return state;
  }
}

export function useSessionImport(options: {
  /** 源描述表查询（生产传 createImportSources(api) 的结果）。 */
  resolveSource: (sourceId: ImportSourceId) => ImportSourceDescriptor;
  /** 扫描/导入失败：调用方本地化并提示（文案前缀取自源的 labels）。 */
  onError: (sourceId: ImportSourceId, phase: "scan" | "import", message: string) => void;
  /** 导入成功：调用方提示结果并刷新会话列表。 */
  onImported: (sourceId: ImportSourceId, report: ImportReport, project: Project) => Promise<void>;
}): SessionImportFlow {
  const { resolveSource, onError, onImported } = options;
  const [state, dispatch] = useReducer(reduce, IDLE);
  const { sourceId, project, sessions, selectedPaths } = state;
  const source = sourceId ? resolveSource(sourceId) : null;

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const scan = useCallback(
    async (target: ImportSourceId, targetProject: Project, clearReport: boolean) => {
      const descriptor = resolveSource(target);
      dispatch({ type: "scanStart", clearReport });
      try {
        const scanned = await descriptor.scan(targetProject.id);
        dispatch({
          type: "scanDone",
          sessions: scanned,
          selectedPaths: descriptor.defaultSelection(scanned),
        });
      } catch (error) {
        onError(target, "scan", message(error));
        dispatch({ type: "scanFailed" });
      }
    },
    [resolveSource, onError],
  );

  const open = useCallback(
    async (target: ImportSourceId, targetProject: Project) => {
      dispatch({ type: "open", sourceId: target, project: targetProject });
      await scan(target, targetProject, true);
    },
    [scan],
  );

  const close = useCallback(() => dispatch({ type: "close" }), []);

  const refresh = useCallback(async () => {
    if (!sourceId || !project) return;
    await scan(sourceId, project, true);
  }, [scan, sourceId, project]);

  const toggle = useCallback((sourcePath: string) => dispatch({ type: "toggle", sourcePath }), []);

  const toggleAll = useCallback(() => {
    if (!source) return;
    dispatch({ type: "toggleAll", allPaths: source.selectablePaths(sessions) });
  }, [source, sessions]);

  const runImport = useCallback(async () => {
    if (!sourceId || !project || selectedPaths.length === 0) return;
    const descriptor = resolveSource(sourceId);
    dispatch({ type: "importStart" });
    try {
      const report = await descriptor.import(project.id, selectedPaths);
      dispatch({ type: "importDone", report });
      // 重扫时保留刚拿到的报告（clearReport=false），否则用户看不到导入结果
      await scan(sourceId, project, false);
      await onImported(sourceId, report, project);
    } catch (error) {
      onError(sourceId, "import", message(error));
      dispatch({ type: "importFailed" });
    }
  }, [sourceId, project, selectedPaths, resolveSource, scan, onImported, onError]);

  const allSelected = useMemo(() => {
    if (!source) return false;
    const paths = source.selectablePaths(sessions);
    return paths.length > 0 && paths.every((path) => selectedPaths.includes(path));
  }, [source, sessions, selectedPaths]);

  return {
    phase: state.phase,
    sourceId,
    project,
    sessions,
    selectedPaths,
    report: state.report,
    allSelected,
    open,
    close,
    refresh,
    toggle,
    toggleAll,
    runImport,
  };
}
