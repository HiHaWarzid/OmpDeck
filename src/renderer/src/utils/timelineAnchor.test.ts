import { describe, expect, it } from "vitest";
import { pickTimelineAnchorIndex, type TimelineAnchorRow } from "./timelineAnchor";

/**
 * 锚点选择规则单测。
 *
 * 这条规则决定翻页/滑窗后 scrollTop 补偿能否生效：选到窗口首行会因为分组 id 变化找不到元素，
 * 选到屏幕外的行会因为 scrollTop 被浏览器夹掉而补偿失效——两者都表现为"视图跳走"。
 */
const row = (id: string, rectTop: number, rectBottom: number): TimelineAnchorRow => ({ id, rectTop, rectBottom });

/** 视口顶边取 100：矩形坐标越小越靠上。 */
const viewportTop = 100;

describe("pickTimelineAnchorIndex", () => {
  it("取视口内第一行，而不是更早的屏幕外行", () => {
    const rows = [row("a", -2000, -1900), row("b", -500, -400), row("c", 150, 250), row("d", 300, 400)];
    expect(pickTimelineAnchorIndex(rows, viewportTop)).toBe(2);
  });

  it("视口首行就是窗口首行时退到次行（首行 id 会随分组补全而变化）", () => {
    const rows = [row("t550|t551", -30, 80), row("t552", 120, 200), row("t553", 220, 300)];
    expect(pickTimelineAnchorIndex(rows, viewportTop)).toBe(1);
  });

  it("所有行都在视口上方（视图停在最新消息处）时退回最后一行，不越界", () => {
    const rows = [row("a", -900, -800), row("b", -700, -600), row("c", -500, -400)];
    expect(pickTimelineAnchorIndex(rows, viewportTop)).toBe(2);
  });

  it("只有一行时即使它是窗口首行也只能锚它", () => {
    expect(pickTimelineAnchorIndex([row("only", 150, 250)], viewportTop)).toBe(0);
  });

  it("空窗口返回 -1，交由调用方放弃补偿", () => {
    expect(pickTimelineAnchorIndex([], viewportTop)).toBe(-1);
  });
});
