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

// ── 订阅机制：替代轮询 ──────────────────────────────────
// navigateTo 设置 pendingUrl 并通知所有已注册的订阅者。
// BrowserPanel 挂载时注册回调，卸载时取消。
// 未挂载时 URL 留在 pendingUrl，挂载时消费。

type NavigateListener = (url: string) => void;

const navigateListeners = new Set<NavigateListener>();
let pendingUrl: string | null = null;

/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 如果没有订阅者（BrowserPanel 未挂载），URL 存入 pendingUrl，待挂载时消费。
 * 有订阅者时立即通知，订阅者负责创建 tab + loadURL。
 */
export function navigateTo(url: string) {
	pendingUrl = url;
	for (const listener of navigateListeners) {
		listener(url);
	}
}

function subscribeNavigate(listener: NavigateListener): () => void {
	navigateListeners.add(listener);
	return () => navigateListeners.delete(listener);
}

function consumePendingUrl(): string | null {
	const url = pendingUrl;
	pendingUrl = null;
	return url;
}

// ── 跨挂载持久化状态 ────────────────────────────────────
// useRef 在组件卸载/重挂时保留对象引用，实现抽屉折叠/展开不丢状态。

interface BrowserState {
	tabs: TabEntry[];
	activeTabId: string | null;
	device: DeviceType;
}

