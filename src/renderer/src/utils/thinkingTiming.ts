import type { ChatMessage } from "../../../shared/types/message";

/**
 * 思考时机的来源：指出 startedAt 最终取自哪个优先级层级。
 * message = 消息已落库（thinkingStartedAt 最精确）；streaming = App 侧
 * streamingThinkingStartedAt（首次 thinking_delta 到达时记录）；run = 整轮会话起点。
 */
export type ThinkingTimingSource = "message" | "streaming" | "run" | "none";

export type ThinkingTiming = {
  startedAt: number | null;
  endedAt: number | null;
  /** 思考耗时：有合法 endedAt 用 endedAt，否则视为进行中使用 now 实时计时（逻辑与 ThinkingBlock 一致） */
  durationMs: number | null;
  source: ThinkingTimingSource;
};

/** 只读计时字段；全部可选——消息可能尚未落库 thinking 计时（如流式中间态），缺失即回退 */
type ThinkingTimingMessage = Partial<
  Pick<ChatMessage, "thinkingStartedAt" | "thinkingEndedAt" | "timestamp">
>;

/**
 * 计算一段思考的显示时机，收敛 TurnRow 两条分支（AppParts.tsx 已完成/流式）
 * 与 AppUtils 分组的重复推导。
 *
 * startedAt 优先级（与 TurnRow 双来源修复 2046f757 一致）：
 *   message.thinkingStartedAt（消息落库，最精确）→ streamingStartedAt（agent 级
 *   流式开始，首次 thinking_delta 到达时记录）→ runStartedAt（整轮起点）。
 *   仅当 options.timestampTier 时在 streaming 之前插入 message.timestamp 回退
 *   （AppUtils 分组路径原链 thinkingStartedAt ?? timestamp ?? runStartedAt 的形态；
 *   分组路径无 streaming 上下文，timestamp 是它仅有的次优起点）。
 *
 * endedAt 优先级：message.thinkingEndedAt → message.timestamp。
 * 注意原两条链在 timestamp 之后还会回退 run.endedAt；本函数签名不含 run 结束
 * 时间，该兜底由调用方在 swap-in 时决定（见变化报告），此处返回 null。
 *
 * 耗时语义与 ThinkingBlock 停表条件（0539ac07）保持一致：
 * - endedAt 缺失或早于 startedAt（新一轮思考已开始而旧结束标记未清）时，
 *   视为流式进行中，用 now 实时计时；
 * - startedAt 为 null 时整体返回 null（无思考计时）。
 *
 * 多段思考：AgentManager 在上一段结束时刷新 runtime.thinkingStartedAt 并清除
 * thinkingEndedAt，因此 message.thinkingStartedAt 恒为最新一段的起点，这里
 * 无需额外处理，直接从最新起点计时。
 */
export type ThinkingTimingOptions = {
  /**
   * startedAt 是否启用 message.timestamp 层级（分组路径原链形态）。
   * 单消息路径（TurnRow）不启用：消息尚未落库时 timestamp 与 streaming 几乎
   * 同时出现，streaming 起点更贴近真实思考开始时刻。
   */
  timestampTier?: boolean;
};

export function computeThinkingTiming(
  message: ThinkingTimingMessage | null | undefined,
  streamingStartedAt: number | null | undefined,
  runStartedAt: number | null | undefined,
  now: number,
  options?: ThinkingTimingOptions,
): ThinkingTiming {
  let startedAt: number | null = null;
  let source: ThinkingTimingSource = "none";
  const messageStartedAt = message?.thinkingStartedAt ?? null;
  if (messageStartedAt != null) {
    startedAt = messageStartedAt;
    source = "message";
  } else if (options?.timestampTier && message?.timestamp != null) {
    startedAt = message.timestamp;
    source = "message";
  } else if (streamingStartedAt != null) {
    startedAt = streamingStartedAt;
    source = "streaming";
  } else if (runStartedAt != null) {
    startedAt = runStartedAt;
    source = "run";
  }

  let endedAt: number | null = null;
  if (message?.thinkingEndedAt != null) {
    endedAt = message.thinkingEndedAt;
  } else if (message?.timestamp != null) {
    endedAt = message.timestamp;
  }

  let durationMs: number | null = null;
  if (startedAt != null) {
    // endedAt 早于 startedAt 视为残留数据（新一轮思考已开始而旧结束标记未清），
    // 仍按进行中实时计时，与 ThinkingBlock 的兜底逻辑保持一致。
    const base = endedAt != null && endedAt >= startedAt ? endedAt : now;
    durationMs = base - startedAt;
  }

  return { startedAt, endedAt, durationMs, source };
}