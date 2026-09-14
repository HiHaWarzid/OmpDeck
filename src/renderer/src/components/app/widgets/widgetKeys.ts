/** 扩展 widget 的持久化 key：App 与 widget 卡片都要用；放在无组件的 .ts 中避免 Fast Refresh 整页刷新。 */

/** Todo / Plan 两个扩展各自 setWidget，桌面端合成一张任务卡时用此 key 做折叠持久化。 */
export const MERGED_TASK_WIDGET_KEY = "pi-deck-task-board";
export const TODO_WIDGET_KEY = "pi-deck-todo";
export const PLAN_WIDGET_KEY = "pi-deck-plan-todos";
