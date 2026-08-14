import { clipboard, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";

/**
 * 解析 Windows CF_HDROP 剪贴板缓冲，得到资源管理器复制的多文件路径。
 * DROPFILES 头 20 字节后是以双空结尾的路径列表（宽字符或 ANSI）。
 * 从 preload 迁入：renderer 进程 clipboard API 已弃用，剪贴板访问只能在主进程。
 */
function parseCfHdrop(buffer: Buffer): string[] {
	if (buffer.length < 20) return [];
	const pFiles = buffer.readUInt32LE(0);
	const fWide = buffer.readUInt32LE(16) !== 0;
	if (pFiles <= 0 || pFiles >= buffer.length) return [];

	const paths: string[] = [];
	let offset = pFiles;
	if (fWide) {
		// UTF-16LE：条目以 \0\0 分隔，列表以 \0\0\0\0 结束
		while (offset + 2 <= buffer.length) {
			let end = offset;
			while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) {
				end += 2;
			}
			if (end === offset) break;
			paths.push(buffer.toString("utf16le", offset, end));
			offset = end + 2;
		}
	} else {
		while (offset < buffer.length) {
			let end = offset;
			while (end < buffer.length && buffer[end] !== 0) end++;
			if (end === offset) break;
			paths.push(buffer.toString("utf8", offset, end));
			offset = end + 1;
		}
	}
	return paths.map((p) => p.trim()).filter(Boolean);
}

/** 将 file:// URI 转为本地路径（兼容 Windows 盘符与 URL 编码）。 */
function fileUrlToPath(uri: string): string {
	const trimmed = uri.trim();
	if (!trimmed) return "";
	let path = trimmed.replace(/^file:\/\//i, "");
	// Windows: /C:/Users/... → C:/Users/...
	if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
	try {
		path = decodeURIComponent(path);
	} catch {
		// 保留原始字符串
	}
	return path;
}

/**
 * 从系统剪贴板读取「资源管理器复制文件」的本地路径列表。
 * 浏览器 ClipboardEvent 在复制文件时通常拿不到 kind=file，必须走 Electron clipboard。
 * 主进程实现；renderer 经 sendSync 同步获取，便于粘贴事件里立刻 preventDefault。
 */
function readClipboardFilePaths(): string[] {
	try {
		if (process.platform === "win32") {
			// 优先 CF_HDROP：支持多选复制
			try {
				const drop = clipboard.readBuffer("CF_HDROP");
				if (drop && drop.length > 0) {
					const paths = parseCfHdrop(drop);
					if (paths.length > 0) return paths;
				}
			} catch {
				// 部分环境无 CF_HDROP，回退 FileNameW
			}
			if (clipboard.has("FileNameW")) {
				const raw = clipboard.readBuffer("FileNameW").toString("ucs2");
				const path = raw.replace(/\0/g, "").trim();
				if (path) return [path];
			}
			return [];
		}

		if (process.platform === "darwin") {
			const url = clipboard.read("public.file-url");
			if (url) {
				const path = fileUrlToPath(url);
				return path ? [path] : [];
			}
			return [];
		}

		// Linux：text/uri-list 或 GNOME 专用格式
		if (clipboard.has("text/uri-list")) {
			const text = clipboard.read("text/uri-list");
			return text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.startsWith("file://") && !line.startsWith("#"))
				.map(fileUrlToPath)
				.filter(Boolean);
		}
		if (clipboard.has("x-special/gnome-copied-files")) {
			const text = clipboard.read("x-special/gnome-copied-files");
			return text
				.split(/\r?\n/)
				.slice(1) // 首行是 copy/cut
				.map((line) => line.trim())
				.filter((line) => line.startsWith("file://"))
				.map(fileUrlToPath)
				.filter(Boolean);
		}
	} catch {
		// 剪贴板格式不可用时静默失败，回退为普通文本粘贴
	}
	return [];
}

/**
 * 剪贴板 IPC 注册。
 * read 走 ipcMain.on + returnValue（同步）；write 走 ipcMain.handle（异步）。
 */
export function registerClipboardHandlers(): void {
	ipcMain.on(ipcChannels.clipboardReadFilePaths, (event) => {
		event.returnValue = readClipboardFilePaths();
	});

	ipcMain.handle(ipcChannels.clipboardWriteText, (_event, text: string) => {
		clipboard.writeText(String(text));
	});
}
