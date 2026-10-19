/**
 * 渲染进程崩溃 / 持续无响应后的自愈决策（纯函数，副作用留在 main/index.ts）。
 *
 * 为什么自动 reload：pi 子进程与会话都在主进程侧，渲染进程死掉只意味着界面没了；
 * reload 用同一份运行态重建界面（Agent 继续在后台跑），比让用户对着空白窗口强。
 * 持续无响应（主线程被长任务占死）走的是同一条路：先强杀再 reload。
 *
 * 为什么必须限次：崩溃根因常在渲染层（超大 transcript 灌入导致 OOM），reload 会立刻
 * 复现同一场景；不限次就是「崩 → 重载 → 崩」的死循环，用户连日志都来不及看。
 * 超限后不再自动重载，改用原生弹窗把决定权交给用户。
 */

/** 统计自动恢复次数的滑动窗口：窗口外的旧尝试不再计数。 */
export const RENDERER_RECOVERY_WINDOW_MS = 10 * 60 * 1000;

/** 窗口内允许的自动恢复次数上限，超过即交回用户。 */
export const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;

export type RendererRecoveryDecision = {
	/** 计入本次之后的有效尝试时间戳（只保留窗口内的），调用方原样存回。 */
	attempts: number[];
	/** reload：自动恢复；prompt：弹窗让用户决定。 */
	action: "reload" | "prompt";
};

/**
 * 判定本次崩溃是否还值得自动恢复。
 * prompt 分支不追加时间戳：否则窗口内的时间戳会越积越多，用户点「再试一次」后
 * 很快又落到超限分支。
 */
export function decideRendererRecovery(attempts: number[], now: number): RendererRecoveryDecision {
	const recent = attempts.filter((at) => now - at < RENDERER_RECOVERY_WINDOW_MS);
	if (recent.length >= RENDERER_RECOVERY_MAX_ATTEMPTS) return { attempts: recent, action: "prompt" };
	return { attempts: [...recent, now], action: "reload" };
}
