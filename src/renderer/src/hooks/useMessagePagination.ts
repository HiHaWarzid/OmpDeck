/**
 * 消息分页加载 Hook
 *
 * 只渲染"窗口"内的消息：首屏取最新一页，向上翻页继续加载历史。
 * 窗口有硬上限（maxVisibleMessages）：长会话里把上千条消息全量渲染成 DOM 会把渲染进程推到 GB 级
 * （实测约 170KB 堆/条 + 每张内嵌图片一份解码位图），这是渲染进程 OOM 的主因，所以上限不能是无穷。
 *
 * 窗口锚定规则（决定消息数变化时窗口怎么动）：
 * - 批量灌入（delta >= 10：首屏、基线重推、裁剪后重建）：只跟随尾部，窗口大小不变。
 * - 贴底跟随（followTail，调用方传 autoScroll）：窗口尾部锁在最新消息上；窗口未到上限时按新增条数扩窗，
 *   到上限后从顶部上收（自动滑窗），DOM 数量保持恒定。
 * - 用户在回看历史（followTail=false 且窗口已贴尾）：窗口绝对位置冻结，新消息不再塞进 DOM，
 *   否则每条流式增量都会把阅读位置往下顶；界面提供"回到最新"入口复位到尾部。
 * - 窗口不在尾部（翻页到历史中间）：保持不动。
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ChatMessage } from "../../../shared/types";

interface MessagePaginationOptions {
  messages: ChatMessage[];
  initialPageSize?: number;
  pageSize?: number;
  /** 渲染窗口上限（条）。默认 200；窗口超过上限后从顶部上收而不是继续增长。 */
  maxVisibleMessages?: number;
  enabled?: boolean;
  /** 会话/Agent 标识：变化时重置窗口，避免沿用上一个会话的窗口位置（否则窗口高水位会跨会话传染）。 */
  resetKey?: string;
  /** 是否贴底跟随最新消息（通常传 autoScroll）。false 表示用户正在回看历史，窗口冻结。 */
  followTail?: boolean;
}

interface MessagePaginationResult {
  visibleMessages: ChatMessage[];
  /** 窗口上方还有未渲染的历史消息。 */
  hasMore: boolean;
  /** 未渲染的历史消息条数（用于"加载更多"按钮文案）。 */
  messagesAbove: number;
  /** 未渲染的较新消息条数（回看历史且新消息到达时 > 0，用于"回到最新"入口）。 */
  messagesBelow: number;
  loadMore: () => void;
  /** 一次性把分页窗口扩展到包含指定索引的消息（用于会话定位跳转）。 */
  loadUntilIncluded: (index: number) => void;
  /** 把窗口复位到尾部（"回到最新"）。 */
  jumpToLatest: () => void;
  isLoading: boolean;
  reset: () => void;
  totalCount: number;
  visibleCount: number;
}

interface MessageWindow {
  /** 窗口起始下标（在完整 messages 数组中的绝对位置）。 */
  start: number;
  /** 窗口条数。 */
  size: number;
}

/** 消息数组条数变化时的窗口锚定输入（见文件头"窗口锚定规则"）。 */
export type WindowAnchorInput = {
  prev: MessageWindow;
  /** 上一次的消息总数。 */
  prevLen: number;
  /** 本次的消息总数。 */
  len: number;
  /** 是否贴底跟随（通常来自 autoScroll）。 */
  followTail: boolean;
  initialPageSize: number;
  maxVisible: number;
  /**
   * 本次变化在消息数组头部新增的条数（历史分页）。>0 时不按尾部锚定：
   * 窗口从顶部纳入新页并保持已有内容位置，避免 bulk 规则把视图打回最新消息。
   */
  prependCount?: number;
};

const DEFAULT_INITIAL_PAGE_SIZE = 100; // 首屏加载最近100条消息
const DEFAULT_PAGE_SIZE = 100; // 每次加载100条历史消息
/** 渲染窗口上限：超过后从顶部上收。200 条约 30~50MB DOM 级开销，足够阅读与定位。 */
const DEFAULT_MAX_VISIBLE = 200;
/** 单次新增达到该条数视为批量灌入（首屏/基线重推），不做流式扩窗。 */
const BULK_DELTA = 10;

