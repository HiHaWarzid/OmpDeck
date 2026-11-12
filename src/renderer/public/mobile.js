/* OmpDeck 手机端：轻量页面，不加载桌面 renderer 的 4MB bundle。
 * 只依赖 /api/state?light=1、/api/projects/:id/sessions、
 * /api/agents/:id/messages?tail=N、/api/agents/:id/history-page 和
 * /api/agents/:id/messages/:messageId（展开折叠内容）这些已有接口。 */
(() => {
	const stateApi = globalThis.OmpMobileState;
	const TAIL_LIMIT = 40;
	// 首页历史会话先渲染一页，滑到底部再追加；避免一次把几百条 row 全部塞进 DOM。
	const SESSION_PAGE_SIZE = 40;
	const MAX_IMAGES = 4;
	// 服务端请求体上限 2MB；base64 会膨胀约 33%，给文本和 JSON 留出余量。
	const MAX_IMAGE_DATA_CHARS = 700_000;
	const MAX_TOTAL_IMAGE_DATA_CHARS = 1_500_000;
	const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
	const MAX_IMAGE_DIMENSION = 1600;
	const HOME_CACHE_KEY = "omp-mobile-home-cache-v1";
	const PROJECTS_CACHE_KEY = "omp-mobile-projects-cache-v1";
	const $ = (id) => document.getElementById(id);
	const view = $("view");
	const composer = $("composer");
	const input = $("input");
	const sendButton = $("send");
	const sendMoreButton = $("send-more");
	const sendMenu = $("send-menu");
	const attachButton = $("attach");
	const imageInput = $("image-input");
	const attachmentsEl = $("attachments");
	const stopButton = $("stop");
	const backButton = $("back");
	const refreshButton = $("refresh");
	const tabs = $("tabs");
	const newSessionButton = $("new-session");
	const loadingBar = $("loading-bar");
	const toastEl = $("toast");
	const sheetEl = $("sheet");
	const sheetTitle = $("sheet-title");
	const sheetBody = $("sheet-body");

	function storageGet(key) {
		try {
			return localStorage.getItem(key) || "";
		} catch {
			// 浏览器禁用存储时仍然允许通过 URL 令牌临时使用。
			return "";
		}
	}

	function storageSet(key, value) {
		try {
			if (value) localStorage.setItem(key, value);
			else localStorage.removeItem(key);
		} catch {
			// 隐私模式/配额满时内存中的令牌仍可用于本次会话。
		}
	}

	const params = new URLSearchParams(location.search);
	const urlToken = params.get("token") || "";
	if (urlToken) {
		params.delete("token");
		const query = params.toString();
		history.replaceState(null, "", location.pathname + (query ? `?${query}` : ""));
	}
	// URL 里的令牌先当临时令牌，只有请求成功才落盘；否则一个过期/错误的扫码链接
	// 会覆盖 localStorage 里原本有效的令牌，把已连接设备踢下线。
	let token = urlToken || storageGet("omp-mobile-token");
	let pendingUrlToken = urlToken;

	let appState = { projects: readProjectsCache(), agents: [] };
	let projectId = storageGet("omp-mobile-project");
	let sessions = [];
	let visibleSessionCount = SESSION_PAGE_SIZE;
	let homeHistoryCount = 0;
	let homeHistorySessions = [];
	let activeAgentId = null;
	let activeAgent = null;
	let chatMessages = [];
	let olderMessages = [];
	let nextCursor = null;
	let pollTimer = null;
	let pollInFlight = false;
	let pollRequestId = 0;
	let refreshQueued = false;
	let epoch = 0;
	let supportsTail = null;
	let sending = false;
	let imageBusy = false;
	let agentRunning = false;
	let composerStateKey = "";
	let pendingImages = [];
	let lastStatus = "";
	let toastTimer = null;
	let loadingRequests = 0;
	let loadingBarTimer = null;
	let lastViewKey = "";
	let currentTab = "home";
	let currentRuntime = {};
	let searchQuery = "";
	let lastMessageId = "";
	let messageVersion = "";
	let connectionState = "";
	let newMessageCount = 0;
	let pendingResumeAgentId = null;
	let creating = false;
	let homeCache = readHomeCache();
	let homeSearchKeys = new Map();

	function escapeHtml(value) {
		return String(value ?? "").replace(/[&<>"']/g, (char) => {
			switch (char) {
				case "&":
					return "&amp;";
				case "<":
					return "&lt;";
				case ">":
					return "&gt;";
				case '"':
					return "&quot;";
				default:
					return "&#39;";
			}
		});
	}

	function updateComposerState() {
		const disabled = sending || imageBusy;
		// 轮询每 500ms 调一次；状态没变时避免重复写 disabled/textContent/aria，
		// 这些写入会触发样式与可访问性树更新。
		const key = `${sending ? 1 : 0}:${imageBusy ? 1 : 0}:${agentRunning ? 1 : 0}`;
		if (key === composerStateKey) return;
		composerStateKey = key;
		sendButton.disabled = disabled;
		attachButton.disabled = disabled;
		sendMoreButton.hidden = !agentRunning || disabled;
		sendButton.textContent = agentRunning ? "加入" : "发送";
		sendButton.setAttribute("aria-label", agentRunning ? "加入当前回合" : "发送消息");
		if (!agentRunning || disabled) closeSendMenu();
	}

	function closeSendMenu() {
		sendMenu.hidden = true;
		sendMoreButton.setAttribute("aria-expanded", "false");
	}

	function renderAttachments() {
		attachmentsEl.hidden = pendingImages.length === 0;
		attachmentsEl.innerHTML = pendingImages
			.map(
				(image, index) =>
					`<div class="attachment"><img src="data:${escapeHtml(image.mimeType)};base64,${escapeHtml(image.data)}" alt="图片 ${index + 1}" /><button type="button" data-remove-image="${index}" aria-label="移除图片 ${index + 1}">×</button></div>`,
			)
			.join("");
	}

	function loadImageElement(file) {
		return new Promise((resolve, reject) => {
			const url = URL.createObjectURL(file);
			const image = new Image();
			image.onload = () => {
				URL.revokeObjectURL(url);
				resolve(image);
			};
			image.onerror = () => {
				URL.revokeObjectURL(url);
				reject(new Error("无法读取这张图片"));
			};
			image.src = url;
		});
	}

	async function loadImageSource(file) {
		// createImageBitmap 能正确处理手机照片方向；Safari 旧版本没有该 API 时退回 Image。
		if (typeof createImageBitmap === "function") {
			try {
				return await createImageBitmap(file, { imageOrientation: "from-image" });
			} catch {
				// 继续走 Image 解码兜底。
			}
		}
		return loadImageElement(file);
	}

	async function encodeImage(file) {
		if (!file.type.startsWith("image/")) throw new Error("只支持图片文件");
		if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error("图片不能超过 20MB");
		const source = await loadImageSource(file);
		const width = Number(source.width || source.naturalWidth || 0);
		const height = Number(source.height || source.naturalHeight || 0);
		if (!width || !height) {
			source.close?.();
			throw new Error("图片尺寸无效");
		}
		const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		const context = canvas.getContext("2d");
		if (!context) {
			source.close?.();
			throw new Error("浏览器无法处理图片");
		}
		// JPEG 不支持透明通道，先铺白底，避免 PNG 透明区域变成黑色。
		context.fillStyle = "#fff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(source, 0, 0, canvas.width, canvas.height);
		source.close?.();
		let dataUrl = "";
		for (const quality of [0.85, 0.7, 0.55]) {
			dataUrl = canvas.toDataURL("image/jpeg", quality);
			if (dataUrl.length <= MAX_IMAGE_DATA_CHARS) break;
		}
		const comma = dataUrl.indexOf(",");
		const data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
		if (!data || data.length > MAX_IMAGE_DATA_CHARS) throw new Error("图片压缩后仍然过大");
		return { type: "image", mimeType: "image/jpeg", data };
	}

	async function addImages(files) {
		if (sending || imageBusy) return;
		const requestEpoch = epoch;
		const requestAgentId = activeAgentId;
		const remaining = MAX_IMAGES - pendingImages.length;
		if (remaining <= 0) {
			toast(`最多添加 ${MAX_IMAGES} 张图片`);
			return;
		}
		if (files.length > remaining) toast(`最多添加 ${MAX_IMAGES} 张图片，已忽略多余的图片`);
		imageBusy = true;
		updateComposerState();
		try {
			for (const file of files.slice(0, remaining)) {
				try {
					const image = await encodeImage(file);
					if (!isCurrentRequest(requestEpoch, requestAgentId)) return;
					const total = pendingImages.reduce((sum, item) => sum + item.data.length, image.data.length);
					if (total > MAX_TOTAL_IMAGE_DATA_CHARS) {
						toast("图片总大小超出限制，请减少图片数量");
						continue;
					}
					pendingImages.push(image);
					renderAttachments();
				} catch (error) {
					if (isCurrentRequest(requestEpoch, requestAgentId)) {
						toast(error?.message || "图片读取失败");
					}
				}
			}
		} finally {
			// 切会话后旧图片编码结束不能解除新会话的发送状态。
			if (requestEpoch === epoch) {
				imageBusy = false;
				updateComposerState();
			}
		}
	}

	function readHomeCache() {
		try {
			const parsed = JSON.parse(localStorage.getItem(HOME_CACHE_KEY) || "{}");
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}

	function readProjectsCache() {
		try {
			const parsed = JSON.parse(localStorage.getItem(PROJECTS_CACHE_KEY) || "[]");
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	function writeProjectsCache(projects) {
		try {
			localStorage.setItem(PROJECTS_CACHE_KEY, JSON.stringify((projects || []).slice(0, 100)));
		} catch {
			// 隐私模式下 localStorage 不可用时，项目列表只保留在内存里。
		}
	}

	function writeHomeCache() {
		try {
			const entries = Object.entries(homeCache)
				.sort((left, right) => (right[1]?.at || 0) - (left[1]?.at || 0))
				.slice(0, 8)
				.map(([id, entry]) => [
					id,
					{
						...entry,
						// 内存里保留完整列表供分页；localStorage 只留首屏快照，
						// 避免 8 个项目 × 几百条 preview 触发配额上限后整份缓存丢失。
						sessions: Array.isArray(entry?.sessions)
							? entry.sessions.slice(0, 100)
							: entry?.sessions,
					},
				]);
			localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
		} catch {
			// localStorage 满或隐私模式不可用时，首页仍可在内存里使用。
		}
	}

	// 子会话过滤由服务端 ?topLevel=1 用 shared/sessionDisplayContract 统一完成；
	// 手机端只缓存服务端返回的列表，不再复制一份规则（旧本地缓存可能含子会话，
	// 下次写入即被服务端结果覆盖）。
	function cacheSessions(id, list) {
		if (!id) return;
		homeCache[id] = {
			at: Date.now(),
			// 不再截断到 100 条：手机端分页只控制 DOM 渲染数量，数据层要保留完整列表，
			// 否则滑到底部也无法加载第 101 条之后的历史会话。
			sessions: Array.isArray(list) ? list : [],
		};
		writeHomeCache();
	}

	function cachedSessions(id) {
		return Array.isArray(homeCache[id]?.sessions) ? homeCache[id].sessions : [];
	}

	function renderSkeleton() {
		view.setAttribute("aria-busy", "true");
		view.innerHTML = `
			<div class="search skeleton-search"></div>
			<div class="section-title">项目</div>
			<div class="chips">${Array.from({ length: 3 }, () => '<span class="chip skeleton-chip"></span>').join("")}</div>
			<div class="section-title">历史会话</div>
			<div class="card">${Array.from({ length: 5 }, () => '<div class="row skeleton-row"><span class="skeleton-line"></span><span class="skeleton-line short"></span></div>').join("")}</div>`;
	}

	function toast(message) {
		toastEl.textContent = message;
		toastEl.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toastEl.hidden = true;
		}, 3200);
	}

	/**
	 * 全局请求指示器：短请求不闪烁，超过 150ms 才显示顶部进度条。
	 * 轮询也走 api()，但通常很快完成，不会每 3 秒闪一次。
	 */
	function beginLoading() {
		loadingRequests += 1;
		if (loadingRequests !== 1 || !loadingBar) return;
		loadingBarTimer = setTimeout(() => {
			loadingBarTimer = null;
			if (loadingRequests > 0 && loadingBar) loadingBar.hidden = false;
		}, 150);
	}

	function endLoading() {
		loadingRequests = Math.max(0, loadingRequests - 1);
		if (loadingRequests > 0) return;
		if (loadingBarTimer) {
			clearTimeout(loadingBarTimer);
			loadingBarTimer = null;
		}
		if (loadingBar) loadingBar.hidden = true;
	}

	async function api(path, options = {}) {
		const { timeout: timeoutMs = 10000, ...fetchOptions } = options;
		const headers = { accept: "application/json", ...(fetchOptions.headers || {}) };
		if (token) headers["x-omp-token"] = token;
		if (fetchOptions.body) headers["content-type"] = "application/json";
		const controller = new AbortController();
		// 0 表示不设客户端超时：prompt 的 RPC 可能跑满主进程的 rpcTimeout，
		// 固定 10s 中断会让已受理的消息被当成失败并触发重发。
		const timeout =
			timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
		beginLoading();
		try {
			const response = await fetch(path, {
				cache: "no-store",
				...fetchOptions,
				headers,
				signal: controller.signal,
			});
			const text = await response.text();
			let data = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				data = null;
			}
			if (!response.ok) {
				// 扫码链接里的临时令牌失效时，优先回退到本机已保存的令牌；
				// 401 只代表服务端拒绝，未产生副作用，重试是安全的。
				if (response.status === 401 && pendingUrlToken && token === pendingUrlToken) {
					const stored = storageGet("omp-mobile-token");
					if (stored && stored !== token) {
						token = stored;
						pendingUrlToken = "";
						return api(path, options);
					}
				}
				const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
				error.status = response.status;
				throw error;
			}
			if (pendingUrlToken && token === pendingUrlToken) {
				storageSet("omp-mobile-token", token);
				pendingUrlToken = "";
			}
			return data;
		} catch (error) {
			if (error?.name === "AbortError") {
				const timeoutError = new Error("请求超时");
				timeoutError.code = "timeout";
				throw timeoutError;
			}
			// fetch 在断网/服务未启动时只抛 TypeError("Failed to fetch")，换成可读提示。
			if (error instanceof TypeError) {
				const networkError = new Error("网络连接失败");
				networkError.code = "network";
				throw networkError;
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			endLoading();
		}
	}

	function handleError(error) {
		if (error?.status === 401) {
			token = "";
			pendingUrlToken = "";
			storageSet("omp-mobile-token", "");
			storageSet("ompdeck.web.token", "");
			if (activeAgentId) pendingResumeAgentId = activeAgentId;
			renderTokenPrompt();
			toast("访问令牌无效或已过期");
			return;
		}
		toast(error?.message || "请求失败");
	}

	function updateTabs() {
		document.querySelectorAll("[data-tab]").forEach((button) => {
			button.classList.toggle("active", button.dataset.tab === currentTab);
		});
	}

	function setHeader(title, subtitle, options = {}) {
		$("title").textContent = title;
		$("subtitle").textContent = subtitle || "";
		backButton.hidden = !options.back;
		composer.hidden = !options.composer;
		const showTabs = options.tabs ?? !options.composer;
		tabs.hidden = !showTabs;
		updateTabs();
	}

	function setConnection(state) {
		if (connectionState === state) return;
		connectionState = state;
		const banner = $("connection");
		if (!banner) return;
		if (state === "online") {
			banner.hidden = true;
			return;
		}
		banner.hidden = false;
		banner.textContent =
			state === "offline" ? "连接中断，点此重试" : "连接中…";
	}

	/** 只在真正的视图切换时播放一次进入动画；轮询重绘不会触发。 */
	function animateView() {
		const key = activeAgentId ? `agent:${activeAgentId}` : currentTab;
		if (key === lastViewKey) return;
		lastViewKey = key;
		if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		view.classList.remove("view-enter");
		// 强制重排后再加 class，确保连续切换也能重新播放动画。
		void view.offsetWidth;
		view.classList.add("view-enter");
	}

	function resetChatEpoch() {
		epoch += 1;
		pollInFlight = false;
		refreshQueued = false;
		newMessageCount = 0;
	}

	function renderTokenPrompt() {
		stopPolling();
		resetChatEpoch();
		closeSheet();
		currentTab = "home";
		activeAgentId = null;
		activeAgent = null;
		setHeader("OmpDeck", "需要访问令牌", { tabs: false });
		view.innerHTML = `
			<div class="card token-form">
				<div class="section-title">连接 OmpDeck</div>
				<div class="meta">粘贴设置页里的访问令牌，或重新扫描带 token 的二维码。</div>
				<input id="token-input" autocomplete="off" spellcheck="false" placeholder="omp_..." />
				<button id="token-save" class="primary" type="button">连接</button>
			</div>`;
		view.scrollTop = 0;
		view.setAttribute("aria-busy", "false");
		$("token-save").addEventListener("click", async () => {
			const value = $("token-input").value.trim();
			if (!value) return;
			token = value;
			pendingUrlToken = "";
			storageSet("omp-mobile-token", token);
			await boot();
		});
		$("token-input").addEventListener("keydown", (event) => {
			if (event.key === "Enter") $("token-save").click();
		});
	}

	function renderFatal(error) {
		closeSheet();
		setHeader("OmpDeck", "连接失败", { tabs: true });
		view.innerHTML = `
			<div class="card empty">
				<div>${escapeHtml(error?.message || "无法连接到 OmpDeck")}</div>
				<button id="retry" class="primary" type="button">重试</button>
			</div>`;
		view.scrollTop = 0;
		view.setAttribute("aria-busy", "false");
		$("retry").addEventListener("click", () => void boot());
	}

	function projectName(id) {
		return appState.projects.find((project) => project.id === id)?.name || id;
	}

	function statusLabel(agent) {
		if (!agent) return "";
		if (agent.status === "running") return "运行中";
		if (agent.status === "starting") return "启动中";
		if (agent.status === "error") return "错误";
		if (agent.status === "closed") return "已关闭";
		return "空闲";
	}

	function thinkingLabel(level) {
		const labels = {
			off: "关闭",
			minimal: "最小",
			low: "低",
			medium: "中",
			high: "高",
			xhigh: "很高",
			max: "最大",
		};
		return labels[level] || level || "默认";
	}

	function badgeClass(status) {
		if (status === "running" || status === "starting") return "badge running";
		if (status === "error") return "badge error";
		return "badge";
	}

	function timeText(timestamp) {
		if (!timestamp) return "";
		const date = new Date(timestamp);
		const now = new Date();
		const sameDay = date.toDateString() === now.toDateString();
		if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return date.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
	}

	async function refreshState() {
		const state = await api("/api/state?light=1");
		appState = {
			projects: Array.isArray(state?.projects) ? state.projects : [],
			agents: Array.isArray(state?.agents) ? state.agents : [],
		};
		writeProjectsCache(appState.projects);
		if (!projectId || !appState.projects.some((project) => project.id === projectId)) {
			projectId = appState.projects[0]?.id || "";
		}
		if (projectId) {
			try {
				localStorage.setItem("omp-mobile-project", projectId);
			} catch {
				// 隐私模式/存储被禁用时只保留内存状态。
			}
		}
	}

	async function loadSessions() {
		if (!projectId) {
			sessions = [];
			return;
		}
		const requestedProject = projectId;
		try {
			const data = await api(
				`/api/projects/${encodeURIComponent(requestedProject)}/sessions?topLevel=1`,
			);
			if (requestedProject !== projectId) return;
			sessions = Array.isArray(data?.sessions) ? data.sessions : [];
			sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
			cacheSessions(requestedProject, sessions);
		} catch (error) {
			// 网络失败时回退到上次缓存，首页不至于变成空白；错误仍交给调用方提示。
			if (requestedProject === projectId && sessions.length === 0) {
				sessions = cachedSessions(requestedProject);
			}
			throw error;
		}
	}

	// state 和 sessions 互不依赖：首页刷新时先并行发出，再按项目是否变化决定是否
	// 复用结果。loadSessions 内部已有 requestedProject 守卫，旧项目的响应会被丢弃。
	function beginSessionsLoad() {
		if (!projectId) return null;
		const requestedProject = projectId;
		return {
			projectId: requestedProject,
			promise: loadSessions().then(
				() => null,
				(error) => error,
			),
		};
	}

	async function finishSessionsLoad(pending) {
		if (!pending || pending.projectId !== projectId) {
			await loadSessions();
			return;
		}
		const error = await pending.promise;
		if (error) throw error;
	}

	function sessionTitle(session) {
		return session.name || session.preview?.split("\n")[0] || "未命名会话";
	}

	function sessionRowHtml(session) {
		const title = sessionTitle(session);
		return `
			<button class="row" type="button" data-session="${escapeHtml(session.filePath)}">
				<span class="grow">
					<span class="name">${escapeHtml(title)}</span>
					<span class="preview">${escapeHtml(session.preview || "")}</span>
					<span class="meta">${escapeHtml(timeText(session.updatedAt))} · ${Number(session.messageCount) || 0} 条${session.degraded ? " · 部分损坏" : ""}</span>
				</span>
				<span class="chev" aria-hidden="true">›</span>
			</button>`;
	}

	/**
	 * 历史列表只渲染当前页。搜索时从完整的内存索引里筛选，而不是依赖 DOM；
	 * 这样既不会为几百条会话创建隐藏节点，也能搜索到尚未“加载更多”的会话。
	 */
	function renderSessionList() {
		const card = $("sessions-card");
		if (!card) return;
		const query = searchQuery.trim().toLowerCase();
		const list = query
			? homeHistorySessions.filter((session) =>
					(homeSearchKeys.get(session.filePath) || "").includes(query),
				)
			: homeHistorySessions.slice(0, visibleSessionCount);
		const rows = list.map(sessionRowHtml).join("");
		const emptyText = query
			? "没有匹配的会话"
			: homeHistorySessions.length === 0
				? appState.agents.some(
						(agent) =>
							agent.projectId === projectId &&
							agent.status !== "closed" &&
							Boolean(agent.sessionPath),
					)
					? "当前会话已在上方"
					: "还没有历史会话"
				: "";
		const loadMore =
			!query && visibleSessionCount < homeHistoryCount
				? '<button class="load-more-sessions" id="load-more-sessions" type="button">加载更多会话</button>'
				: "";
		card.innerHTML = `${rows}${emptyText ? `<div class="empty">${emptyText}</div>` : ""}${loadMore}`;
	}

	// 首页滑到底部或点“加载更多”时追加下一批 row；只重建会话卡片，不重绘整页。
	function revealMoreSessions() {
		if (searchQuery.trim() || visibleSessionCount >= homeHistoryCount) return;
		visibleSessionCount += SESSION_PAGE_SIZE;
		const previousTop = view.scrollTop;
		renderSessionList();
		view.scrollTop = previousTop;
	}

	function renderHome() {
		stopPolling();
		// 首页刷新/重绘不能推进 chat epoch：用户点 + 后，showHome 的异步刷新可能
		// 在创建响应前重绘首页，若这里推进 epoch，创建成功也会被误判为“已切走”。
		// epoch 只在真正离开当前视图（打开会话/设置/切换项目）时推进。
		currentTab = "home";
		activeAgentId = null;
		activeAgent = null;
		animateView();
		setHeader(
			"OmpDeck",
			projectId ? `${projectName(projectId)} · ${sessions.length} 个会话` : "没有项目",
			{ tabs: true },
		);
		const projectChips = appState.projects
			.map(
				(project) =>
					`<button class="chip${project.id === projectId ? " active" : ""}" data-project="${escapeHtml(project.id)}" type="button">${escapeHtml(project.name || project.id)}</button>`,
			)
			.join("");
		const agents = appState.agents.filter((agent) => agent.projectId === projectId && agent.status !== "closed");
		// 已打开的会话已经在“正在使用”里，历史列表再出现一次会让手机首页重复。
		const activeSessionPaths = new Set(agents.map((agent) => agent.sessionPath).filter(Boolean));
		homeHistorySessions = sessions.filter((session) => !activeSessionPaths.has(session.filePath));
		homeHistoryCount = homeHistorySessions.length;
		const agentRows = agents
			.map(
				(agent) => `
				<button class="row" type="button" data-agent="${escapeHtml(agent.id)}">
					<span class="grow">
						<span class="name">${escapeHtml(agent.title || "会话")}</span>
						<span class="meta">${escapeHtml(agent.sessionPath ? "历史会话" : "新会话")} · ${escapeHtml(timeText(agent.createdAt))}</span>
					</span>
					<span class="${badgeClass(agent.status)}">${escapeHtml(statusLabel(agent))}</span>
					<span class="chev" aria-hidden="true">›</span>
				</button>`,
			)
			.join("");
		// 搜索键只留在内存里；渲染时只插入当前页，避免几百条 row 同时进 DOM。
		homeSearchKeys = new Map();
		for (const session of homeHistorySessions) {
			homeSearchKeys.set(
				session.filePath,
				`${sessionTitle(session)} ${session.preview || ""}`.toLowerCase(),
			);
		}
		view.innerHTML = `
			<div class="search">
				<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
				<input id="session-search" type="search" autocomplete="off" placeholder="搜索会话" value="${escapeHtml(searchQuery)}" />
			</div>
			<div class="section-title">项目</div>
			<div class="chips">${projectChips || '<span class="meta">没有项目</span>'}</div>
			${
				agentRows
					? `<div class="section-title">正在使用</div><div class="card">${agentRows}</div>`
					: ""
			}
			<div class="section-title">历史会话</div>
			<div class="card" id="sessions-card"></div>
			<div class="home-note">点会话继续，点底部 + 新建</div>`;
		// 从会话/设置返回时保留聊天滚动位置会让首页停在中段，首页始终从顶部开始。
		view.scrollTop = 0;

		view.querySelectorAll("[data-project]").forEach((button) => {
			button.addEventListener("click", async () => {
				const nextProject = button.dataset.project;
				if (!nextProject || nextProject === projectId) return;
				// 切换项目是真正的视图切换：旧项目里还在创建/打开的会话响应不能再抢界面。
				resetChatEpoch();
				projectId = nextProject;
				searchQuery = "";
				visibleSessionCount = SESSION_PAGE_SIZE;
				try {
					localStorage.setItem("omp-mobile-project", projectId);
				} catch {
					// 存储不可用时不影响当前页面切换。
				}
				sessions = cachedSessions(projectId);
				renderHome();
				try {
					await loadSessions();
					if (projectId === nextProject && currentTab === "home") renderHome();
				} catch (error) {
					handleError(error);
				}
			});
		});
		view.querySelectorAll("[data-agent]").forEach((row) => {
			row.addEventListener("click", () => openAgent(row.dataset.agent));
		});
		// 会话卡片会随分页/搜索重建，点击统一委托到卡片上，避免逐行绑定监听器。
		$("sessions-card")?.addEventListener("click", (event) => {
			if (event.target.closest("#load-more-sessions")) {
				revealMoreSessions();
				return;
			}
			const row = event.target.closest("[data-session]");
			if (row) void openSession(row.dataset.session);
		});
		const search = $("session-search");
		search?.addEventListener("input", () => {
			searchQuery = search.value;
			renderSessionList();
		});
		renderSessionList();
		view.setAttribute("aria-busy", "false");
	}

	let trustWatchTimer = null;
	let trustPollInFlight = false;
	let trustSheetOpen = false;

	function stopTrustWatch() {
		clearInterval(trustWatchTimer);
		trustWatchTimer = null;
	}

	function showTrustSheet(request) {
		trustSheetOpen = true;
		openSheet(
			"项目信任确认",
			`<div class="empty">是否信任项目「${escapeHtml(request.projectName || request.cwd)}」？<br />信任后 Agent 才能在该目录运行。</div>
			<button class="sheet-row" type="button" data-trust-choice="trust-session">
				<span class="grow"><span class="name">本次运行信任</span><span class="meta">仅当前 Agent 会话有效</span></span>
			</button>
			<button class="sheet-row" type="button" data-trust-choice="trust-remember">
				<span class="grow"><span class="name">始终信任</span><span class="meta">写入项目 trust 配置</span></span>
			</button>
			<button class="sheet-row" type="button" data-trust-choice="deny">
				<span class="grow"><span class="name">拒绝</span><span class="meta">本次新建/恢复会话将失败</span></span>
			</button>`,
		);
		sheetBody.querySelectorAll("[data-trust-choice]").forEach((button) => {
			button.addEventListener("click", async () => {
				button.disabled = true;
				try {
					await api(`/api/trust/${encodeURIComponent(request.requestId)}`, {
						method: "POST",
						body: JSON.stringify({ choice: button.dataset.trustChoice }),
					});
					trustSheetOpen = false;
					closeSheet();
				} catch (error) {
					button.disabled = false;
					handleError(error);
				}
			});
		});
	}

	/**
	 * 新建/恢复会话可能等待桌面信任确认（主进程最多等 60s）。手机端没有 IPC
	 * 事件，只能在等待期间轮询 light state，拿到 pending 请求后主动弹层。
	 */
	function watchTrustDuringCreate(requestEpoch) {
		stopTrustWatch();
		trustWatchTimer = setInterval(async () => {
			if (trustPollInFlight) return;
			trustPollInFlight = true;
			try {
				const data = await api("/api/state?light=1");
				// 创建请求已经结束（成功/失败/超时）或用户已离开创建页面时，
				// 迟到的信任轮询不能重新弹层。
				if (!creating || requestEpoch !== epoch) return;
				const request = Array.isArray(data?.trustRequests) ? data.trustRequests[0] : null;
				if (!request) return;
				stopTrustWatch();
				showTrustSheet(request);
			} catch {
				// 等待期间的轮询失败不打断创建请求本身。
			} finally {
				trustPollInFlight = false;
			}
		}, 1500);
	}

	async function createAgentAndOpen(body) {
		if (!projectId || creating) return;
		creating = true;
		const requestEpoch = epoch;
		const requestProject = projectId;
		newSessionButton.disabled = true;
		watchTrustDuringCreate(requestEpoch);
		try {
			// 主进程可能等待项目信任确认（最长 60s），10s 默认超时会误报失败。
			const data = await api("/api/agents", {
				method: "POST",
				timeout: 120000,
				body: JSON.stringify({ projectId, ...body }),
			});
			// 创建已返回，不再需要信任轮询；避免迟到的响应在聊天页再弹一次确认。
			stopTrustWatch();
			if (data?.agent?.id) {
				const index = appState.agents.findIndex((agent) => agent.id === data.agent.id);
				if (index === -1) appState.agents.push(data.agent);
				else appState.agents[index] = data.agent;
				// 创建期间用户可能返回首页或切到设置；不要再用迟到的响应抢走界面。
				if (requestEpoch !== epoch) {
					// 只是首页刷新推进了 epoch 时，用户仍停在原项目首页：把新会话画出来，
					// 否则要等下一次刷新才能看到“已创建”的会话。
					if (currentTab === "home" && !activeAgentId && projectId === requestProject) {
						renderHome();
					}
					toast("会话已创建，可在首页打开");
					return;
				}
				await openAgent(data.agent.id);
			}
		} catch (error) {
			// 用户已经离开创建前的页面时，401/500 不应再把界面切回令牌页或覆盖新会话。
			if (requestEpoch === epoch) handleError(error);
			else toast(error?.message || "创建会话失败");
		} finally {
			stopTrustWatch();
			if (trustSheetOpen) {
				trustSheetOpen = false;
				closeSheet();
			}
			creating = false;
			newSessionButton.disabled = false;
		}
	}

	async function openSession(filePath) {
		const session = sessions.find((item) => item.filePath === filePath);
		if (!session || creating) return;
		const existing = appState.agents.find(
			(agent) => agent.projectId === projectId && agent.sessionPath === filePath && agent.status !== "closed",
		);
		if (existing) {
			// 已打开的 agent 标题可能是自动生成的；历史会话列表里的名字更准确。
			await openAgent(existing.id, { title: sessionTitle(session) });
			return;
		}
		await createAgentAndOpen({ sessionPath: filePath, title: sessionTitle(session) });
	}

	async function newSession() {
		if (!projectId) {
			toast("没有可用项目");
			return;
		}
		await createAgentAndOpen({ title: "手机会话" });
	}

	function agentFromState(id) {
		return appState.agents.find((agent) => agent.id === id) || null;
	}

	/** 异步响应落地前统一检查 epoch + agent，避免切会话后旧请求覆盖新界面。 */
	function isCurrentRequest(requestEpoch, requestAgentId) {
		return stateApi.shouldAcceptResponse({
			requestEpoch,
			currentEpoch: epoch,
			requestAgentId,
			currentAgentId: activeAgentId,
		});
	}

	async function openAgent(id, options = {}) {
		stopPolling();
		resetChatEpoch();
		const requestEpoch = epoch;
		currentTab = "chat";
		activeAgentId = id;
		activeAgent = agentFromState(id);
		if (activeAgent && options.title) activeAgent.title = options.title;
		olderMessages = [];
		nextCursor = null;
		lastStatus = "";
		chatMessages = [];
		currentRuntime = {};
		lastMessageId = "";
		messageVersion = "";
		// 发送状态属于当前会话；切走时旧 prompt 可能仍在等 RPC，但不能让新会话的发送按钮一直禁用。
		sending = false;
		imageBusy = false;
		agentRunning = false;
		pendingImages = [];
		renderAttachments();
		updateComposerState();
		stopButton.hidden = true;
		setHeader(activeAgent?.title || "会话", statusLabel(activeAgent), { back: true, composer: true });
		setConnection("connecting");
		view.innerHTML = `
			<div class="chat-tools">
				<button class="tool" id="model-btn" type="button">模型 <b id="model-name">…</b></button>
				<button class="tool" id="thinking-btn" type="button">思考 <b id="thinking-level">…</b></button>
			</div>
			<button class="load-older" id="load-older" type="button" hidden>加载更早消息</button>
			<div id="messages" aria-live="polite" aria-busy="true"></div>
			<button class="new-messages" id="new-messages" type="button" hidden></button>`;
		animateView();
		$("model-btn").addEventListener("click", () => void openModelSheet());
		$("thinking-btn").addEventListener("click", () => void openThinkingSheet());
		$("load-older").addEventListener("click", loadOlder);
		$("new-messages").addEventListener("click", () => {
			view.scrollTop = view.scrollHeight;
			newMessageCount = 0;
			updateNewMessagesButton();
		});
		$("messages").addEventListener("click", (event) => {
			const copyButton = event.target.closest("[data-copy-code]");
			if (copyButton) {
				void copyCode(copyButton);
				return;
			}
			const toolButton = event.target.closest("[data-tool-id]");
			if (toolButton) {
				void openToolSheet(toolButton.dataset.toolId);
				return;
			}
			const button = event.target.closest("[data-expand]");
			if (button) void expandMessage(button.dataset.expand);
		});
		restoreDraft();
		await refreshChat({ initial: true, epoch: requestEpoch });
	}

	function stopPolling() {
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
	}

	function schedulePoll(delay) {
		stopPolling();
		if (delay === null || delay === undefined || !activeAgentId || currentTab !== "chat") return;
		pollTimer = setTimeout(() => {
			pollTimer = null;
			if (!document.hidden && activeAgentId) void refreshChat();
		}, delay);
	}

	async function refreshChat(options = {}) {
		if (!activeAgentId) return;
		// 旧版主进程没有 tail 参数时，新会话（还没有 session 文件）只能全量拉消息；
		// 不要每 3s 拉一次，等用户手动刷新或主进程更新后再轮询。
		if (supportsTail === false && !activeAgent?.sessionPath && !options.initial) return;
		if (pollInFlight) {
			refreshQueued = true;
			return;
		}
		pollInFlight = true;
		const requestId = ++pollRequestId;
		const requestEpoch = options.epoch ?? epoch;
		const requestAgentId = activeAgentId;
		// 首屏只等 messages/runtime；history-page 在历史会话上可能读文件，放并行后
		// 首屏先渲染，游标返回再显示“加载更早”，不再多等一个 RTT。
		const historyPromise = options.initial
			? fetchLatestHistoryCursor(requestEpoch, requestAgentId)
			: null;
		let running = false;
		const previousHeight = view.scrollHeight;
		const previousTop = view.scrollTop;
		const nearBottom = stateApi.isNearBottom({
			scrollHeight: previousHeight,
			scrollTop: previousTop,
			clientHeight: view.clientHeight,
		});
		try {
			const runtimePromise = api(`/api/agents/${encodeURIComponent(requestAgentId)}/runtime`).catch(
				() => null,
			);
			const messagesPromise = (async () => {
				// 旧版主进程没有 tail 参数；历史会话退回 history-page，避免每 3s 拉整段消息。
				if (supportsTail === false && activeAgent?.sessionPath) {
					const page = await api(
						`/api/agents/${encodeURIComponent(requestAgentId)}/history-page?limit=40&compact=1`,
					);
					return { messages: Array.isArray(page?.messages) ? page.messages : [], legacy: true };
				}
				const length = Math.max(1, stateApi.tailLength(chatMessages));
				const afterId = options.initial ? "" : lastMessageId;
				const query = new URLSearchParams({
					tail: String(TAIL_LIMIT),
					length: String(Math.min(200, length)),
					compact: "1",
				});
				if (afterId) query.set("afterId", afterId);
				if (messageVersion) query.set("version", messageVersion);
				const data = await api(
					`/api/agents/${encodeURIComponent(requestAgentId)}/messages?${query.toString()}`,
				);
				supportsTail = Boolean(data && Object.prototype.hasOwnProperty.call(data, "tail"));
				return data;
			})();
			const [messagesData, runtimeData] = await Promise.all([messagesPromise, runtimePromise]);
			if (!isCurrentRequest(requestEpoch, requestAgentId)) {
				return;
			}
			const list = Array.isArray(messagesData?.messages) ? messagesData.messages : [];
			const reset = Boolean(messagesData?.reset) || Boolean(messagesData?.legacy);
			const limit = Number(messagesData?.tail) || TAIL_LIMIT;
			const newCount = reset ? 0 : stateApi.countNewMessages(chatMessages, list);
			chatMessages = stateApi.appendTail(chatMessages, list, { reset, limit });
			chatMessages = stateApi.removeAcknowledgedOptimistic(chatMessages, list);
			lastMessageId = stateApi.lastRealMessageId(chatMessages) || lastMessageId;
			messageVersion = messagesData?.version || messageVersion;
			const runtime = runtimeData?.state || {};
			currentRuntime = runtime;
			// runtime 接口失败时用 state 里的 agent 状态兜底，避免正在运行的会话丢掉停止按钮。
			const status = runtime.isStreaming
				? "running"
				: runtime.status || activeAgent?.status || "idle";
			running = status === "running";
			if (activeAgent) activeAgent.status = status;
			const model = runtime.modelName || runtime.modelId || "";
			const subtitle = [statusLabel({ status }), model].filter(Boolean).join(" · ");
			if (subtitle !== lastStatus) {
				lastStatus = subtitle;
				const subtitleEl = $("subtitle");
				if (subtitleEl) subtitleEl.textContent = subtitle;
			}
			const modelName = $("model-name");
			if (modelName) modelName.textContent = model || "默认";
			const thinkingName = $("thinking-level");
			if (thinkingName) thinkingName.textContent = thinkingLabel(runtime.thinkingLevel);
			stopButton.hidden = !running;
			agentRunning = running;
			updateComposerState();
			if (!isCurrentRequest(requestEpoch, requestAgentId)) {
				return;
			}
			setConnection("online");
			// 长工具执行期间服务端会返回 unchanged/空 messages；此时时间线没有任何
			// 变化，重建 items、查询 details 和写滚动位置都是白工。初始渲染和
			// reset（窗口/会话重建）仍必须走一次完整渲染。
			if (options.initial || reset || list.length > 0) {
				renderMessages({
					mode: options.initial ? "initial" : options.keepBottom ? "preserve" : "auto",
					previousHeight,
					previousTop,
					nearBottom,
					newCount,
				});
			}
			if (historyPromise) {
				void historyPromise.then((page) => {
					if (!page || !isCurrentRequest(requestEpoch, requestAgentId)) return;
					// history-page 可能比 messages 晚返回。若它带回更早的历史，必须补一次
					// preserve 渲染，否则首屏只显示运行态消息，历史要等下一轮轮询才出现。
					// 空页不覆盖已加载的 olderMessages（手动刷新时不能把翻过的历史清空）。
					const nextOlder =
						Array.isArray(page.messages) && page.messages.length > 0
							? page.messages
							: olderMessages;
					const changed = nextOlder !== olderMessages;
					olderMessages = nextOlder;
					nextCursor = page.nextCursor || null;
					const loadOlderButton = $("load-older");
					if (loadOlderButton) loadOlderButton.hidden = !nextCursor;
					if (changed) {
						const previousHeight = view.scrollHeight;
						const previousTop = view.scrollTop;
						renderMessages({ mode: "preserve", previousHeight, previousTop });
					}
				});
			}
		} catch (error) {
			if (error?.status === 401) {
				handleError(error);
			} else if (isCurrentRequest(requestEpoch, requestAgentId)) {
				const messagesEl = $("messages");
				if (messagesEl) messagesEl.setAttribute("aria-busy", "false");
				setConnection("offline");
				if (options.initial) toast(error?.message || "加载消息失败");
			}
		} finally {
			// 切换会话后旧轮询可能才结束；它不能把新会话的 pollInFlight 清掉。
			if (requestId === pollRequestId) {
				pollInFlight = false;
				if (refreshQueued) {
					refreshQueued = false;
					schedulePoll(0);
				} else {
					schedulePoll(stateApi.pollDelay({ running, hidden: document.hidden }));
				}
			}
		}
	}

	async function fetchLatestHistoryCursor(requestEpoch, requestAgentId) {
		try {
			const page = await api(
				`/api/agents/${encodeURIComponent(requestAgentId)}/history-page?limit=40&compact=1`,
			);
			if (!isCurrentRequest(requestEpoch, requestAgentId)) {
				return null;
			}
			return page || null;
		} catch {
			// 新会话还没有 session 文件时 history-page 会返回空；消息接口仍可用。
			return null;
		}
	}

	async function loadOlder() {
		if (!activeAgentId) return;
		const requestEpoch = epoch;
		const requestAgentId = activeAgentId;
		const previousHeight = view.scrollHeight;
		const previousTop = view.scrollTop;
		try {
			let page;
			if (nextCursor) {
				page = await api(
					`/api/agents/${encodeURIComponent(requestAgentId)}/history-page?before=${encodeURIComponent(nextCursor)}&limit=40&compact=1`,
				);
			} else {
				page = await api(
					`/api/agents/${encodeURIComponent(requestAgentId)}/history-page?limit=40&compact=1`,
				);
			}
			if (!isCurrentRequest(requestEpoch, requestAgentId)) {
				return;
			}
			const list = Array.isArray(page?.messages) ? page.messages : [];
			olderMessages = stateApi.mergeOlder(olderMessages, list);
			nextCursor = page?.nextCursor || null;
			renderMessages({
				mode: "preserve",
				previousHeight,
				previousTop,
				nearBottom: false,
				newCount: 0,
			});
		} catch (error) {
			if (isCurrentRequest(requestEpoch, requestAgentId)) handleError(error);
		}
	}

	function mergedMessages() {
		// 旧版 Service Worker/浏览器缓存可能只更新了 mobile.js 而没更新 mobile-state.js；
		// 缺少 mergeTimeline 时退回按 id 合并，至少不让整个会话白屏。
		if (typeof stateApi.mergeTimeline === "function") {
			return stateApi.mergeTimeline(olderMessages, chatMessages);
		}
		return stateApi.mergeMessageLists(olderMessages, chatMessages);
	}

	function renderInline(value) {
		// 先把行内代码抽成占位符，避免 ** 等标记在代码内容里被误解析。
		const codes = [];
		let text = String(value ?? "").replace(/`([^`\n]+)`/g, (_, code) => {
			const token = `\u0000${codes.length}\u0000`;
			codes.push(`<code>${escapeHtml(code)}</code>`);
			return token;
		});
		text = escapeHtml(text)
			.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
			.replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
			.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
			.replace(
				/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
				'<a href="$2" target="_blank" rel="noreferrer">$1</a>',
			);
		return text.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)] || "");
	}

	function isTableSeparator(line) {
		return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
	}

	function splitTableRow(line) {
		return line
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());
	}

	function renderCodeBlock(code, language) {
		const label = language ? escapeHtml(language) : "代码";
		return `<div class="code-block"><div class="code-head"><span>${label}</span><button class="code-copy" type="button" data-copy-code>复制</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
	}

	function renderMarkdown(value) {
		const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
		const output = [];
		let paragraph = [];
		let list = null;

		const flushParagraph = () => {
			if (!paragraph.length) return;
			output.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
			paragraph = [];
		};
		const flushList = () => {
			if (!list) return;
			const tag = list.type === "ol" ? "ol" : "ul";
			const start = list.type === "ol" && list.start > 1 ? ` start="${list.start}"` : "";
			output.push(
				`<${tag}${start}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`,
			);
			list = null;
		};
		const flushBlocks = () => {
			flushParagraph();
			flushList();
		};

		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			const fence = /^\s*```\s*([^\s`]*)\s*$/.exec(line);
			if (fence) {
				flushBlocks();
				const code = [];
				index += 1;
				while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
					code.push(lines[index]);
					index += 1;
				}
				output.push(renderCodeBlock(code.join("\n"), fence[1]));
				continue;
			}
			if (!line.trim()) {
				flushBlocks();
				continue;
			}
			if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
				flushBlocks();
				const headers = splitTableRow(line);
				const rows = [];
				index += 2;
				while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
					rows.push(splitTableRow(lines[index]));
					index += 1;
				}
				index -= 1;
				output.push(
					`<div class="md-table-wrap"><table class="md-table"><thead><tr>${headers
						.map((cell) => `<th>${renderInline(cell)}</th>`)
						.join("")}</tr></thead><tbody>${rows
						.map(
							(row) =>
								`<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`,
						)
						.join("")}</tbody></table></div>`,
				);
				continue;
			}
			const heading = /^(#{1,4})\s+(.*)$/.exec(line);
			if (heading) {
				flushBlocks();
				const level = heading[1].length;
				output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
				continue;
			}
			if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
				flushBlocks();
				output.push("<hr />");
				continue;
			}
			const quote = /^>\s?(.*)$/.exec(line);
			if (quote) {
				flushBlocks();
				const quoteLines = [quote[1]];
				while (index + 1 < lines.length) {
					const next = /^>\s?(.*)$/.exec(lines[index + 1]);
					if (!next) break;
					quoteLines.push(next[1]);
					index += 1;
				}
				output.push(`<blockquote>${quoteLines.map(renderInline).join("<br>")}</blockquote>`);
				continue;
			}
			const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
			if (bullet) {
				flushParagraph();
				if (!list || list.type !== "ul") {
					flushList();
					list = { type: "ul", items: [] };
				}
				list.items.push(bullet[1]);
				continue;
			}
			const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
			if (numbered) {
				flushParagraph();
				if (!list || list.type !== "ol") {
					flushList();
					list = { type: "ol", items: [], start: Number(numbered[1]) || 1 };
				}
				list.items.push(numbered[2]);
				continue;
			}
			paragraph.push(line);
		}
		flushBlocks();
		return output.join("");
	}

	function renderText(text) {
		return `<div class="md-body">${renderMarkdown(text)}</div>`;
	}

	/** 历史消息里 text 可能带 <thinking> 标签，同时另有 thinking 字段；展示时只保留正文。 */
	function splitThinking(text, thinking) {
		const raw = String(text || "").trim();
		let found = typeof thinking === "string" ? thinking.trim() : "";
		let body = raw;
		// pi 的思考块包在整条消息最外层；思考内容本身可能包含字面量 <thinking>，
		// 所以从开头匹配到最后一个 </thinking>，不能使用非贪婪匹配。
		if (/^<thinking\b/i.test(raw)) {
			const end = raw.lastIndexOf("</thinking>");
			if (end !== -1) {
				if (!found) found = raw.slice(0, end).replace(/^<thinking\b[^>]*>/i, "").trim();
				body = raw.slice(end + "</thinking>".length).trim();
			} else {
				body = raw.replace(/^<thinking\b[^>]*>/i, "").trim();
			}
		} else {
			body = raw
				.replace(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi, (_, inner) => {
					if (!found) found = inner.trim();
					return "";
				})
				.trim();
		}
		return { body, thinking: found };
	}

	function toolNameLabel(name) {
		const names = {
			read: "读取",
			read_file: "读取",
			bash: "命令",
			eval: "执行",
			write: "写入",
			write_file: "写入",
			edit: "编辑",
			edit_file: "编辑",
			apply_patch: "补丁",
			glob: "查找",
			grep: "搜索",
			list_dir: "目录",
			task: "子任务",
			wait: "等待",
			todo: "任务",
			todo_write: "任务",
			web_search: "搜索网页",
			web_fetch: "网页",
			lsp: "分析",
			ask: "询问",
			ask_question: "提问",
		};
		return names[name] || name || "工具";
	}

	function toolLabel(text) {
		return String(text || "").replace(
			/^([✓✗▶])\s*([A-Za-z_][\w-]*)/,
			(_, mark, name) => `${mark} ${toolNameLabel(name)}`,
		);
	}

	function durationText(value) {
		const ms = Number(value);
		if (!Number.isFinite(ms) || ms <= 0) return "";
		return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	function shortText(value, max = 120) {
		const text = String(value ?? "").replace(/\s+/g, " ").trim();
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	}

	/** 工具卡片副标题：服务端 compact 时已用 shared/sessionDisplayContract 算好
	 *  meta.summary（参数键优先级唯一实现）；这里只保留 detailText / result 兜底，
	 *  避免手机端再维护一份参数键表。 */
	function toolSummary(meta) {
		if (typeof meta.summary === "string" && meta.summary) return meta.summary;
		const detailLine = String(meta.detailText || "")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line && !/^(工具|状态|参数|结果|详情)：/.test(line));
		if (detailLine) return shortText(detailLine);
		return shortText(meta.result);
	}

	function messageMeta(item, options = {}) {
		const parts = [];
		if (options.agent) parts.push('<span class="meta-agent">omp</span>');
		const time = timeText(item.timestamp);
		if (time) parts.push(`<time>${escapeHtml(time)}</time>`);
		if (item.optimistic) parts.push('<span class="meta-pending">发送中…</span>');
		if (item.delivery) parts.push(`<span class="meta-delivery">${escapeHtml(item.delivery)}</span>`);
		if (item.duration) parts.push(`<span>${escapeHtml(item.duration)}</span>`);
		return parts.length ? `<div class="msg-meta">${parts.join("")}</div>` : "";
	}

	// 轮询会反复拿到同一批消息对象（appendTail 对未变化的消息保留原引用）。
	// Markdown/思考块解析是手机端最贵的纯计算，按对象缓存 view 与最终 HTML，
	// 让未变化的消息在每轮轮询里只做一次 Map 查找。
	const messageViewCache = new WeakMap();
	const messageHtmlCache = new WeakMap();

	function messageView(message) {
		const cached = messageViewCache.get(message);
		if (cached !== undefined) return cached;
		const built = buildMessageView(message);
		messageViewCache.set(message, built);
		return built;
	}

	function buildMessageView(message) {
		const role = message.role || "assistant";
		const label = role === "system" ? "系统" : role === "error" ? "错误" : "助手";
		const images = Array.isArray(message.images)
			? message.images
					.map(
						(image) =>
							`<img src="data:${escapeHtml(image.mimeType)};base64,${escapeHtml(image.data)}" alt="" loading="lazy" decoding="async" />`,
					)
					.join("")
			: "";
		const { body, thinking } = splitThinking(message.text, message.thinking);
		const thinkingOnly = !body && !!thinking;
		const thinkingPreview = shortText(thinking, 48);
		const thinkingBlock = thinking
			? `<details data-detail="thinking"><summary>思考过程${thinkingPreview ? ` · ${escapeHtml(thinkingPreview)}` : ""}</summary><div class="thinking-body">${renderText(thinking)}</div></details>`
			: "";
		const meta = message.meta || {};
		const toolMatch = /^([✓✗▶])\s*([^\s]+)/.exec(String(body || ""));
		const toolName = toolNameLabel(String(meta.toolName || toolMatch?.[2] || "工具"));
		const toolError =
			meta.isError === true || meta.status === "error" || toolMatch?.[1] === "✗";
		const toolStatus =
			meta.status === "running" || toolMatch?.[1] === "▶" ? "▶" : toolError ? "✗" : "✓";
		const duration = durationText(meta.durationMs);
		// 语义值（follow-up / steer）由服务端按共享契约写入 meta.delivery；
		// 手机端只做中文文案，不再解析 streamingBehavior 原始值。
		const delivery =
			meta.delivery === "follow-up"
				? "排队到下一轮"
				: meta.delivery === "steer"
					? "已加入当前回合"
					: "";
		const toolDetail = role === "tool" ? toolSummary(meta) : "";
		const text = role === "tool" ? toolLabel(body) : body;
		const textRemaining = Number.isFinite(Number(meta.fullLength))
			? Number(meta.fullLength) - String(body || "").length
			: 0;
		const thinkingRemaining = Number.isFinite(Number(meta.fullThinkingLength))
			? Number(meta.fullThinkingLength) - String(thinking || "").length
			: 0;
		const expand = meta.hasMore || meta.thinkingHasMore
			? {
					label:
						meta.hasMore && meta.thinkingHasMore
							? "展开全文"
							: meta.hasMore
								? "展开工具输出"
								: "展开思考",
					remaining: Math.max(0, textRemaining, thinkingRemaining),
				}
			: null;
		return {
			id: message.id,
			role,
			label,
			images,
			body,
			thinking,
			thinkingOnly,
			text,
			thinkingBlock,
			expand,
			timestamp: message.timestamp,
			duration,
			toolName,
			toolDetail,
			toolError,
			toolStatus,
			delivery,
			optimistic: Boolean(message.optimistic),
		};
	}

	function renderMessage(item) {
		const cached = messageHtmlCache.get(item);
		if (cached !== undefined) return cached;
		const html = buildMessageHtml(item);
		messageHtmlCache.set(item, html);
		return html;
	}

	function buildMessageHtml(item) {
		const expand = item.expand
			? `<button class="expand" type="button" data-expand="${escapeHtml(item.id)}">${escapeHtml(item.expand.label)}${item.expand.remaining ? ` · 还有 ${item.expand.remaining} 字` : ""}</button>`
			: "";
		const attrs = `data-mid="${escapeHtml(item.id)}"`;
		if (item.role === "user") {
			return `<div class="msg user" ${attrs}>${escapeHtml(item.body)}${expand}${item.images}${messageMeta(item)}</div>`;
		}
		if (item.role === "tool") {
			const detail = item.toolDetail
				? `<span class="tool-detail">${escapeHtml(item.toolDetail)}</span>`
				: "";
			const toolState = item.toolError ? "失败" : item.toolStatus === "▶" ? "运行中" : "完成";
			const toolAriaLabel = `${item.toolName}，${toolState}${item.toolDetail ? `，${item.toolDetail}` : ""}`;
			return `<button class="msg tool${item.toolError ? " tool-error" : ""}" type="button" ${attrs} data-tool-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(toolAriaLabel)}"><span class="tool-status" aria-hidden="true">${escapeHtml(item.toolStatus)}</span><span class="tool-main"><span class="tool-name">${escapeHtml(item.toolName)}</span>${detail}</span>${item.duration ? `<span class="tool-duration">${escapeHtml(item.duration)}</span>` : ""}</button>`;
		}
		const label =
			item.role === "system" || item.role === "error"
				? `<span class="role">${escapeHtml(item.label)}</span>`
				: "";
		const meta = item.role === "assistant" ? messageMeta(item, { agent: true }) : "";
		const body = item.text ? renderText(item.text) : "";
		return `<div class="msg ${escapeHtml(item.role)}${item.thinkingOnly ? " thinking-only" : ""}" ${attrs}>${label}${meta}${item.thinkingBlock}${body}${expand}${item.images}</div>`;
	}

	function buildRenderItems() {
		// 只保留有正文的助手消息；连续工具调用折叠成过程，避免手机端时间线被
		// 大量英文思考和工具行淹没。纯思考消息仍保留，交给 details 折叠。
		const messages = mergedMessages()
			.map(messageView)
			.filter((item) => !(item.role === "assistant" && !item.body && !item.images && !item.thinking));
		const items = [];
		for (let index = 0; index < messages.length; index += 1) {
			const item = messages[index];
			if (item.role === "tool") {
				const group = [item];
				while (index + 1 < messages.length && messages[index + 1].role === "tool") {
					index += 1;
					group.push(messages[index]);
				}
				if (group.length > 1) {
					// 执行过程默认展开：手机端最需要看到 agent 实际跑了哪些命令，
					// 折叠起来只剩“工具 · N 次”，等于把过程信息全部藏掉。
					const running = group.some((entry) => entry.toolStatus === "▶");
					const failed = group.some((entry) => entry.toolError);
					const state = running ? "运行中" : failed ? "有失败" : "完成";
					items.push({
						key: `group:${group[0].id}`,
						html: `<div class="tool-group"><div class="tool-group-title"><span>执行过程 · ${group.length} 步</span><span class="tool-group-state${running ? " running" : failed ? " error" : ""}">${state}</span></div>${group
							.map(renderMessage)
							.join("")}</div>`,
					});
				} else {
					items.push({ key: item.id, html: renderMessage(item) });
				}
				continue;
			}
			items.push({ key: item.id, html: renderMessage(item) });
		}
		return items;
	}

	function createMessageNode(item) {
		const template = document.createElement("template");
		template.innerHTML = item.html.trim();
		const node = template.content.firstElementChild;
		if (!node) return null;
		node.dataset.key = item.key;
		node.__html = item.html;
		return node;
	}

	function detailOwner(details) {
		// 工具过程组没有 data-mid，用 data-key 区分；否则多个组的详情会共用 ":0"。
		const node = details.closest("[data-mid], [data-key]");
		return node?.dataset.mid || node?.dataset.key || "";
	}

	/**
	 * 记录/恢复展开的 details。旧实现每个 details 都 querySelectorAll 一次兄弟节点，
	 * 工具组多时会退化成平方级查询；这里一次遍历并按父节点计数，保持原有
	 * “owner:父节点内序号”键不变。
	 */
	function detailIndex(details, seen) {
		const parent = details.parentElement;
		const index = seen.get(parent) || 0;
		seen.set(parent, index + 1);
		return `${detailOwner(details)}:${index}`;
	}

	function openDetailKeys(container) {
		const keys = new Set();
		const seen = new Map();
		container.querySelectorAll("details").forEach((details) => {
			const key = detailIndex(details, seen);
			if (details.open) keys.add(key);
		});
		return keys;
	}

	function restoreOpenDetails(container, keys) {
		if (!keys.size) return;
		const seen = new Map();
		container.querySelectorAll("details").forEach((details) => {
			if (keys.has(detailIndex(details, seen))) details.open = true;
		});
	}

	function updateNewMessagesButton() {
		const button = $("new-messages");
		if (!button) return;
		button.hidden = newMessageCount <= 0;
		button.textContent = newMessageCount > 0 ? `${newMessageCount} 条新消息` : "";
	}

	function renderMessages(options = {}) {
		const container = $("messages");
		if (!container) return;
		const items = buildRenderItems();
		const loadOlderButton = $("load-older");
		if (loadOlderButton) loadOlderButton.hidden = !nextCursor;
		// 轮询请求可能在用户滑动期间才返回。若沿用请求发起时的 scrollTop，
		// 渲染完会把用户刚滑到的位置硬拉回去；这里在真正改 DOM 前重新取实时位置。
		const liveHeight = view.scrollHeight;
		const liveTop = view.scrollTop;
		const liveNearBottom = stateApi.isNearBottom({
			scrollHeight: liveHeight,
			scrollTop: liveTop,
			clientHeight: view.clientHeight,
		});
		const preserveMode = options.mode === "preserve";
		const requestedTop = Number(options.previousTop);
		const requestedHeight = Number(options.previousHeight);
		// preserve 用于“在顶部插入更早消息/展开详情”，必须加上高度差；
		// 但如果用户已经在请求期间滚走，就改用当前视口，避免再次拉回。
		const keepRequestedAnchor =
			preserveMode &&
			Number.isFinite(requestedTop) &&
			Number.isFinite(requestedHeight) &&
			Math.abs(liveTop - requestedTop) <= 2;
		const previousHeight = keepRequestedAnchor ? requestedHeight : liveHeight;
		const previousTop = keepRequestedAnchor ? requestedTop : liveTop;
		const openKeys = openDetailKeys(container);
		const existing = Array.from(container.children);
		const canPatch =
			options.mode !== "initial" &&
			existing.length > 0 &&
			existing.length <= items.length &&
			existing.every((node, index) => node.dataset.key === items[index].key);
		if (canPatch) {
			for (let index = existing.length; index < items.length; index += 1) {
				const node = createMessageNode(items[index]);
				if (node) container.append(node);
			}
			for (let index = 0; index < existing.length; index += 1) {
				if (existing[index].__html === items[index].html) continue;
				const node = createMessageNode(items[index]);
				if (node) existing[index].replaceWith(node);
			}
		} else {
			const nodes = items.map(createMessageNode).filter(Boolean);
			container.replaceChildren(...nodes);
		}
		restoreOpenDetails(container, openKeys);
		container.setAttribute("aria-busy", "false");
		const mode = options.mode || "auto";
		const plan = stateApi.scrollPlan({
			mode,
			// 轮询传入的 nearBottom 是请求发起时的快照；用户可能已经滑走，
			// 因此 auto 模式用渲染时的实时位置重新判断是否贴底。
			nearBottom: mode === "auto" ? liveNearBottom : options.nearBottom,
			previousHeight,
			previousTop,
			scrollHeight: view.scrollHeight,
			newCount: options.newCount,
		});
		// 值没变时不要写 scrollTop：移动端在惯性滑动中重复赋值会打断滚动。
		if (Math.abs(view.scrollTop - plan.scrollTop) > 1) {
			view.scrollTop = plan.scrollTop;
		}
		if (mode === "initial" || (mode === "auto" && liveNearBottom)) {
			newMessageCount = 0;
		} else if (plan.showNewMessages) {
			newMessageCount += Number(options.newCount) || 0;
		}
		updateNewMessagesButton();
	}

	async function copyText(text) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// 局域网 http 不是 secure context，clipboard API 可能不可用。
			const area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.append(area);
			area.select();
			let ok = false;
			try {
				ok = document.execCommand("copy");
			} catch {
				ok = false;
			}
			area.remove();
			return ok;
		}
	}

	async function copyCode(button) {
		const code = button.closest(".code-block")?.querySelector("pre code");
		if (!code) return;
		const ok = await copyText(code.textContent || "");
		toast(ok ? "代码已复制" : "复制失败");
		if (!ok) return;
		const previous = button.textContent;
		button.textContent = "已复制";
		setTimeout(() => {
			if (button.isConnected) button.textContent = previous;
		}, 1200);
	}

	async function expandMessage(messageId) {
		if (!activeAgentId || !messageId) return;
		const requestAgentId = activeAgentId;
		const requestEpoch = epoch;
		try {
			const data = await api(
				`/api/agents/${encodeURIComponent(requestAgentId)}/messages/${encodeURIComponent(messageId)}`,
			);
			if (!isCurrentRequest(requestEpoch, requestAgentId)) {
				return;
			}
			const full = data?.message;
			if (!full) return;
			for (const list of [chatMessages, olderMessages]) {
				const index = list.findIndex((message) => message.id === messageId);
				if (index !== -1) list[index] = full;
			}
			const previousHeight = view.scrollHeight;
			const previousTop = view.scrollTop;
			renderMessages({ mode: "preserve", previousHeight, previousTop });
		} catch (error) {
			if (isCurrentRequest(requestEpoch, requestAgentId)) handleError(error);
		}
	}

	function prettyToolArgs(value) {
		if (value === undefined || value === null || value === "") return "";
		if (typeof value !== "string") {
			try {
				return JSON.stringify(value, null, 2);
			} catch {
				return String(value);
			}
		}
		try {
			return JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			// 历史消息里的 args 可能已经被截断，保留原文比显示“解析失败”有用。
			return value;
		}
	}

	function toolSheetHtml(message) {
		const meta = message.meta || {};
		const args = prettyToolArgs(meta.args);
		const result = meta.result == null ? "" : String(meta.result).trim();
		const detail = meta.detailText == null ? "" : String(meta.detailText).trim();
		const sections = [];
		if (args) {
			sections.push(
				`<div class="tool-section"><div class="tool-section-title">参数</div><pre class="tool-output">${escapeHtml(args)}</pre></div>`,
			);
		}
		if (result) {
			sections.push(
				`<div class="tool-section"><div class="tool-section-title">结果</div><pre class="tool-output">${escapeHtml(result)}</pre></div>`,
			);
		} else if (detail) {
			// 历史接口有时只返回 detailText；此时不要再把参数拼一遍。
			sections.push(
				`<div class="tool-section"><div class="tool-section-title">详情</div><pre class="tool-output">${escapeHtml(detail)}</pre></div>`,
			);
		}
		const truncated = meta.hasMore || meta.truncated;
		const loadMore = truncated
			? `<button class="sheet-action" type="button" data-load-tool="${escapeHtml(message.id)}">加载完整输出</button>`
			: "";
		return `<div class="tool-sheet">${sections.join("") || '<div class="empty">没有更多详情</div>'}${loadMore}</div>`;
	}

	function openToolSheet(messageId) {
		const message = mergedMessages().find((item) => item.id === messageId);
		if (!message) return;
		const info = messageView(message);
		const status =
			info.toolStatus === "▶" ? "运行中" : info.toolError ? "失败" : "完成";
		openSheet(`${info.toolName} · ${status}`, toolSheetHtml(message));
	}

	async function loadFullTool(messageId, button) {
		if (!activeAgentId || !messageId) return;
		const requestAgentId = activeAgentId;
		const requestEpoch = epoch;
		const previous = button.textContent;
		button.disabled = true;
		button.textContent = "加载中…";
		try {
			const message = mergedMessages().find((item) => item.id === messageId);
			const entryId = typeof message?.meta?.entryId === "string" ? message.meta.entryId : "";
			// 工具结果被截断时，全文缓存在主进程；历史消息没有运行时缓存，需要 entryId
			// 回到会话文件里定位。没有 entryId 也试一次，live 消息可能仍命中缓存。
			const query = entryId ? `?entryId=${encodeURIComponent(entryId)}` : "";
			const data = await api(
				`/api/agents/${encodeURIComponent(requestAgentId)}/messages/${encodeURIComponent(messageId)}/full-text${query}`,
			);
			if (!isCurrentRequest(requestEpoch, requestAgentId)) {
				button.disabled = false;
				button.textContent = previous;
				return;
			}
			if (typeof data?.text !== "string") throw new Error("没有获取到完整输出");
			for (const list of [chatMessages, olderMessages]) {
				const index = list.findIndex((item) => item.id === messageId);
				if (index === -1) continue;
				const target = list[index];
				list[index] = {
					...target,
					meta: {
						...(target.meta || {}),
						result: data.text,
						truncated: false,
						hasMore: false,
						fullLength: data.text.length,
					},
				};
			}
			const previousHeight = view.scrollHeight;
			const previousTop = view.scrollTop;
			renderMessages({ mode: "preserve", previousHeight, previousTop });
			openToolSheet(messageId);
		} catch (error) {
			button.disabled = false;
			button.textContent = previous;
			if (isCurrentRequest(requestEpoch, requestAgentId)) handleError(error);
		}
	}

	function openSheet(title, html) {
		sheetTitle.textContent = title;
		sheetBody.innerHTML = html;
		sheetBody.scrollTop = 0;
		sheetEl.hidden = false;
		document.body.classList.add("sheet-open");
	}

	function closeSheet() {
		sheetEl.hidden = true;
		document.body.classList.remove("sheet-open");
	}

	async function openModelSheet() {
		if (!activeAgentId) return;
		const agentId = activeAgentId;
		const requestEpoch = epoch;
		openSheet("选择模型", '<div class="empty">加载中…</div>');
		try {
			const data = await api(`/api/agents/${encodeURIComponent(agentId)}/models`);
			if (sheetEl.hidden || !isCurrentRequest(requestEpoch, agentId)) return;
			const models = Array.isArray(data?.models) ? data.models : [];
			if (!models.length) {
				sheetBody.innerHTML = '<div class="empty">没有可用模型</div>';
				return;
			}
			const currentProvider = currentRuntime.provider || "";
			const currentModelId = currentRuntime.modelId || "";
			sheetBody.innerHTML = models
				.map((model) => {
					const active = model.provider === currentProvider && model.id === currentModelId;
					return `<button class="sheet-row${active ? " active" : ""}" type="button" data-provider="${escapeHtml(model.provider)}" data-model="${escapeHtml(model.id)}">
						<span class="grow">
							<span class="name">${escapeHtml(model.name || model.id)}</span>
							<span class="meta">${escapeHtml(model.provider)}/${escapeHtml(model.id)}</span>
						</span>
						${active ? '<span class="check">✓</span>' : ""}
					</button>`;
				})
				.join("");
			sheetBody.querySelectorAll("[data-provider]").forEach((button) => {
				button.addEventListener("click", async () => {
					closeSheet();
					if (!isCurrentRequest(requestEpoch, agentId)) return;
					try {
						await api(`/api/agents/${encodeURIComponent(agentId)}/model`, {
							method: "POST",
							body: JSON.stringify({
								provider: button.dataset.provider,
								modelId: button.dataset.model,
							}),
						});
						if (!isCurrentRequest(requestEpoch, agentId)) return;
						toast("模型已切换");
						await refreshChat({ initial: true });
					} catch (error) {
						if (isCurrentRequest(requestEpoch, agentId)) handleError(error);
					}
				});
			});
		} catch (error) {
			if (sheetEl.hidden || !isCurrentRequest(requestEpoch, agentId)) return;
			if (error?.status === 401) {
				handleError(error);
				return;
			}
			sheetBody.innerHTML = `<div class="empty">${escapeHtml(error?.message || "加载模型失败")}</div>`;
		}
	}

	async function openThinkingSheet() {
		if (!activeAgentId) return;
		const agentId = activeAgentId;
		const requestEpoch = epoch;
		// 与桌面端 THINKING_LEVELS 对齐；pi 没有 "auto" 档位，传下去会被 RPC 拒绝。
		const levels = [
			["off", "关闭"],
			["minimal", "最小"],
			["low", "低"],
			["medium", "中"],
			["high", "高"],
			["xhigh", "很高"],
			["max", "最大"],
		];
		const current = currentRuntime.thinkingLevel || "";
		openSheet(
			"思考级别",
			levels
				.map(
					([level, label]) => `<button class="sheet-row${level === current ? " active" : ""}" type="button" data-level="${escapeHtml(level)}">
						<span class="grow"><span class="name">${escapeHtml(label)}</span><span class="meta">${escapeHtml(level)}</span></span>
						${level === current ? '<span class="check">✓</span>' : ""}
					</button>`,
				)
				.join(""),
		);
		sheetBody.querySelectorAll("[data-level]").forEach((button) => {
			button.addEventListener("click", async () => {
				closeSheet();
				if (!isCurrentRequest(requestEpoch, agentId)) return;
				try {
					await api(`/api/agents/${encodeURIComponent(agentId)}/thinking`, {
						method: "POST",
						body: JSON.stringify({ level: button.dataset.level }),
					});
					if (!isCurrentRequest(requestEpoch, agentId)) return;
					toast("思考级别已切换");
					await refreshChat({ initial: true });
				} catch (error) {
					if (isCurrentRequest(requestEpoch, agentId)) handleError(error);
				}
			});
		});
	}

	function draftKey(id) {
		return `omp-mobile-draft:${id}`;
	}

	function saveDraft() {
		if (!activeAgentId) return;
		try {
			if (input.value) localStorage.setItem(draftKey(activeAgentId), input.value);
			else localStorage.removeItem(draftKey(activeAgentId));
		} catch {
			// 隐私模式下 localStorage 可能抛错，草稿只是增强能力。
		}
	}

	function restoreDraft() {
		if (!activeAgentId) return;
		try {
			input.value = localStorage.getItem(draftKey(activeAgentId)) || "";
		} catch {
			input.value = "";
		}
		input.style.height = "auto";
		input.style.height = `${Math.min(132, input.scrollHeight)}px`;
	}

	function removeOptimistic(id) {
		chatMessages = chatMessages.filter((message) => message.id !== id);
	}

	async function sendPrompt(behaviorOverride) {
		const text = input.value.trim();
		const images = pendingImages.slice();
		if ((!text && images.length === 0) || !activeAgentId || sending || imageBusy) return;
		const agentId = activeAgentId;
		const requestEpoch = epoch;
		const behavior = agentRunning
			? behaviorOverride === "followUp"
				? "followUp"
				: "steer"
			: undefined;
		closeSendMenu();
		const optimisticId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const optimistic = {
			id: optimisticId,
			agentId,
			role: "user",
			text: text || "[图片]",
			timestamp: Date.now(),
			optimistic: true,
			...(images.length ? { images } : {}),
			...(behavior ? { meta: { streamingBehavior: behavior } } : {}),
		};
		sending = true;
		updateComposerState();
		const previousHeight = view.scrollHeight;
		const previousTop = view.scrollTop;
		chatMessages = stateApi.appendTail(chatMessages, [optimistic], { limit: TAIL_LIMIT });
		input.value = "";
		input.style.height = "auto";
		pendingImages = [];
		renderAttachments();
		saveDraft();
		renderMessages({ mode: "auto", nearBottom: true, previousHeight, previousTop, newCount: 0 });
		try {
			const data = await api(`/api/agents/${encodeURIComponent(agentId)}/prompt`, {
				method: "POST",
				// prompt RPC 可能跑满主进程 rpcTimeout；客户端超时中断无法证明服务端未受理。
				timeout: 0,
				body: JSON.stringify({
					message: text,
					...(images.length ? { images } : {}),
					...(behavior ? { streamingBehavior: behavior } : {}),
				}),
			});
			const result = data?.result;
			if (!result?.accepted) {
				if (!isCurrentRequest(requestEpoch, agentId)) return;
				removeOptimistic(optimisticId);
				if (!input.value) input.value = text;
				if (!pendingImages.length && images.length) {
					pendingImages = images;
					renderAttachments();
				}
				saveDraft();
				renderMessages({ mode: "preserve", previousHeight, previousTop });
				toast(result?.error || "发送失败");
				return;
			}
			if (behavior) toast(behavior === "followUp" ? "已排队到下一轮" : "已加入当前回合");
			if (isCurrentRequest(requestEpoch, agentId)) {
				// 已受理后刷新失败不能按发送失败回填输入框，否则会重复发送。
				await refreshChat({ initial: true }).catch(() => undefined);
			}
		} catch (error) {
			// 用户已经切走时，旧请求的失败不能写进新会话的输入框。
			if (isCurrentRequest(requestEpoch, agentId)) {
				removeOptimistic(optimisticId);
				if (!input.value) input.value = text;
				if (!pendingImages.length && images.length) {
					pendingImages = images;
					renderAttachments();
				}
				saveDraft();
				renderMessages({ mode: "preserve", previousHeight, previousTop });
				handleError(error);
			}
		} finally {
			// 旧会话的请求结束时不能解除新会话正在发送的禁用状态。
			if (isCurrentRequest(requestEpoch, agentId)) {
				sending = false;
				updateComposerState();
			}
		}
	}

	async function stopAgent() {
		if (!activeAgentId) return;
		const agentId = activeAgentId;
		const requestEpoch = epoch;
		stopButton.disabled = true;
		stopButton.textContent = "停止中…";
		try {
			// 只中止当前回合；/stop 会关闭 pi 进程和会话，不能用于聊天页停止。
			await api(`/api/agents/${encodeURIComponent(agentId)}/abort`, { method: "POST" });
			if (isCurrentRequest(requestEpoch, agentId)) {
				// 先本地收口停止按钮，避免 abort 已受理但下一次轮询还没回来时按钮仍可点。
				agentRunning = false;
				stopButton.hidden = true;
				updateComposerState();
				await refreshChat({ initial: true });
			}
		} catch (error) {
			if (isCurrentRequest(requestEpoch, agentId)) handleError(error);
		} finally {
			stopButton.disabled = false;
			stopButton.textContent = "停止";
		}
	}

	async function showHome() {
		// 先切回首页状态，避免返回后仍在跑的轮询把旧会话消息写进新页面。
		stopPolling();
		resetChatEpoch();
		const requestEpoch = epoch;
		currentTab = "home";
		activeAgentId = null;
		activeAgent = null;
		setConnection("connecting");
		// 刷新完成时用户可能已经点进某个会话或设置；只有仍停在首页才允许重绘，
		// 否则首页的迟到响应会把刚打开的聊天页顶掉。
		const isCurrentHome = () => requestEpoch === epoch && currentTab === "home" && !activeAgentId;
		// 先用缓存把首页画出来，弱网下返回不会停在旧聊天界面。
		setHeader(
			"OmpDeck",
			projectId ? `${projectName(projectId)} · ${sessions.length} 个会话` : "没有项目",
			{ tabs: true },
		);
		if (!sessions.length && projectId) sessions = cachedSessions(projectId);
		if (sessions.length || appState.projects.length) renderHome();
		else renderSkeleton();
		const pendingSessions = beginSessionsLoad();
		try {
			await refreshState();
			if (!isCurrentHome()) return;
			await finishSessionsLoad(pendingSessions);
			if (!isCurrentHome()) return;
			renderHome();
			setConnection("online");
		} catch (error) {
			if (!isCurrentHome()) return;
			if (error?.status === 401) {
				handleError(error);
				return;
			}
			if (!appState.projects.length) {
				renderFatal(error);
				setConnection("offline");
				return;
			}
			renderHome();
			setConnection("offline");
			toast(error?.message || "刷新失败");
		}
	}

	function renderSettings() {
		stopPolling();
		resetChatEpoch();
		currentTab = "settings";
		activeAgentId = null;
		activeAgent = null;
		animateView();
		setHeader("设置", "连接与令牌", { tabs: true });
		// 桌面版从同源 localStorage 读取令牌，不把令牌再拼进 URL，避免历史记录/分享泄露。
		if (token) storageSet("ompdeck.web.token", token);
		const desktopHref = "./index.html?desktop=1";
		view.innerHTML = `
			<div class="section-title">连接</div>
			<div class="card">
				<div class="row static">
					<span class="grow"><span class="name">服务地址</span><span class="meta">${escapeHtml(location.origin)}</span></span>
				</div>
				<div class="row static">
					<span class="grow"><span class="name">访问令牌</span><span class="meta">${token ? "已配置" : "未配置"}</span></span>
					<span class="badge">${token ? "已连接" : "未连接"}</span>
				</div>
			</div>
			<div class="section-title">访问令牌</div>
			<div class="card">
				<div class="settings-pad">
					<input id="settings-token" autocomplete="off" spellcheck="false" placeholder="omp_..." value="${escapeHtml(token)}" />
					<button id="save-token" class="primary" type="button">保存令牌</button>
				</div>
			</div>
			<div class="section-title">更多</div>
			<div class="card">
				<a class="row" href="${escapeHtml(desktopHref)}">
					<span class="grow"><span class="name">打开桌面版</span><span class="meta">功能完整，手机可能较慢</span></span>
					<span class="chev" aria-hidden="true">›</span>
				</a>
				<button class="row" id="refresh-all" type="button">
					<span class="grow"><span class="name">刷新连接</span><span class="meta">重新加载项目和会话</span></span>
				</button>
			</div>
			<div class="about">OmpDeck Mobile · 轻量手机界面</div>`;
		view.scrollTop = 0;
		view.setAttribute("aria-busy", "false");
		$("save-token").addEventListener("click", async () => {
			const value = $("settings-token").value.trim();
			if (!value) {
				token = "";
				pendingUrlToken = "";
				storageSet("omp-mobile-token", "");
				storageSet("ompdeck.web.token", "");
				renderTokenPrompt();
				return;
			}
			token = value;
			pendingUrlToken = "";
			storageSet("omp-mobile-token", token);
			toast("令牌已保存");
			await boot();
		});
		$("refresh-all").addEventListener("click", async () => {
			try {
				const pendingSessions = beginSessionsLoad();
				await refreshState();
				await finishSessionsLoad(pendingSessions);
				toast("已刷新");
				renderSettings();
			} catch (error) {
				handleError(error);
			}
		});
	}

	async function boot() {
		setHeader("OmpDeck", "连接中…", { tabs: false });
		setConnection("connecting");
		const requestEpoch = epoch;
		currentTab = "home";
		activeAgentId = null;
		activeAgent = null;
		// 缓存首页可能在刷新完成前就允许用户点进会话；只有仍停在首页才继续渲染/自动恢复。
		const isCurrentHome = () => requestEpoch === epoch && currentTab === "home" && !activeAgentId;
		const cached = projectId ? cachedSessions(projectId) : [];
		if (cached.length) {
			sessions = cached;
			renderHome();
		} else {
			renderSkeleton();
		}
		const pendingSessions = beginSessionsLoad();
		try {
			await refreshState();
			if (!isCurrentHome()) {
				pendingResumeAgentId = null;
				return;
			}
			await finishSessionsLoad(pendingSessions);
			if (!isCurrentHome()) {
				pendingResumeAgentId = null;
				return;
			}
			renderHome();
			setConnection("online");
			const pending = pendingResumeAgentId;
			pendingResumeAgentId = null;
			if (pending && appState.agents.some((agent) => agent.id === pending)) {
				await openAgent(pending);
			}
		} catch (error) {
			if (!isCurrentHome()) {
				pendingResumeAgentId = null;
				return;
			}
			if (error?.status === 401) {
				handleError(error);
				return;
			}
			// 有缓存/已知项目时先展示离线首页，别让断网直接吞掉可读的历史会话。
			if (sessions.length > 0 || appState.projects.length > 0) {
				renderHome();
				setConnection("offline");
				toast(error?.message || "刷新失败");
				return;
			}
			renderFatal(error);
			setConnection("offline");
		}
	}

	backButton.addEventListener("click", () => {
		if (activeAgentId) {
			void showHome();
			return;
		}
		renderHome();
	});
	refreshButton.addEventListener("click", async () => {
		if (activeAgentId) {
			await refreshChat({ initial: true });
			return;
		}
		if (currentTab === "settings") {
			try {
				const pendingSessions = beginSessionsLoad();
				await refreshState();
				await finishSessionsLoad(pendingSessions);
				toast("已刷新");
				renderSettings();
			} catch (error) {
				handleError(error);
			}
			return;
		}
		await showHome();
	});
	document.querySelectorAll("[data-tab]").forEach((button) => {
		button.addEventListener("click", () => {
			if (button.dataset.tab === "settings") {
				renderSettings();
				return;
			}
			void showHome();
		});
	});
	newSessionButton.addEventListener("click", () => void newSession());
	sendButton.addEventListener("click", () => void sendPrompt());
	stopButton.addEventListener("click", stopAgent);
	attachButton.addEventListener("click", () => imageInput.click());
	imageInput.addEventListener("change", () => {
		const files = Array.from(imageInput.files || []);
		imageInput.value = "";
		void addImages(files);
	});
	attachmentsEl.addEventListener("click", (event) => {
		const button = event.target.closest("[data-remove-image]");
		if (!button || sending || imageBusy) return;
		const index = Number(button.dataset.removeImage);
		if (!Number.isInteger(index) || index < 0 || index >= pendingImages.length) return;
		pendingImages.splice(index, 1);
		renderAttachments();
	});
	sendMoreButton.addEventListener("click", (event) => {
		event.stopPropagation();
		if (!agentRunning || sending || imageBusy) return;
		const open = sendMenu.hidden;
		sendMenu.hidden = !open;
		sendMoreButton.setAttribute("aria-expanded", String(open));
	});
	sendMenu.addEventListener("click", (event) => {
		const button = event.target.closest("[data-send-behavior]");
		if (!button) return;
		closeSendMenu();
		void sendPrompt(button.dataset.sendBehavior);
	});
	document.addEventListener("click", (event) => {
		if (!event.target.closest(".send-stack")) closeSendMenu();
	});
	input.addEventListener("input", () => {
		input.style.height = "auto";
		input.style.height = `${Math.min(132, input.scrollHeight)}px`;
		saveDraft();
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void sendPrompt();
		}
	});
	sheetBody.addEventListener("click", (event) => {
		const loadButton = event.target.closest("[data-load-tool]");
		if (loadButton) {
			void loadFullTool(loadButton.dataset.loadTool, loadButton);
			return;
		}
		if (event.target.closest("[data-close]")) closeSheet();
	});
	sheetEl.addEventListener("click", (event) => {
		if (event.target === sheetEl || event.target.closest("[data-close]")) closeSheet();
	});
	$("sheet-close").addEventListener("click", closeSheet);
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !sendMenu.hidden) {
			closeSendMenu();
			return;
		}
		if (event.key === "Escape" && !sheetEl.hidden) closeSheet();
	});
	$("connection").addEventListener("click", () => {
		if (activeAgentId) {
			void refreshChat({ initial: true });
		} else {
			void showHome();
		}
	});
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			stopPolling();
			return;
		}
		if (activeAgentId) void refreshChat();
	});
	view.addEventListener(
		"scroll",
		() => {
			// 首页滑到接近底部时自动放出下一批历史会话；列表较长时不必反复点按钮。
			if (
				currentTab === "home" &&
				!activeAgentId &&
				view.scrollTop + view.clientHeight >= view.scrollHeight - 160
			) {
				revealMoreSessions();
			}
			// 用户自己滑到底部时，新消息提示不应继续挂着。
			if (!newMessageCount) return;
			if (
				stateApi.isNearBottom({
					scrollHeight: view.scrollHeight,
					scrollTop: view.scrollTop,
					clientHeight: view.clientHeight,
				})
			) {
				newMessageCount = 0;
				updateNewMessagesButton();
			}
		},
		{ passive: true },
	);

	let lastViewportHeight = 0;
	let viewportSyncFrame = 0;
	function syncViewportHeight() {
		const height = Math.round(window.visualViewport?.height || window.innerHeight);
		if (height === lastViewportHeight) return;
		lastViewportHeight = height;
		document.documentElement.style.setProperty("--app-height", `${height}px`);
	}
	function scheduleViewportSync() {
		// 键盘弹出/地址栏收缩时 visualViewport scroll 会高频触发；合并到一帧，
		// 避免每次事件都改 CSS 变量触发整页样式重算。
		if (viewportSyncFrame) return;
		viewportSyncFrame = requestAnimationFrame(() => {
			viewportSyncFrame = 0;
			syncViewportHeight();
		});
	}
	window.visualViewport?.addEventListener("resize", scheduleViewportSync);
	window.visualViewport?.addEventListener("scroll", scheduleViewportSync);
	syncViewportHeight();

	// 手机端装到主屏后离线也能打开外壳；API 请求永不缓存，恢复网络即可继续。
	// 放到首屏请求完成后的空闲期注册：SW 安装会再拉一遍外壳资源，弱网下与
	// state/sessions 抢带宽会直接拖慢首屏。
	let serviceWorkerRegistered = false;
	function registerServiceWorker() {
		if (serviceWorkerRegistered || !("serviceWorker" in navigator)) return;
		serviceWorkerRegistered = true;
		const start = () => void navigator.serviceWorker.register("./sw.js").catch(() => undefined);
		if (typeof requestIdleCallback === "function") {
			requestIdleCallback(start, { timeout: 2000 });
		} else {
			setTimeout(start, 0);
		}
	}

	void boot().finally(registerServiceWorker);
})();
