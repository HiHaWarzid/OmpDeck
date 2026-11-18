import { describe, expect, test } from "vitest";
import {
	clampMenuAnchor,
	EDITORS_POPOVER_SIZE,
	placeEditorsPopover,
	toggleEditors,
	type MenuAnchor,
	type OverlayState,
	type TriggerRect,
} from "./anchoredOverlay";

/**
 * 两个纯函数各自守住一类「小屏幕才暴露」的边界：
 *
 * - `clampMenuAnchor` 取代了原先直接读 `window.innerWidth/Height` 的 `adjustMenuPos`。
 *   读全局窗口对象让边界只能靠手动拖窗口验证，这里显式传视口，右侧/底部溢出、
 *   以及「窗口比菜单还小」这两种情形可以穷举。
 * - `toggleEditors` 是六个锚定浮层里唯一的 toggle。其余浮层「打开即替换」由联合类型
 *   保证（同一时刻只能有一个值），只有它的开/关转换需要单独证明。
 */

const VIEWPORT = { width: 1200, height: 800 };

/** 打开某个浮层的构造：测试只关心 kind，payload 用最小可用形状。 */
const overlayOf = (kind: Exclude<OverlayState, null>["kind"]): OverlayState =>
	kind === "editors"
		? { kind, x: 1, y: 2, targetPath: "/repo" }
		: kind === "session" || kind === "sessionFilter"
			? { kind, x: 1, y: 2, projectId: "p" } as OverlayState
			: ({ kind, x: 1, y: 2 } as OverlayState);

describe("clampMenuAnchor", () => {
	test("放得下时坐标原样返回", () => {
		expect(clampMenuAnchor({ x: 100, y: 50 }, { width: 200, height: 260 }, VIEWPORT)).toEqual({
			x: 100,
			y: 50,
		});
	});

	test("恰好贴边不算溢出（比较是严格大于）", () => {
		expect(
			clampMenuAnchor({ x: 1000, y: 540 }, { width: 200, height: 260 }, VIEWPORT),
		).toEqual({ x: 1000, y: 540 });
	});

	test("右侧溢出时夹到视口内并留 8px 间距", () => {
		expect(clampMenuAnchor({ x: 1100, y: 10 }, { width: 200, height: 100 }, VIEWPORT).x).toBe(
			1200 - 200 - 8,
		);
	});

	test("底部溢出时夹到视口内并留 8px 间距", () => {
		expect(clampMenuAnchor({ x: 10, y: 700 }, { width: 100, height: 260 }, VIEWPORT).y).toBe(
			800 - 260 - 8,
		);
	});

	test("视口比菜单还小时不产生负坐标", () => {
		const tiny = { width: 150, height: 120 };
		expect(clampMenuAnchor({ x: 140, y: 110 }, { width: 200, height: 260 }, tiny)).toEqual({
			x: 4,
			y: 4,
		});
	});
});

describe("placeEditorsPopover", () => {
	const railButton: TriggerRect = { x: 1160, y: 180, width: 34, height: 34 };

	test("落在触发器左侧且不压住它（右侧工具栏的常规情形）", () => {
		const anchor = placeEditorsPopover(railButton, EDITORS_POPOVER_SIZE, VIEWPORT);
		expect(anchor).toEqual({ x: 1160 - 220 - 8, y: 180 });
		expect(overlaps(anchor, railButton)).toBe(false);
	});

	test("左侧放不下时改到下方，仍然不压住触发器", () => {
		const nearLeft: TriggerRect = { x: 90, y: 180, width: 34, height: 34 };
		const anchor = placeEditorsPopover(nearLeft, EDITORS_POPOVER_SIZE, VIEWPORT);
		expect(anchor).toEqual({ x: 90, y: 180 + 34 + 8 });
		expect(overlaps(anchor, nearLeft)).toBe(false);
	});

	test("下方也溢出时改到上方", () => {
		const low: TriggerRect = { x: 90, y: 600, width: 34, height: 34 };
		const anchor = placeEditorsPopover(low, EDITORS_POPOVER_SIZE, VIEWPORT);
		expect(anchor.y).toBeLessThan(low.y + low.height);
		expect(overlaps(anchor, low)).toBe(false);
	});

	test("常规视口下任意触发点都不压在触发器上", () => {
		for (const viewport of [
			{ width: 1200, height: 800 },
			{ width: 1024, height: 700 },
		]) {
			for (let x = 0; x <= viewport.width; x += 40) {
				for (let y = 0; y <= viewport.height; y += 40) {
					const trigger: TriggerRect = { x, y, width: 34, height: 34 };
					const anchor = placeEditorsPopover(trigger, EDITORS_POPOVER_SIZE, viewport);
					expect(overlaps(anchor, trigger)).toBe(false);
				}
			}
		}
	});

	test("窗口小到放不下时宁可压住触发器，也不把气泡推出视口", () => {
		// 220x280 的气泡塞进 260x300 的窗口：只剩窄条，怎么摆都会压住一个居中的触发器。
		// 这时裁剪（气泡被视口切掉、选项点不到）比遮挡更糟，所以退回「贴边放好」。
		const viewport = { width: 260, height: 300 };
		const trigger: TriggerRect = { x: 110, y: 140, width: 34, height: 34 };
		const anchor = placeEditorsPopover(trigger, EDITORS_POPOVER_SIZE, viewport);
		expect(anchor.x).toBeGreaterThanOrEqual(4);
		expect(anchor.y).toBeGreaterThanOrEqual(4);
		expect(anchor.x + EDITORS_POPOVER_SIZE.width).toBeLessThanOrEqual(viewport.width);
		expect(anchor.y + EDITORS_POPOVER_SIZE.height).toBeLessThanOrEqual(viewport.height);
	});
});

/** 气泡矩形与触发器矩形是否相交：相交就意味着按钮点不到。 */
function overlaps(anchor: MenuAnchor, trigger: TriggerRect): boolean {
	return (
		anchor.x < trigger.x + trigger.width &&
		anchor.x + EDITORS_POPOVER_SIZE.width > trigger.x &&
		anchor.y < trigger.y + trigger.height &&
		anchor.y + EDITORS_POPOVER_SIZE.height > trigger.y
	);
}

describe("toggleEditors", () => {
	test("收起状态下没有锚点就不打开（避免用陈旧坐标开气泡）", () => {
		expect(toggleEditors(null, null, "/repo")).toBeNull();
	});

	test("收起状态下有锚点则打开并记录本次目标目录", () => {
		expect(toggleEditors(null, { x: 20, y: 30 }, "/repo")).toEqual({
			kind: "editors",
			x: 20,
			y: 30,
			targetPath: "/repo",
		});
	});

	test("已打开时再次触发即收起", () => {
		expect(toggleEditors(overlayOf("editors"), { x: 20, y: 30 }, "/repo")).toBeNull();
	});

	test("别的浮层开着时编辑器气泡替换它（工具栏按钮不清场，打开即替换）", () => {
		expect(toggleEditors(overlayOf("project"), { x: 5, y: 6 }, "/repo")).toEqual({
			kind: "editors",
			x: 5,
			y: 6,
			targetPath: "/repo",
		});
	});

	test("目标目录可以为 null：没有活跃 agent 时也允许打开让用户自己看列表", () => {
		expect(toggleEditors(null, { x: 5, y: 6 }, null)).toMatchObject({ targetPath: null });
	});
});
