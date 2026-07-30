import { useCallback, useEffect, useRef, useState } from "react";
import {
	ArrowLeft,
	ArrowRight,
	Home,
	Maximize2,
	Minus,
	Plus,
	RefreshCw,
	Smartphone,
	Tablet,
	X,
} from "lucide-react";
import { t } from "../../i18n";

const DEFAULT_HOME = "https://github.com/HiHaWarzid/OmpDeck";

type DeviceType = "pc" | "mobile" | "tablet";

interface TabEntry {
	id: string;
	title: string;
	url: string;
}

interface DevicePreset {
	id: DeviceType;
	label: string;
	userAgent: string | null;
}

const DEVICE_PRESETS: DevicePreset[] = [
	{ id: "pc", label: "browser.devicePC", userAgent: null },
	{
		id: "mobile",
		label: "browser.deviceMobile",
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	},
	{
		id: "tablet",
		label: "browser.deviceTablet",
		userAgent:
			"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	},
];

let nextTabId = 1;
function genTabId(): string {
	return `tab-${nextTabId++}`;
}

/**
 * 浏览器状态要跨"抽屉模式/弹框模式"保留。
 * 这里用模块级状态保存轻量 tab 元数据，避免切换容器时丢 URL/标题/设备模式。
 * 真正的 WebContents 仍随组件挂载重建，避免同时运行两个 webview 实例。
 */
export const moduleState: { tabs: TabEntry[]; activeTabId: string | null; device: DeviceType; navigateKey: number } = {
	tabs: [],
	activeTabId: null,
	device: "pc",
	navigateKey: 0,
};

function ensureInitialTab() {
	if (moduleState.tabs.length > 0) return;
	const id = genTabId();
	moduleState.tabs = [{ id, title: "OmpDeck", url: DEFAULT_HOME }];
	moduleState.activeTabId = id;
}

function getInitialActiveTab(): TabEntry {
	ensureInitialTab();
	return (
		moduleState.tabs.find((tab) => tab.id === moduleState.activeTabId) ??
		moduleState.tabs[0]
	);
}

/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 如果没有标签页则创建一个，然后切换到该标签页并加载 URL。
 */
/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 如果没有标签页则创建一个，然后切换到该标签页并加载 URL。
 * 通过递增 navigateKey 触发 BrowserPanel 的 useEffect 执行导航。
 */
/** 待消费的外部导航 URL，BrowserPanel 通过轮询检测。 */
let pendingNavigateUrl: string | null = null;

export function navigateTo(url: string) {
	// 每次外部导航创建新 tab，避免多个链接复用同一个 tab
	const id = genTabId();
	// 初始 title 留空，tab 渲染 fallback 到 url，等 page-title-updated 更新真实标题
	moduleState.tabs.push({ id, title: "", url });
	moduleState.activeTabId = id;
	moduleState.navigateKey += 1;
	// 直接设 pendingUrl，轮询会立即检测到，无需等 re-render
	pendingNavigateUrl = url;
}

type WebviewEvent<T extends string> = T extends "did-navigate"
	? { url: string }
	: T extends "did-navigate-in-page"
		? { url: string; isMainFrame: boolean }
		: T extends "page-title-updated"
			? { title: string }
			: T extends "new-window"
				? { url: string; preventDefault: () => void }
				: T extends "load-progress"
					? { progress: number }
					: Event;

export function BrowserPanel(props: {
	isFullscreen?: boolean;
	onClose?: () => void;
	onToggleFullscreen?: () => void;
	/** 最小化：关闭全屏弹框，回到抽屉模式。 */
	onMinimize?: () => void;
	/** 嵌入右侧统一 Tab 栏时隐藏关闭按钮，避免与 drawer-chrome 重复 */
	hideChromeClose?: boolean;
}) {
	const { onClose, onMinimize, onToggleFullscreen } = props;
	const [initialTab] = useState(() => getInitialActiveTab());
	const webviewRef = useRef<any>(null);
	const defaultUARef = useRef<string | null>(null);
	const [tabs, setTabs] = useState<TabEntry[]>(() => [...moduleState.tabs]);
	const [activeTabId, setActiveTabId] = useState<string | null>(
		() => moduleState.activeTabId,
	);
	const [url, setUrl] = useState(initialTab.url);
	const [inputValue, setInputValue] = useState(initialTab.url);
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [loadProgress, setLoadProgress] = useState(0);
	const [device, setDevice] = useState<DeviceType>(() => moduleState.device);
	const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
	const deviceMenuRef = useRef<HTMLDivElement | null>(null);

	const persistTabs = useCallback((nextTabs: TabEntry[], nextActiveId: string | null) => {
		moduleState.tabs = nextTabs;
		moduleState.activeTabId = nextActiveId;
		setTabs([...nextTabs]);
		setActiveTabId(nextActiveId);
	}, []);

	const applyDeviceUserAgent = useCallback((wv: any, nextDevice: DeviceType) => {
		const preset = DEVICE_PRESETS.find((item) => item.id === nextDevice);
		if (preset?.userAgent) {
			wv.setUserAgent(preset.userAgent);
		} else if (defaultUARef.current) {
			wv.setUserAgent(defaultUARef.current);
		}
	}, []);

	const updateActiveTab = useCallback(
		(patch: Partial<TabEntry>) => {
			if (!moduleState.activeTabId) return;
			const nextTabs = moduleState.tabs.map((tab) =>
				tab.id === moduleState.activeTabId ? { ...tab, ...patch } : tab,
			);
			moduleState.tabs = nextTabs;
			setTabs([...nextTabs]);
		},
		[],
	);

	const loadUrl = useCallback(
		(targetUrl: string, nextDevice = moduleState.device) => {
			const wv = webviewRef.current;
			if (!wv) return;
			applyDeviceUserAgent(wv, nextDevice);
			setUrl(targetUrl);
			setInputValue(targetUrl);
			wv.loadURL(targetUrl);
		},
		[applyDeviceUserAgent],
	);

	useEffect(() => {
		const wv = webviewRef.current;
		if (!wv) return;

		if (!defaultUARef.current) {
			try {
				defaultUARef.current = wv.getUserAgent();
			} catch {
				defaultUARef.current = null;
			}
		}
		applyDeviceUserAgent(wv, moduleState.device);

		const onDomReady = () => {
			webviewReadyRef.current = true;
		};
		wv.addEventListener("dom-ready", onDomReady);

		const onDidNavigate = (event: Event) => {
			const nextUrl = (event as unknown as WebviewEvent<"did-navigate">).url;
			setUrl(nextUrl);
			setInputValue(nextUrl);
			setCanGoBack(wv.canGoBack());
			setCanGoForward(wv.canGoForward());
			updateActiveTab({ url: nextUrl });
		};
		const onDidNavigateInPage = (event: Event) => {
			const evt = event as unknown as WebviewEvent<"did-navigate-in-page">;
			if (!evt.isMainFrame) return;
			setUrl(evt.url);
			setInputValue(evt.url);
			updateActiveTab({ url: evt.url });
		};
		const onDidStartLoading = () => setIsLoading(true);
		const onDidStopLoading = () => {
			setIsLoading(false);
			setLoadProgress(0);
			setCanGoBack(wv.canGoBack());
			setCanGoForward(wv.canGoForward());
		};
		const onProgress = (event: Event) => {
			const progress = (event as unknown as WebviewEvent<"load-progress">).progress;
			setLoadProgress(progress);
		};
		// page-title-updated 只接收真实 title，不 fallback 到 url/DEFAULT_HOME，
		// 避免 tab 标题闪烁。初始空 title 由 tab 渲染 fallback 到 url。
		const onPageTitleUpdated = (event: Event) => {
			const title = (event as unknown as WebviewEvent<"page-title-updated">).title;
			if (title) {
				updateActiveTab({ title });
			}
		};
		const onNewWindow = (event: Event) => {
			const evt = event as unknown as WebviewEvent<"new-window">;
			// 始终阻止默认弹窗行为，由我们接管分发
			evt.preventDefault();
			if (evt.url.startsWith("http://") || evt.url.startsWith("https://")) {
				// 页面内 target="_blank" 或 window.open 链接在浏览器新 tab 中打开
				navigateTo(evt.url);
			} else {
				// 非 http 协议（mailto: 等）走系统默认浏览器
				void window.piDesktop.browser.openExternal(evt.url);
			}
		};

		wv.addEventListener("did-navigate", onDidNavigate);
		wv.addEventListener("did-navigate-in-page", onDidNavigateInPage);
		wv.addEventListener("did-start-loading", onDidStartLoading);
		wv.addEventListener("did-stop-loading", onDidStopLoading);
		wv.addEventListener("load-progress", onProgress);
		wv.addEventListener("page-title-updated", onPageTitleUpdated);
		wv.addEventListener("new-window", onNewWindow);

		return () => {
			wv.removeEventListener("dom-ready", onDomReady);
			wv.removeEventListener("did-navigate", onDidNavigate);
			wv.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
			wv.removeEventListener("did-start-loading", onDidStartLoading);
			wv.removeEventListener("did-stop-loading", onDidStopLoading);
			wv.removeEventListener("load-progress", onProgress);
			wv.removeEventListener("page-title-updated", onPageTitleUpdated);
			wv.removeEventListener("new-window", onNewWindow);
			webviewReadyRef.current = false;
		};
	}, [applyDeviceUserAgent, updateActiveTab, url]);

	// 不再在卸载时清空 moduleState：折叠抽屉、切换面板后重新打开仍保留之前的 tab 状态。
	// 关闭最后一个 tab 时 closeTab 已处理 moduleState 清理并调用 onClose。
	// 组件首次挂载时如果 tabs 为空，ensureInitialTab 会创建默认页面。

	const navigate = useCallback(
		(targetUrl?: string) => {
			let finalUrl = targetUrl ?? inputValue.trim();
			if (!finalUrl) return;
			if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(finalUrl)) {
				finalUrl = `https://${finalUrl}`;
			}
			loadUrl(finalUrl);
		},
		[inputValue, loadUrl],
	);

	const switchTab = useCallback(
		(tabId: string) => {
			const tab = moduleState.tabs.find((item) => item.id === tabId);
			if (!tab) return;
			moduleState.activeTabId = tabId;
			setActiveTabId(tabId);
			loadUrl(tab.url);
		},
		[loadUrl],
	);

	const addTab = useCallback(() => {
		const id = genTabId();
		const newTab = { id, title: t("browser.newTab"), url: DEFAULT_HOME };
		persistTabs([...moduleState.tabs, newTab], id);
		loadUrl(DEFAULT_HOME);
	}, [loadUrl, persistTabs]);

	// webview 是否已触发 dom-ready，用于延迟外部导航直到 webview 就绪。
	const webviewReadyRef = useRef(false);

	// 轮询检测 navigateTo 设置的 pendingNavigateUrl（module 变量不触发 React 重渲染）
	useEffect(() => {
		const interval = window.setInterval(() => {
			if (!pendingNavigateUrl) return;
			const url = pendingNavigateUrl;
			moduleState.navigateKey = 0;
			const wv = webviewRef.current;
			if (!wv) return;
			// 如果 webview 正在加载中，跳过本次轮询保留 pendingNavigateUrl，
			// 下次轮询会重试，避免 URL 被静默丢弃
			if (wv.isLoading && wv.isLoading()) return;
			// 通过加载检查后才消费 URL，防止加载中时丢请求
			pendingNavigateUrl = null;
			const activeTab = moduleState.tabs.find((t) => t.id === moduleState.activeTabId);
			if (activeTab) {
				applyDeviceUserAgent(wv, moduleState.device);
				setTabs([...moduleState.tabs]);
				setActiveTabId(moduleState.activeTabId);
				wv.loadURL(url).catch(() => {});
			}
		}, 50);
		return () => window.clearInterval(interval);
	}, [applyDeviceUserAgent]);

	const closeTab = useCallback(
		(tabId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			const current = moduleState.tabs;
			if (current.length <= 1) {
				// 关闭最后一个 tab 时从 moduleState 移除，避免下次 navigateTo 时旧 tab 还在
				moduleState.tabs = [];
				moduleState.activeTabId = null;
				moduleState.navigateKey = 0;
				pendingNavigateUrl = null;
				onClose?.();
				return;
			}
			const index = current.findIndex((tab) => tab.id === tabId);
			const nextTabs = current.filter((tab) => tab.id !== tabId);
			let nextActiveId = moduleState.activeTabId;
			if (nextActiveId === tabId) {
				nextActiveId = nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null;
			}
			persistTabs(nextTabs, nextActiveId);
			const nextTab = nextTabs.find((tab) => tab.id === nextActiveId);
			if (nextTab) loadUrl(nextTab.url);
		},
		[loadUrl, onClose, persistTabs],
	);

	const selectDevice = useCallback(
		(nextDevice: DeviceType) => {
			moduleState.device = nextDevice;
			setDevice(nextDevice);
			setDeviceMenuOpen(false);
			// 仅改 UA 不会触发布局变化；同时切换 browser-panel 的 device class 限制 webview 视口宽度。
			loadUrl(url || DEFAULT_HOME, nextDevice);
		},
		[loadUrl, url],
	);

	useEffect(() => {
		if (!deviceMenuOpen) return;
		const handleMouseDown = (event: MouseEvent) => {
			if (!deviceMenuRef.current?.contains(event.target as Node)) {
				setDeviceMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [deviceMenuOpen]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			navigate();
		},
		[navigate],
	);

	const panelClass = `browser-panel${props.isFullscreen ? " is-fullscreen" : ""} device-${device}`;
	const activeDevicePreset = DEVICE_PRESETS.find((preset) => preset.id === device) ?? DEVICE_PRESETS[0];
	const deviceIcon = device === "mobile" ? <Smartphone size={13} /> : device === "tablet" ? <Tablet size={13} /> : null;

	return (
		<div className={panelClass} onClick={(event) => event.stopPropagation()}>
			<div className="browser-tabbar">
				{tabs.map((tab) => (
					<div
						key={tab.id}
						className={`browser-tab${tab.id === activeTabId ? " active" : ""}`}
						onClick={() => switchTab(tab.id)}
					>
						<span className="browser-tab-title">{tab.title || tab.url}</span>
						<button className="browser-tab-close" onClick={(event) => closeTab(tab.id, event)} title={t("browser.closeTab")}>
							<X size={11} />
						</button>
					</div>
				))}
				<button className="browser-tab-add" onClick={addTab} title={t("browser.newTab")}>
					<Plus size={14} />
				</button>
				{!props.isFullscreen && (
					<div className="browser-tabbar-actions">
						<button className="browser-tabbar-btn" onClick={onToggleFullscreen} title={t("browser.fullscreen")}>
							<Maximize2 size={13} />
						</button>
						{/* 统一 drawer chrome 已提供关闭；此处仅在独立/旧布局时保留 */}
						{!props.hideChromeClose && (
							<button className="browser-tabbar-btn" onClick={onClose} title={t("common.close")}>
								<X size={14} />
							</button>
						)}
					</div>
				)}
			</div>

			<div className="browser-toolbar">
				<button className="browser-nav-btn" disabled={!canGoBack} onClick={() => webviewRef.current?.goBack()} title={t("browser.back")}>
					<ArrowLeft size={15} />
				</button>
				<button className="browser-nav-btn" disabled={!canGoForward} onClick={() => webviewRef.current?.goForward()} title={t("browser.forward")}>
					<ArrowRight size={15} />
				</button>
				<button className="browser-nav-btn" onClick={() => webviewRef.current?.reload()} title={t("browser.reload")}>
					<RefreshCw size={15} />
				</button>
				<button className="browser-nav-btn" onClick={() => loadUrl(DEFAULT_HOME)} title={t("browser.home")}>
					<Home size={15} />
				</button>
				<div className="browser-url-bar">
					<input
						type="text"
						className="browser-url-input"
						value={inputValue}
						onChange={(event) => setInputValue(event.target.value)}
						onKeyDown={handleKeyDown}
						onFocus={(event) => event.target.select()}
						placeholder={t("browser.urlPlaceholder")}
					/>
				</div>
				<div className="browser-device-wrapper" ref={deviceMenuRef}>
					<button
						type="button"
						className={`browser-device-trigger${deviceMenuOpen ? " active" : ""}`}
						onClick={() => setDeviceMenuOpen((open) => !open)}
						title={t("browser.deviceLabel")}
					>
						{deviceIcon}
						<span>{t(activeDevicePreset.label as any)}</span>
					</button>
					{deviceMenuOpen && (
						<div className="browser-device-menu">
							{DEVICE_PRESETS.map((preset) => (
								<button
									key={preset.id}
									type="button"
									className={`browser-device-menu-item${preset.id === device ? " active" : ""}`}
									onClick={() => selectDevice(preset.id)}
								>
									{preset.id === "mobile" ? <Smartphone size={13} /> : preset.id === "tablet" ? <Tablet size={13} /> : <span className="browser-device-pc-dot" />}
									<span>{t(preset.label as any)}</span>
								</button>
							))}
						</div>
					)}
				</div>
				{props.isFullscreen ? (
					<>
						<button className="browser-nav-btn" onClick={onMinimize} title={t("browser.minimize")}>
							<Minus size={15} />
						</button>
						<button className="browser-nav-btn" onClick={onClose} title={t("browser.close")}>
							<X size={15} />
						</button>
					</>
				) : null}
			</div>

			{isLoading && (
				<div className="browser-loading-bar">
					<div className="browser-loading-fill" style={{ width: `${Math.max(5, loadProgress * 100)}%` }} />
				</div>
			)}

			<div className="browser-webview-stage">
				<webview ref={(el) => { (webviewRef as React.MutableRefObject<any>).current = el; if (el) el.setAttribute("allowfileaccess", "true"); }} className="browser-webview" src={initialTab.url} allowpopups={"true" as any} />
			</div>
		</div>
	);
}
