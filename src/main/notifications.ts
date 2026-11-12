/**
 * 主进程系统通知与「点击通知回到应用」的统一入口。
 *
 * 背景：会话结束通知与 ask 等待通知此前各自 new Notification，既没有图标，
 * 也没有 click 处理（Windows 上点通知毫无反应）。这里集中处理点击后的窗口
 * 还原、置前和 Agent 切换。注意：`icon` 只影响非 Windows 平台的 Toast 正文
 * 图像；Windows 左上角应用图标由品牌化 exe/AUMID 快捷方式决定。
 */
import { app, Notification, type BrowserWindow, type NativeImage } from "electron";
import { ipcChannels } from "../shared/ipc";

export type AppNotificationInput = {
	/** 省略时使用 OmpDeck，通知中心会把它显示为应用标识。 */
	title?: string;
	body: string;
	/** 非 Windows 平台的 Toast 正文图像；Windows 左上角应用图标来自品牌化 exe/AUMID 快捷方式。 */
	icon?: NativeImage;
	/** 点击通知后要聚焦的 Agent；渲染层收到后会切换项目与会话。 */
	agentId?: string;
	getWindow: () => BrowserWindow | null;
};

/** 把主窗口从托盘/最小化恢复并置前，可选切换到指定 Agent。 */
export function focusMainWindow(win: BrowserWindow | null, agentId?: string): void {
	if (!win || win.isDestroyed()) return;
	if (win.isMinimized()) win.restore();
	if (!win.isVisible()) win.show();
	win.focus();
	// Windows 前台锁：仅 show()+focus() 有时只闪任务栏，steal 让窗口真正置前。
	try {
		app.focus({ steal: true });
	} catch {
		// 非 macOS/Windows 或平台不支持时忽略；show/focus 已生效。
	}
	if (agentId) {
		win.webContents.send(ipcChannels.petFocusAgentTarget, { agentId });
	}
}

/**
 * 发送带点击聚焦的系统通知；任何通知失败都不应影响主流程。
 *
 * Windows 上不传 `icon`：它会在 Toast 正文左侧渲染一张大图，而左上角应用图标
 * 只能由 AUMID + 品牌化 exe/快捷方式决定（见 windowsAppIdentity.ts）。
 * Linux 仍保留 icon，作为通知内容的一部分。
 */
const LIVE_NOTIFICATIONS = new Set<Notification>();

export function showAppNotification(input: AppNotificationInput): void {
	// 必须持有 Notification 引用直到 close/failed：Electron 对象被 GC 后
	// click 监听器也随之消失，Windows Toast 点击会变成无响应。
	try {
		if (typeof Notification.isSupported !== "function" || !Notification.isSupported()) return;
		const notification = new Notification({
			title: input.title ?? "OmpDeck",
			body: input.body,
			...(process.platform === "win32" ? {} : { icon: input.icon }),
			silent: false,
		});
		const agentId = input.agentId;
		let releaseTimer: NodeJS.Timeout | null = null;
		const release = () => {
			if (releaseTimer) clearTimeout(releaseTimer);
			LIVE_NOTIFICATIONS.delete(notification);
		};
		LIVE_NOTIFICATIONS.add(notification);
		notification.once("close", release);
		notification.once("failed", release);
		// 通知中心里的 Toast 可能长时间不触发 close；兜底释放引用，避免每轮会话
		// 都留一个 Notification 对象。十分钟足够覆盖用户看到后点击的窗口。
		releaseTimer = setTimeout(release, 10 * 60_000);
		releaseTimer.unref?.();
		notification.on("click", () => {
			focusMainWindow(input.getWindow(), agentId);
		});
		notification.show();
	} catch {
		// 无效图标、桌面环境无通知服务等都不影响会话本身。
	}
}
