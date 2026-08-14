import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 主窗口大小记忆（startupWindowMode="last" 的存储层）。
 * 关闭窗口/退出应用时保存 normal bounds（最大化/全屏时取 getNormalBounds），
 * 下次启动按记录尺寸打开；文件放在 userData/last-window-bounds.json，
 * 与用户设置（settings.json）分离——这是运行时状态而非用户显式配置。
 */

export type LastWindowBounds = {
	width: number;
	height: number;
};

/** 读取上次窗口大小；文件缺失/损坏/尺寸过小（小于最小窗口 880×640）时返回 null，由调用方顺延默认 */
export function readLastWindowBounds(dir: string): LastWindowBounds | null {
	try {
		const raw = readFileSync(join(dir, "last-window-bounds.json"), "utf8");
		const data = JSON.parse(raw) as { width?: unknown; height?: unknown };
		if (
			typeof data.width === "number" &&
			typeof data.height === "number" &&
			data.width >= 880 &&
			data.height >= 640
		) {
			return { width: Math.round(data.width), height: Math.round(data.height) };
		}
	} catch {
		// 文件不存在或 JSON 损坏：按无记录处理
	}
	return null;
}

/** 保存上次窗口大小（宽高取整，防抖由调用方控制） */
export function saveLastWindowBounds(dir: string, bounds: LastWindowBounds): void {
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "last-window-bounds.json"),
			JSON.stringify({ width: Math.round(bounds.width), height: Math.round(bounds.height) }),
			"utf8",
		);
	} catch {
		// 磁盘/权限失败静默：窗口记忆是可选的体验增强，不影响主流程
	}
}
