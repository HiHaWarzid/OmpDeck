/**
 * extension widget 关闭态（用户点掉 widget 后的持久记录）。
 *
 * 键空间说明：widget **内容**按条目键（活体 agent tab id）存在 SessionWorkspace，
 * 关闭态必须跨重启保留，因此落盘键用 `sessionPath`——它是唯一在重启后仍稳定的
 * 身份。两者不是同一把键，这个映射只在「读取关闭态」一处发生：`isWidgetDismissed`
 * 接受调用方给的稳定键，不假设它等于条目键。
 *
 * 收敛原因：原实现把「校验 localStorage 形状 / 追加去重 / 无变更保持原引用」写在
 * App 根组件的 JSX 闭包里，既无法单测，也让同一规则在两个写入点各写一遍。
 * 这里只放纯函数，持久化由调用方的 usePersistedState 负责。
 */

export const DISMISSED_EXTENSION_WIDGETS_STORAGE_KEY =
  "pid:extension-widget-dismissed-by-session";

/** sessionPath → 已关闭的 widgetKey 列表。 */
export type DismissedWidgetRecord = Record<string, readonly string[]>;

/**
 * 校验并收紧 localStorage 里的历史数据：非对象/数组项/非字符串项一律丢弃，
 * 不因一条脏数据丢掉整份关闭态。
 */
export function normalizeDismissedWidgets(raw: unknown): DismissedWidgetRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [sessionKey, widgetKeys] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(widgetKeys)) continue;
    const keys = widgetKeys.filter((key): key is string => typeof key === "string" && key !== "");
    if (keys.length > 0) result[sessionKey] = keys;
  }
  return result;
}

export function isWidgetDismissed(
  record: DismissedWidgetRecord,
  sessionKey: string | undefined,
  widgetKey: string,
): boolean {
  if (!sessionKey) return false;
  return record[sessionKey]?.includes(widgetKey) ?? false;
}

/**
 * 追加关闭项。全部已存在时返回原引用——调用方据此跳过落盘与重渲染
 * （关闭按钮同样可能被重复触发）。
 */
export function dismissWidgetKeys(
  record: DismissedWidgetRecord,
  sessionKey: string | undefined,
  widgetKeys: readonly string[],
): DismissedWidgetRecord {
  if (!sessionKey || widgetKeys.length === 0) return record;
  const current = record[sessionKey] ?? [];
  const merged = [...current];
  let changed = false;
  for (const key of widgetKeys) {
    if (!merged.includes(key)) {
      merged.push(key);
      changed = true;
    }
  }
  if (!changed) return record;
  return { ...record, [sessionKey]: merged };
}

/**
 * 移除某会话的关闭态（会话级"恢复已关闭 widget"或清理已删除会话时使用）。
 * 无该键时返回原引用。
 */
export function resetDismissedWidgets(
  record: DismissedWidgetRecord,
  sessionKey: string,
): DismissedWidgetRecord {
  if (!(sessionKey in record)) return record;
  const next = { ...record };
  delete next[sessionKey];
  return next;
}

/**
 * 移除单个关闭项：扩展重新推送该 widget 内容时调用，让被关闭的 widget 恢复显示。
 * 未关闭时返回原引用（推送 widget 是高频路径，不得因重复内容触发重渲染/落盘）。
 */
export function restoreWidgetKey(
  record: DismissedWidgetRecord,
  sessionKey: string | undefined,
  widgetKey: string,
): DismissedWidgetRecord {
  if (!sessionKey) return record;
  const current = record[sessionKey];
  if (!current?.includes(widgetKey)) return record;
  const keys = current.filter((key) => key !== widgetKey);
  if (keys.length === 0) {
    const next = { ...record };
    delete next[sessionKey];
    return next;
  }
  return { ...record, [sessionKey]: keys };
}