/** 把窗口夹到 [0, total] 与上限内，保证 start/size 永远可用（消息被裁剪、会话切换后长度会变）。 */
function clampWindow(
  win: MessageWindow,
  total: number,
  initialPageSize: number,
  maxVisible: number,
): MessageWindow {
  const maxSize = Math.max(1, Math.min(maxVisible, total));
  const minSize = Math.max(1, Math.min(initialPageSize, maxSize));
  const size = Math.min(Math.max(win.size, minSize), maxSize);
  const start = Math.min(Math.max(win.start, 0), Math.max(0, total - size));
  return { start, size };
}

function tailWindow(len: number, size: number): MessageWindow {
  return { start: Math.max(0, len - size), size };
}

/**
 * 消息总数变化后窗口应移动到哪（纯函数，便于单测；规则见文件头"窗口锚定规则"）。
 *
 * 这里是渲染进程内存上限的守门人：任何分支的结果都经过 clampWindow，
 * 因此窗口条数永远不会超过 maxVisible，DOM 节点数不会随会话长度无限增长。
 * 只有"贴底跟随 + 少量新增"会扩窗（先扩到上限，再自动从顶部上收）。
 */
export function nextWindowAfterCountChange(input: WindowAnchorInput): MessageWindow {
  const { prev, prevLen, len, followTail, initialPageSize, maxVisible, prependCount = 0 } = input;
  if (len === prevLen) return prev;
  const delta = len - prevLen;
  // 历史分页在头部插入：窗口从顶部纳入新页，已有内容整体下移但位置不变。
  // 不能走 bulk 规则（会 tailWindow 跳回最新消息），也不能走流式扩窗。
  if (prependCount > 0) {
    const start = prev.start === 0 ? 0 : prev.start + prependCount;
    const size = Math.min(prev.size + prependCount, maxVisible);
    return clampWindow({ start, size }, len, initialPageSize, maxVisible);
  }
  // 消息变短（容量裁剪/压缩）：只做夹取，不改锚定策略。
  if (delta < 0) return clampWindow(prev, len, initialPageSize, maxVisible);
  // 批量灌入：跟随尾部，窗口大小不变（打开旧会话仍只渲染首屏一页）。
  if (delta >= BULK_DELTA) {
    return clampWindow(tailWindow(len, prev.size), len, initialPageSize, maxVisible);
  }
  // 窗口不在尾部（已翻页到历史中间）：不动，避免把用户正在看的内容顶走。
  if (prev.start + prev.size < prevLen) return prev;
  // 用户在回看历史：冻结窗口，最新消息暂不渲染，由"回到最新"入口复位。
  if (!followTail) return prev;
  // 流式追加：先扩窗到上限，到上限后由 tailWindow 自动从顶部上收。
  const size = Math.min(prev.size + delta, maxVisible);
  return clampWindow(tailWindow(len, size), len, initialPageSize, maxVisible);
}

