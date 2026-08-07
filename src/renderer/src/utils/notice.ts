/**
 * 统一通知接口，内部使用 sonner 实现。
 *
 * showNotice(message, duration?, kind?) — 全局通知，非模态。
 * sonner 的 <Toaster /> 已在 App 根渲染，自动展示所有通知。
 *
 * 通知类型映射：
 *   "error"   → sonner error
 *   "warning" → sonner warning
 *   "info"    → sonner info（默认）
 */

import { toast } from "sonner";

export type NoticeKind = "info" | "error" | "warning";

/**
 * 显示全局通知。
 *
 * @param message  通知文本
 * @param duration 显示时长（ms），默认 3500
 * @param kind     通知类型：info / error / warning，默认 info
 */
export function showNotice(message: string, duration = 3500, kind?: NoticeKind) {
  const text = String(message ?? "").trim();
  if (!text) return;

  // 将 duration 转为 sonner 的 duration 选项
  // sonner 默认 4000ms，按需覆盖
  const options = { duration };

  switch (kind) {
    case "error":
      toast.error(text, options);
      break;
    case "warning":
      toast.warning(text, options);
      break;
    default:
      toast.info(text, options);
      break;
  }
}
