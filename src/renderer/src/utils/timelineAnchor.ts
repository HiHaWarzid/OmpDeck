/**
 * 时间线翻页时的滚动锚点选择规则。
 *
 * 翻页/滑窗会在窗口顶部插入旧消息（到达窗口上限后还会从底部收走最新消息），
 * 浏览器保持 scrollTop 不变会让用户正在看的消息上下跳动，因此需要在重渲染后按锚点位移补偿
 * scrollTop。锚点选得对不对，直接决定补偿能否生效：
 *
 * - 不能锚在窗口首行：窗口顶端那一行可能落在分组中间，补全该分组后它的 data-message-id 会变
 *   （如 "t550|t551" → "a549|t550|t551"），按 id 找不到元素，补偿直接被跳过。
 * - 不能锚在屏幕外的行：窗口默认能装 200 条（几十屏），窗口首行常在视口外上万像素。按屏幕外的
 *   行补偿时要求的 scrollTop 会超出可滚动范围而被浏览器夹掉（到达上限后翻页是"顶部加、底部收"，
 *   总高度不再增长），补偿失效、视图照样跳。
 *
 * 所以规则是：取视口内首行；若它正好是窗口首行，则退到次行（完整分组且仍在视口附近）。
 */

/** 一行在时间线里的视口几何与稳定标识。 */
export interface TimelineAnchorRow {
  /** 行的稳定标识（data-message-id），翻页后用于找回同一行。 */
  id: string;
  /** 行相对滚动容器顶部的视口坐标。 */
  rectTop: number;
  /** 行相对滚动容器顶部的视口底边坐标。 */
  rectBottom: number;
}

export interface TimelineAnchor {
  id: string;
  /** 行的视口坐标，用于重渲染后按位移补偿 scrollTop。 */
  top: number;
}

/**
 * 选出用于补偿滚动位置的锚点行。
 *
 * @param rows 窗口内按 DOM 顺序排列的所有行（几何取视口坐标）。
 * @param viewportTop 滚动容器的视口顶边坐标。
 * @returns 锚点行在 `rows` 中的下标；`rows` 为空时返回 -1。
 */
export function pickTimelineAnchorIndex(rows: readonly TimelineAnchorRow[], viewportTop: number): number {
  if (rows.length === 0) return -1;
  let visibleIndex = rows.length - 1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].rectBottom > viewportTop) {
      visibleIndex = i;
      break;
    }
  }
  // 视口首行是窗口首行时退一行：那一行的 id 会随分组补全而变化。
  return visibleIndex === 0 && rows.length > 1 ? 1 : visibleIndex;
}