function ensureInitialTabs(state: BrowserState): void {
	if (state.tabs.length > 0) return;
	const id = genTabId();
	state.tabs = [{ id, title: "OmpDeck", url: DEFAULT_HOME }];
	state.activeTabId = id;
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

	// 跨挂载持久化：ref 对象在组件卸载/重挂间保留
	const stateRef = useRef<BrowserState>({
		tabs: [],
		activeTabId: null,
		device: "pc",
	});
	ensureInitialTabs(stateRef.current);
	const initialTab = stateRef.current.tabs.find(
		(tab) => tab.id === stateRef.current.activeTabId,
	) ?? stateRef.current.tabs[0];

	const webviewRef = useRef<any>(null);
	const defaultUARef = useRef<string | null>(null);
	const webviewReadyRef = useRef(false);
	const pendingDomReadyUrl = useRef<string | null>(null);

	const [tabs, setTabs] = useState<TabEntry[]>(() => [...stateRef.current.tabs]);
	const [activeTabId, setActiveTabId] = useState<string | null>(
		() => stateRef.current.activeTabId,
	);
	const [url, setUrl] = useState(initialTab.url);
	const [inputValue, setInputValue] = useState(initialTab.url);
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [loadProgress, setLoadProgress] = useState(0);
	const [device, setDevice] = useState<DeviceType>(() => stateRef.current.device);
	const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
	const deviceMenuRef = useRef<HTMLDivElement | null>(null);

	// ── 状态操作 helper（同时更新 ref + useState）────────────

	const syncTabs = useCallback((nextTabs: TabEntry[], nextActiveId: string | null) => {
		stateRef.current.tabs = nextTabs;
		stateRef.current.activeTabId = nextActiveId;
		setTabs([...nextTabs]);
		setActiveTabId(nextActiveId);
	}, []);

	const updateActiveTab = useCallback((patch: Partial<TabEntry>) => {
		if (!stateRef.current.activeTabId) return;
		const nextTabs = stateRef.current.tabs.map((tab) =>
			tab.id === stateRef.current.activeTabId ? { ...tab, ...patch } : tab,
		);
		stateRef.current.tabs = nextTabs;
		setTabs([...nextTabs]);
	}, []);

	const applyDeviceUserAgent = useCallback((wv: any, nextDevice: DeviceType) => {
		const preset = DEVICE_PRESETS.find((item) => item.id === nextDevice);
		if (preset?.userAgent) {
			wv.setUserAgent(preset.userAgent);
		} else if (defaultUARef.current) {
			wv.setUserAgent(defaultUARef.current);
		}
	}, []);

	const loadUrl = useCallback(
		(targetUrl: string, nextDevice = stateRef.current.device) => {
			const wv = webviewRef.current;
			if (!wv) return;
			// webview 尚未 DOM-ready：排队，dom-ready 事件中消费
			if (!webviewReadyRef.current) {
				pendingDomReadyUrl.current = targetUrl;
				return;
			}
			applyDeviceUserAgent(wv, nextDevice);
			setUrl(targetUrl);
			setInputValue(targetUrl);
			wv.loadURL(targetUrl);
		},
		[applyDeviceUserAgent],
	);

	// ── 外部导航订阅 ────────────────────────────────────────
	// 挂载时注册回调：先消费 pendingUrl，再接收后续 navigateTo 调用。
	// 卸载时取消订阅：后续 navigateTo 只存 pendingUrl，待下次挂载消费。

	useEffect(() => {
		const handleNavigate = (targetUrl: string) => {
			// 每次外部导航创建新 tab，避免多个链接复用同一个 tab
			const id = genTabId();
			const nextTabs = [...stateRef.current.tabs, { id, title: "", url: targetUrl }];
			syncTabs(nextTabs, id);
			// webview.loadURL 会自动中断当前加载
			loadUrl(targetUrl);
		};

		// 挂载时消费未处理的导航请求
		const queued = consumePendingUrl();
		if (queued) {
			handleNavigate(queued);
		}

		return subscribeNavigate(handleNavigate);
	}, [loadUrl, syncTabs]);

	// ── webview 事件绑定 ────────────────────────────────────

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
		applyDeviceUserAgent(wv, stateRef.current.device);

		const onDomReady = () => {
			webviewReadyRef.current = true;
			// 消费 DOM-ready 前排队的导航请求
			if (pendingDomReadyUrl.current) {
				const queuedUrl = pendingDomReadyUrl.current;
				pendingDomReadyUrl.current = null;
				applyDeviceUserAgent(wv, stateRef.current.device);
				setUrl(queuedUrl);
				setInputValue(queuedUrl);
				wv.loadURL(queuedUrl);
			}
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
		const onPageTitleUpdated = (event: Event) => {
			const title = (event as unknown as WebviewEvent<"page-title-updated">).title;
			if (title) {
				updateActiveTab({ title });
			}
		};
		const onNewWindow = (event: Event) => {
			const evt = event as unknown as WebviewEvent<"new-window">;
			evt.preventDefault();
			if (evt.url.startsWith("http://") || evt.url.startsWith("https://")) {
				navigateTo(evt.url);
			} else {
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

	// ── 用户交互 ────────────────────────────────────────────

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
			const tab = stateRef.current.tabs.find((item) => item.id === tabId);
			if (!tab) return;
			stateRef.current.activeTabId = tabId;
			setActiveTabId(tabId);
			loadUrl(tab.url);
		},
		[loadUrl],
	);

	const addTab = useCallback(() => {
		const id = genTabId();
		const newTab = { id, title: t("browser.newTab"), url: DEFAULT_HOME };
		syncTabs([...stateRef.current.tabs, newTab], id);
		loadUrl(DEFAULT_HOME);
	}, [loadUrl, syncTabs]);

	const closeTab = useCallback(
		(tabId: string, event: React.MouseEvent) => {
			event.stopPropagation();
			const current = stateRef.current.tabs;
			if (current.length <= 1) {
				// 关闭最后一个 tab 时清空状态，避免下次 navigateTo 时旧 tab 还在
				syncTabs([], null);
				onClose?.();
				return;
			}
			const index = current.findIndex((tab) => tab.id === tabId);
			const nextTabs = current.filter((tab) => tab.id !== tabId);
			let nextActiveId = stateRef.current.activeTabId;
			if (nextActiveId === tabId) {
				nextActiveId = nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null;
			}
			syncTabs(nextTabs, nextActiveId);
			const nextTab = nextTabs.find((tab) => tab.id === nextActiveId);
			if (nextTab) loadUrl(nextTab.url);
		},
		[loadUrl, onClose, syncTabs],
	);

	const selectDevice = useCallback(
		(nextDevice: DeviceType) => {
			stateRef.current.device = nextDevice;
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
