import type { ComposerAgentMode } from "../../../../shared/types";
import type { EntryKind, WorkspaceAction } from "../sessionWorkspace";

/**
 * composer 交互切片（切片 1 迁入）：按条目的发送模式与忙碌草稿标志。
 *
 * 对应 App 原两张 per-agent 键控 map（已删除）：
 * - composerAgentModes[agentId]（Record<agentId, ComposerAgentMode>）
 * - busyDraftByAgent[agentId]（用户忙碌时开始撰写，保留分段发送控件）
 * 条目键 = 活体 agent tab id，tab 生灭即条目生灭——busyDraft/模式随 tab 重置，
 * 与迁移前按 agentId 键控的语义逐点等价（重启/替换 agent 即全新状态）。
 */

export interface ComposerState {
  /** 输入框发送模式（normal 直接执行 / plan 只读触发计划）。默认 normal。 */
  mode: ComposerAgentMode;
  /** 用户在该条目忙碌期间是否已开始撰写（驱动分段发送控件显隐）。 */
  busyDraft: boolean;
}

export type ComposerAction =
  | { type: "composer/setMode"; mode: ComposerAgentMode }
  | { type: "composer/setBusyDraft"; busyDraft: boolean };

export const composerActions = {
  setMode: (mode: ComposerAgentMode): ComposerAction => ({
    type: "composer/setMode",
    mode,
  }),
  setBusyDraft: (busyDraft: boolean): ComposerAction => ({
    type: "composer/setBusyDraft",
    busyDraft,
  }),
};

export const composerSlice = {
  name: "composer",

  seed(_kind: EntryKind): ComposerState {
    // 默认 normal；历史会话恢复时由上层按需 setMode（plan 模式不落盘）
    return { mode: "normal", busyDraft: false };
  },

  reduce(state: ComposerState, action: WorkspaceAction): ComposerState {
    switch (action.type) {
      case "composer/setMode": {
        const { mode } = action as Extract<ComposerAction, { type: "composer/setMode" }>;
        return state.mode === mode ? state : { ...state, mode };
      }
      case "composer/setBusyDraft": {
        const { busyDraft } = action as Extract<
          ComposerAction,
          { type: "composer/setBusyDraft" }
        >;
        return state.busyDraft === busyDraft ? state : { ...state, busyDraft };
      }
      default:
        return state; // 非本切片动作：原引用，引用相等即"无变更"
    }
  },
};
