/**
 * 主进程系统通知与「点击通知回到应用」的统一入口。
 *
 * 背景：会话结束通知与 ask 等待通知此前各自 new Notification，既没有图标，
 * 也没有 click 处理（Windows 上点通知毫无反应）。这里集中传应用图标，并统一把窗口
 * 还原、置前、切到对应 Agent。注意：`icon` 只影响 Toast 正文图像；
 * Windows 左上角的应用图标由 AUMID 对应的开始菜单快捷方式决定。
 */
import { app, Notification, type BrowserWindow, type NativeImage } from "electron";
import { ipcChannels } from "../shared/ipc";

export type AppNotificationInput = {
	/** 省略时使用 Electron 应用名，通知中心会把它显示为应用标识。 */
	title?: string;
	body: string;
	/** Toast 正文图像；Windows 左上角应用图标来自 AUMID 快捷方式。 */
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

/** 发送带应用图标与点击聚焦的系统通知；任何通知失败都不应影响主流程。 */
export function showAppNotification(input: AppNotificationInput): void {
	try {
		if (typeof Notification.isSupported !== "function" || !Notification.isSupported()) return;
		const notification = new Notification({
			title: input.title ?? app.getName(),
			body: input.body,
			icon: input.icon,
			silent: false,
		});
		const agentId = input.agentId;
		notification.on("click", () => {
			focusMainWindow(input.getWindow(), agentId);
		});
		notification.show();
	} catch {
		// 无效图标、桌面环境无通知服务等都不影响会话本身。
	}
}
