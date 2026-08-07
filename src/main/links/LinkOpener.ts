/**
 * 外部链接处理器：统一处理外部 URL 的打开方式（系统默认浏览器 vs 内置浏览器面板）。
 *
 * 从 src/main/index.ts 提取。
 */
import { shell, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AppSettings } from "../../shared/types";

export interface LinkOpenerDeps {
	getMainWindow: () => BrowserWindow | null;
	getSettings: () => AppSettings;
}

export class LinkOpener {
	private readonly deps: LinkOpenerDeps;

	constructor(deps: LinkOpenerDeps) {
		this.deps = deps;
	}

	async openExternalUrl(url: string, forceSystem?: boolean) {
		// 允许 http/https 以及 file:// 协议（用于本地 HTML 预览等场景）
		if (!url.startsWith("http:") && !url.startsWith("https:") && !url.startsWith("file:")) return;
		// forceSystem 为 true 时绕过 linkOpenMode 设置，始终用系统默认浏览器
		if (forceSystem) {
			await shell.openExternal(url);
			return;
		}
		const settings = this.deps.getSettings();
		if (settings.linkOpenMode === "internal") {
			this.openInternalLinkInBrowserPanel(url);
			return;
		}
		await shell.openExternal(url);
	}

	private openInternalLinkInBrowserPanel(url: string) {
		// 内部打开：将 URL 发送到渲染进程，由 BrowserPanel 在侧栏/弹框中加载，
		// 替代之前的独立 BrowserWindow 方案，保持一致的浏览体验。
		const win = this.deps.getMainWindow();
		if (!win || win.isDestroyed()) {
			void shell.openExternal(url);
			return;
		}
		win.webContents.send(ipcChannels.appOpenInBrowser, url);
	}
}
