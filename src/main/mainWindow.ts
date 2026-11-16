/**
 * 主窗口生命周期的**状态与策略唯一实现**（`mainWindow.ts`）。
 *
 * 为什么成模块：这些判定以前是 `index.ts` 模块级作用域里的五个自由函数 + 四个可空 let
 * （`mainFrameLoadFailed` / `pendingErrorPageFinish` / `mainWindowDevFallbackTried` /
 * `isQuitting` / `rendererRecoveryAttempts`），只在「按特定顺序调用」时才成立，
 * 于是 dev 回退、错误页重试、关闭 vs 隐藏托盘都没有测试面——而这几条正是最近三个月
 * 反复出问题的地方（窗口停在错误页、托盘退出被吞成隐藏、重建后旧状态残留）。
 *
 * 与 `rendererRecovery` 的分工：那里只回答「这块界面还值不值得自动 reload」（次数预算），
 * 这里回答「这一次生命周期事件该做什么」（加载健康、新建 vs 聚焦、关窗语义、无响应处置），
 * 并把次数预算的账本一并持有。二者都**不碰 Electron 副作用**：reload / loadFile / destroy /
 * hide / quit 由 index.ts 执行，因此判定可以直接对假窗口单测。
 *
 * 窗口句柄本身仍属于 index.ts（十几处 IPC handler 通过 `getMainWindow` 取它）；
 * 本模块只经注入的访问器读取，不另存一份引用，避免两处真相。
 */

/** 判定只需要的窗口能力（真实窗口与测试替身都满足）。 */
export type MainWindowHandle = {
	isDestroyed(): boolean;
	webContents: { isCrashed(): boolean };
};

type LoadHealth = {
	loadFailed: boolean;
	pendingErrorPageFinish: boolean;
	devFallbackTried: boolean;
};

export type WindowClosePlan = "hide" | "quit" | "ignore";
export type VersionFocusPlan = "focus" | "recreate" | "open";

export class MainWindowLifecycle {
	/**
	 * 每次判定都现取窗口，而不是构造时快照：窗口会被销毁重建，
	 * 快照会指向已销毁的旧实例，于是重建后被判成「没有窗口」。
	 */
	private readonly getWindow: () => MainWindowHandle | null;
	private health: LoadHealth = { loadFailed: false, pendingErrorPageFinish: false, devFallbackTried: false };
	private quitting = false;
	/** 最近窗口内的自动恢复时间戳：只在主进程内存里，重启应用即清零。 */
	private recoveryAttempts: number[] = [];

	constructor(getWindow: () => MainWindowHandle | null) {
		this.getWindow = getWindow;
	}

	/**
	 * 新建/重建窗口后重置加载健康状态：新窗口必须重新尝试 dev URL
	 * （若仍失联则再回退一次构建产物）。
	 */
	resetLoadHealth(): void {
		this.health = { loadFailed: false, pendingErrorPageFinish: false, devFallbackTried: false };
	}

	/** 用户主动退出（托盘「退出」/ before-quit）：此后关窗不再走「隐藏到托盘」。 */
	isQuitting(): boolean {
		return this.quitting;
	}

	setQuitting(value: boolean): void {
		this.quitting = value;
	}

	/**
	 * 主 frame 导航失败。非主 frame 的失败由调用方过滤，不影响窗口健康。
	 * 返回是否应回退构建产物——回退只做一次，否则无产物时反复重试。
	 */
	onMainFrameLoadFailed(usingDevRendererUrl: boolean): { fallbackToBuiltRenderer: boolean } {
		const fallbackToBuiltRenderer = usingDevRendererUrl && !this.health.devFallbackTried;
		this.health = {
			loadFailed: true,
			// 紧随失败的 finish 事件是 Chromium 错误页本身，必须忽略一次。
			pendingErrorPageFinish: true,
			devFallbackTried: this.health.devFallbackTried || fallbackToBuiltRenderer,
		};
		return { fallbackToBuiltRenderer };
	}

	/** 主 frame 加载完成：错误页那次 finish 只消费标记，真实页面才清除失败态。 */
	onMainFrameLoadFinished(): void {
		if (this.health.pendingErrorPageFinish) {
			this.health = { ...this.health, pendingErrorPageFinish: false };
			return;
		}
		this.health = { ...this.health, loadFailed: false };
	}

	/** 窗口是否已彻底不可用（不存在 / 已销毁）。 */
	isAbsent(): boolean {
		const handle = this.getWindow();
		return !handle || handle.isDestroyed();
	}

	/** 窗口是否需要重建而非仅聚焦：已销毁 / 渲染进程崩溃 / 停留在错误页。 */
	needsRecovery(): boolean {
		const handle = this.getWindow();
		if (!handle) return true;
		if (handle.isDestroyed()) return true;
		if (handle.webContents.isCrashed()) return true;
		return this.health.loadFailed;
	}

	/**
	 * 同版本次实例请求聚焦：健康则前置，渲染已坏则重建，尚未创建则走完整加载。
	 * 重建而非聚焦是必须的——否则用户每次二次启动都看到同一张空白页。
	 */
	planVersionFocus(): VersionFocusPlan {
		if (this.isAbsent()) return "open";
		return this.needsRecovery() ? "recreate" : "focus";
	}

	/**
	 * 关窗动作。两条条件独立：`quitting` 一旦为真，后续关窗不再走托盘分支，
	 * 否则托盘「退出」会被 `closeToTray` 吞成隐藏，应用永远退不掉。
	 */
	planClose(closeToTray: boolean): WindowClosePlan {
		if (this.quitting) return "ignore";
		return closeToTray ? "hide" : "quit";
	}

	/**
	 * 渲染进程 gone 后是否还值得自愈：正常退出、窗口已销毁都无处可恢复。
	 * 句柄由调用方传入而不是取「当前主窗口」：事件绑定在具体窗口上，
	 * 重建新窗口后旧窗口的迟到事件不得按新窗口的状态判定。
	 */
	shouldRecoverRenderer(handle: MainWindowHandle, reasonIsCleanExit: boolean): boolean {
		if (reasonIsCleanExit) return false;
		return !handle.isDestroyed();
	}

	/**
	 * 无响应按「软崩溃」处理：只有窗口仍在、渲染进程尚未崩溃时才强杀，
	 * 否则会与崩溃自愈路径重复处理同一窗口（同样必须是事件所属的那个窗口）。
	 */
	planUnresponsiveRecovery(handle: MainWindowHandle): "force-crash" | "ignore" {
		if (handle.isDestroyed() || handle.webContents.isCrashed()) return "ignore";
		return "force-crash";
	}

	/**
	 * 崩溃自愈的次数账本：把判定与账本一起持有，调用方只按 `action` 执行副作用。
	 * 计数写回后 `prompt` 分支不追加时间戳（否则用户点「再试一次」后很快又超限）。
	 */
	decideRecovery(
		now: number,
		decide: (attempts: number[], now: number) => { attempts: number[]; action: "reload" | "prompt" },
	): { attempts: number[]; action: "reload" | "prompt" } {
		const decision = decide(this.recoveryAttempts, now);
		this.recoveryAttempts = decision.attempts;
		return decision;
	}

	/** 用户显式要求再试：清空计数，让下一次崩溃重新走自动恢复而不是立刻弹窗。 */
	resetRecoveryAttempts(): void {
		this.recoveryAttempts = [];
	}
}