export function useMessagePagination({
  messages,
  initialPageSize = DEFAULT_INITIAL_PAGE_SIZE,
  pageSize = DEFAULT_PAGE_SIZE,
  maxVisibleMessages = DEFAULT_MAX_VISIBLE,
  enabled = true,
  resetKey,
  followTail = true,
}: MessagePaginationOptions): MessagePaginationResult {
  const [win, setWin] = useState<MessageWindow>(() =>
    tailWindow(messages.length, initialPageSize),
  );
  const [isLoading, setIsLoading] = useState(false);

  // followTail 只作为"要不要跟随"的开关读取，不参与 effect 依赖：滚动位置的抖动不应重建窗口逻辑。
  const followTailRef = useRef(followTail);
  followTailRef.current = followTail;

  // 切换会话/重新启用分页时复位到"首屏一页"：不沿用上一个会话的窗口大小与位置，
  // 否则在一个大会话里翻页后，之后每个会话都会先渲染同样多的消息。
  useEffect(() => {
    if (!enabled) return;
    setWin(tailWindow(messages.length, initialPageSize));
    setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在会话标识/开关变化时复位
  }, [resetKey, enabled, initialPageSize]);

  // 跟踪上一次的完整消息数量，用于区分"新增消息（流式追加）"与"基线重推/裁剪"。
  const prevMessageCountRef = useRef(messages.length);
  /** 最新消息数组：仅在长度变化时读取首条 id，用于识别历史分页的头部插入。 */
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const prevFirstIdRef = useRef<string | undefined>(messages[0]?.id);

  // 会话切换时同步锚点引用。否则新会话消息数与旧会话相同时，下一次历史页插入会拿
  // 旧会话的首条 id 去 findIndex，识别不出头部插入，窗口可能跳回尾部。
  useEffect(() => {
    prevMessageCountRef.current = messages.length;
    prevFirstIdRef.current = messages[0]?.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在会话标识变化时重置锚点
  }, [resetKey]);

  useEffect(() => {
    const len = messages.length;
    const prevLen = prevMessageCountRef.current;
    prevMessageCountRef.current = len;
    const current = messagesRef.current;
    const oldFirstId = prevFirstIdRef.current;
    const oldFirstIndex = len > prevLen && oldFirstId
      ? current.findIndex((message) => message.id === oldFirstId)
      : -1;
    prevFirstIdRef.current = current[0]?.id;
    setWin((prev) =>
      nextWindowAfterCountChange({
        prev,
        prevLen,
        len,
        followTail: followTailRef.current,
        initialPageSize,
        maxVisible: maxVisibleMessages,
        prependCount: oldFirstIndex > 0 ? oldFirstIndex : 0,
      }),
    );
  }, [messages.length, enabled, initialPageSize, maxVisibleMessages]);

  // 加载更多历史消息（向上翻页）。
  const loadMore = useCallback(() => {
    if (!enabled || isLoading) return;

    setIsLoading(true);

    // 模拟异步加载，使用 requestAnimationFrame 保持流畅
    requestAnimationFrame(() => {
      setWin((prev) => {
        if (prev.start <= 0) return prev;
        const end = prev.start + prev.size;
        const start = Math.max(0, prev.start - pageSize);
        // 顶部往外扩；到上限后从底部收（窗口大小不变），保证 DOM 有界。
        // 滚动位置由调用方按锚点元素位移补偿，所以这里可以自由调整窗口两端。
        return clampWindow(
          { start, size: Math.min(end, start + maxVisibleMessages) - start },
          messages.length,
          initialPageSize,
          maxVisibleMessages,
        );
      });
      setIsLoading(false);
    });
  }, [
    enabled,
    isLoading,
    pageSize,
    maxVisibleMessages,
    messages.length,
    initialPageSize,
  ]);

  // 一次性把分页窗口移到包含 `index`（在完整 messages 数组中的下标），并把该消息放在窗口顶部附近。
  // 用于右侧"会话定位"点击未加载的旧消息时，先把该消息加载进可视范围再滚动定位。
  const loadUntilIncluded = useCallback(
    (index: number) => {
      if (!enabled || index < 0 || index >= messages.length) return;
      setWin((prev) => {
        const start = Math.max(0, index - 1);
        const size = Math.max(prev.size, Math.min(index + 1 - start, maxVisibleMessages));
        return clampWindow(
          { start, size },
          messages.length,
          initialPageSize,
          maxVisibleMessages,
        );
      });
    },
    [enabled, messages.length, initialPageSize, maxVisibleMessages],
  );

  const len = messages.length;

  const jumpToLatest = useCallback(() => {
    setWin((prev) =>
      clampWindow(tailWindow(len, prev.size), len, initialPageSize, maxVisibleMessages),
    );
  }, [len, initialPageSize, maxVisibleMessages]);

  const reset = useCallback(() => {
    setWin(tailWindow(len, initialPageSize));
    setIsLoading(false);
  }, [len, initialPageSize]);

  // 可见窗口：状态里的 start 可能因为消息数组被整体替换而失效，这里再夹一次兜底。
  const visibleMessages = useMemo(() => {
    if (!enabled) return messages;
    const size = Math.min(Math.max(win.size, 1), Math.max(1, len));
    const start = Math.min(Math.max(win.start, 0), Math.max(0, len - size));
    return messages.slice(start, start + size);
  }, [messages, win.start, win.size, enabled, len]);

  return {
    visibleMessages,
    hasMore: enabled && win.start > 0 && len > 0,
    messagesAbove: enabled ? Math.min(Math.max(win.start, 0), len) : 0,
    messagesBelow: enabled ? Math.max(0, len - (win.start + win.size)) : 0,
    loadMore,
    loadUntilIncluded,
    jumpToLatest,
    isLoading,
    reset,
    totalCount: len,
    visibleCount: visibleMessages.length,
  };
}
