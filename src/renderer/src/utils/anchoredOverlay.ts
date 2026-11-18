import type { AgentTab, FileTreeNode, Project, SessionSummary } from "../../../shared/types";

/**
 * 锚定浮层（右键菜单 / 编辑器气泡 / 来源筛选）的当前值。
 *
 * 以前这里有六个独立的 `useState`：`fileMenu`、`projectMenu`、`agentMenu`、
 * `sessionMenu`、`sessionFilterOpen`、`editorsAnchor`（外加 `editorsOpen` 与
 * `editorsTargetPath` 两个配套标记）。「同时最多一个」是靠在每个打开点「记得」把
 * 别人的状态置 null、以及 backdrop 挡住下层点击来维持的 —— 没有任何地方强制它，
 * 六个 setter 还要逐个穿过 `SidebarTree` 的 props 下发。
 *
 * 收成一个带判别字段的单一值后，互斥是类型层面的事实：想同时开两个浮层，必须
 * 先伪造一个不存在的联合成员。`kind` 也是渲染分支的唯一判据，读代码不必再回头
 * 确认「这个菜单现在靠哪个布尔值控制显示」。
 */
export type AnchoredOverlay =
	| { kind: "file"; x: number; y: number; node: FileTreeNode }
	| { kind: "project"; x: number; y: number; project: Project }
	| { kind: "agent"; x: number; y: number; agent: AgentTab }
	| { kind: "session"; x: number; y: number; projectId: string; session: SessionSummary }
	| { kind: "sessionFilter"; x: number; y: number; projectId: string }
	/**
	 * 外部编辑器气泡。它是唯一一个「再点一次按钮就收起」的浮层，所以没有独立的
	 * open 标记：`kind === "editors"` 本身就是打开态。`targetPath` 记录本次要打开
	 * 的目录（右键项目也能唤起它，不能依赖运行中 agent 的 cwd）。
	 */
	| { kind: "editors"; x: number; y: number; targetPath: string | null };

export type OverlayState = AnchoredOverlay | null;

export type MenuAnchor = { x: number; y: number };
export type MenuSize = { width: number; height: number };
export type Viewport = { width: number; height: number };

/** 菜单与视口边缘的最小留白（与 `adjustMenuPos` 的既有取值保持一致）。 */
const VIEWPORT_MARGIN = 8;
const MIN_COORDINATE = 4;

/**
 * 把菜单左上角夹进视口内。
 *
 * 这是打开前的粗估：`ContextMenuSurface` 渲染后还会按真实尺寸再夹一次，编辑器气泡
 * 不是 `ContextMenuSurface`，只有这一道。纯函数、显式传视口，所以边界可以在测试里
 * 穷举，不必等到小屏幕上才暴露。
 */
export function clampMenuAnchor(
	anchor: MenuAnchor,
	size: MenuSize,
	viewport: Viewport,
): MenuAnchor {
	return {
		x:
			anchor.x + size.width > viewport.width
				? Math.max(MIN_COORDINATE, viewport.width - size.width - VIEWPORT_MARGIN)
				: anchor.x,
		y:
			anchor.y + size.height > viewport.height
				? Math.max(MIN_COORDINATE, viewport.height - size.height - VIEWPORT_MARGIN)
				: anchor.y,
	};
}

/** 触发器的视口矩形（`getBoundingClientRect` 的可比较子集）。 */
export type TriggerRect = { x: number; y: number; width: number; height: number };

/**
 * 编辑器气泡的估算尺寸：全局 `* { box-sizing: border-box }`，所以 CSS 里的
 * `max-height: 240px` 已含内边距，高度就取 240（不是「内容上限 + 内边距」）。
 * 宽度没有写在 CSS 里：`App` 渲染气泡时用这里的 `width` 作 `maxWidth`，
 * 于是「落点假设多宽」与「气泡实际多宽」只有一个来源。
 */
export const EDITORS_POPOVER_SIZE: MenuSize = { width: 220, height: 240 };

function intersects(anchor: MenuAnchor, size: MenuSize, trigger: TriggerRect): boolean {
	return (
		anchor.x < trigger.x + trigger.width &&
		anchor.x + size.width > trigger.x &&
		anchor.y < trigger.y + trigger.height &&
		anchor.y + size.height > trigger.y
	);
}

/**
 * 编辑器气泡的落点：**不得覆盖自己的触发器**。
 *
 * 这条约束不是审美问题，是 toggle 能成立的前提。气泡以 `position: fixed` 画在触发器
 * 之上时，真实指针点到的永远是气泡而不是按钮：pointerdown 落在气泡内不会关闭它，随后
 * 的 click 也派发给气泡，按钮的 `onClick` 根本不执行 —— 「再点一次收起」在真机上永远
 * 失效（脚本 `.click()` 绕过命中测试，所以只在人工/自动化指针下才暴露）。
 *
 * 依次尝试左侧、下方、上方、右侧四个落点，取第一个夹进视口后仍不压住触发器的位置；
 * 四个都不行（窗口比气泡还窄）时退回左侧夹好的坐标，宁可压住也不能跑到视口外。
 */
export function placeEditorsPopover(
	trigger: TriggerRect,
	size: MenuSize,
	viewport: Viewport,
): MenuAnchor {
	const candidates: MenuAnchor[] = [
		{ x: trigger.x - size.width - VIEWPORT_MARGIN, y: trigger.y },
		{ x: trigger.x, y: trigger.y + trigger.height + VIEWPORT_MARGIN },
		{ x: trigger.x, y: trigger.y - size.height - VIEWPORT_MARGIN },
		{ x: trigger.x + trigger.width + VIEWPORT_MARGIN, y: trigger.y },
	];
	const clamped = candidates.map((candidate) => {
		const anchor = clampMenuAnchor(candidate, size, viewport);
		// `clampMenuAnchor` 只管右侧/底部溢出；这里补上负方向，否则放到触发器左侧
		// 会把气泡推出视口而它仍被判为「不压住触发器」。
		return {
			x: Math.max(MIN_COORDINATE, anchor.x),
			y: Math.max(MIN_COORDINATE, anchor.y),
		};
	});
	return clamped.find((anchor) => !intersects(anchor, size, trigger)) ?? clamped[0];
}

/**
 * 编辑器气泡的开关。其余浮层都是「打开即替换」，只有它是 toggle：
 * 再次点击同一个按钮应当收起，而不是重新定位到同一处。
 *
 * `anchor` 为 null 表示调用方没拿到按钮矩形（事件被合成、DOM 已卸载等）。这种情况下
 * 不打开：用一个陈旧坐标开气泡比什么都不做更容易让人困惑。已经打开时仍然允许收起。
 */
export function toggleEditors(
	current: OverlayState,
	anchor: MenuAnchor | null,
	targetPath: string | null,
): OverlayState {
	if (current?.kind === "editors") return null;
	if (!anchor) return current;
	return { kind: "editors", x: anchor.x, y: anchor.y, targetPath };
}
