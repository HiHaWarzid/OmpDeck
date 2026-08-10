import type { SessionSummary } from "../../../shared/types";

/** 浅比较两个 SessionSummary 列表是否等效，用于避免 setState 触发不必要渲染。 */
export function sameSessionSummaryList(
  previous: SessionSummary[],
  next: SessionSummary[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((a, i) => {
    const b = next[i];
    return (
      a.id === b.id &&
      a.updatedAt === b.updatedAt &&
      a.name === b.name &&
      a.projectPath === b.projectPath &&
      // degraded 参与比较：会话由健康转为损坏（或反之）时需触发重渲染更新警告徽标。
      a.degraded === b.degraded
    );
  });
}
