/**
 * 托盘管理器：负责创建和维护系统托盘图标及右键菜单。
 *
 * 从 src/main/index.ts 提取。
 */
import { Menu, Tray, nativeImage, type BrowserWindow } from "electron";
import iconPath from "../../../build/icons/32x32.png?asset";

export interface TrayManagerDeps {
	getMainWindow: () => BrowserWindow | null;
	setIsQuitting: (value: boolean) => void;
	/** 用户从托盘菜单点击「退出」时触发；由 index.ts 注入 app.quit() 以避免在此处直接依赖 app 引用。 */
	onQuit: () => void;
	/** 用户从托盘菜单点击「重启」时触发；index.ts 注入统一清理 + relaunch 流程。 */
	onRestart: () => void;
}

export class TrayManager {
	private tray: Tray | null = null;
	private readonly deps: TrayManagerDeps;

	constructor(deps: TrayManagerDeps) {
		this.deps = deps;
	}

	/** 从托盘/任务栏/二次启动唤起主窗口：处理最小化、隐藏到托盘两种状态。 */
	focusMainWindow() {
		const win = this.deps.getMainWindow();
		if (!win || win.isDestroyed()) return;
		if (win.isMinimized()) win.restore();
		// 托盘隐藏时需重新显示任务栏按钮，否则只 focus 可能仍不可见。
		if (typeof win.setSkipTaskbar === "function") {
			win.setSkipTaskbar(false);
		}
		win.show();
		win.focus();
		// Windows：短暂置顶再取消，避免已有窗口在后台时 second-instance 只亮任务栏不前置。
		if (process.platform === "win32") {
			win.setAlwaysOnTop(true);
			win.setAlwaysOnTop(false);
		}
	}

	setupTray() {
		// 托盘图标：直接使用预渲染 32x32 PNG，高 DPI 下清晰；不额外 resize 以免模糊
		this.tray = new Tray(nativeImage.createFromPath(iconPath));
		this.tray.setToolTip("OmpDeck");

		// 双击托盘图标恢复窗口（Windows 常见交互）
		this.tray.on("double-click", () => {
			this.focusMainWindow();
		});

		const contextMenu = Menu.buildFromTemplate([
			{
				label: "显示窗口",
				click: () => {
					this.focusMainWindow();
				},
			},
			{ type: "separator" },
			{
				label: "重启 OmpDeck",
				click: () => {
					this.deps.onRestart();
				},
			},
			{ type: "separator" },
			{
				label: "退出 OmpDeck",
				click: () => {
					// 标记主动退出（区别于窗口关闭隐藏到托盘），再通知主进程执行 app.quit()。
					// 此前用 process.emit 通知但无监听者，会导致点击退出不生效。
					this.deps.setIsQuitting(true);
					this.deps.onQuit();
				},
			},
		]);
		this.tray.setContextMenu(contextMenu);
	}

	/** 销毁托盘图标；在 app before-quit 时调用，复刻原 index.ts 的 tray.destroy() 清理。 */
	destroy() {
		this.tray?.destroy();
		this.tray = null;
	}
}
