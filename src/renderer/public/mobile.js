/* OmpDeck 手机端：轻量页面，不加载桌面 renderer 的 4MB bundle。
 * 只依赖 /api/state?light=1、/api/projects/:id/sessions、
 * /api/agents/:id/messages?tail=N、/api/agents/:id/history-page 和
 * /api/agents/:id/messages/:messageId（展开折叠内容）这些已有接口。 */
(() => {
	const stateApi = globalThis.OmpMobileState;
	const TAIL_LIMIT = 40;
	const HOME_CACHE_KEY = "omp-mobile-home-cache-v1";
	const PROJECTS_CACHE_KEY = "omp-mobile-projects-cache-v1";
	const $ = (id) => document.getElementById(id);
	const view = $("view");
	const composer = $("composer");
	const input = $("input");
	const sendButton = $("send");
	const stopButton = $("stop");
	const backButton = $("back");
	const refreshButton = $("refresh");
	const tabs = $("tabs");
	const newSessionButton = $("new-session");
	const toastEl = $("toast");
	const sheetEl = $("sheet");
	const sheetTitle = $("sheet-title");
	const sheetBody = $("sheet-body");

	const params = new URLSearchParams(location.search);
	const urlToken = params.get("token") || "";
	if (urlToken) {
		params.delete("token");
		const query = params.toString();
		history.replaceState(null, "", location.pathname + (query ? `?${query}` : ""));
	}
	// URL 里的令牌先当临时令牌，只有请求成功才落盘；否则一个过期/错误的扫码链接
	// 会覆盖 localStorage 里原本有效的令牌，把已连接设备踢下线。
	let token = urlToken || localStorage.getItem("omp-mobile-token") || "";
	let pendingUrlToken = urlToken;

	let appState = { projects: readProjectsCache(), agents: [] };
	let projectId = localStorage.getItem("omp-mobile-project") || "";
	let sessions = [];
	let activeAgentId = null;
	let activeAgent = null;
	let chatMessages = [];
	let olderMessages = [];
	let nextCursor = null;
	let pollTimer = null;
	let pollInFlight = false;
	let refreshQueued = false;
	let epoch = 0;
	let supportsTail = null;
	let sending = false;
	let lastStatus = "";
	let toastTimer = null;
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
				.slice(0, 8);
			localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
		} catch {
			// localStorage 满或隐私模式不可用时，首页仍可在内存里使用。
		}
	}

	function cacheSessions(id, list) {
		if (!id) return;
		homeCache[id] = {
			at: Date.now(),
			sessions: (list || []).slice(0, 100),
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
		try {
			const response = await fetch(path, {
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
					const stored = localStorage.getItem("omp-mobile-token") || "";
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
				localStorage.setItem("omp-mobile-token", token);
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
		}
	}

	function handleError(error) {
		if (error?.status === 401) {
			token = "";
			pendingUrlToken = "";
			localStorage.removeItem("omp-mobile-token");
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

	function resetChatEpoch() {
		epoch += 1;
		pollInFlight = false;
		refreshQueued = false;
		newMessageCount = 0;
	}

	function renderTokenPrompt() {
		stopPolling();
		resetChatEpoch();
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
		$("token-save").addEventListener("click", async () => {
			const value = $("token-input").value.trim();
			if (!value) return;
			token = value;
			localStorage.setItem("omp-mobile-token", token);
			await boot();
		});
		$("token-input").addEventListener("keydown", (event) => {
			if (event.key === "Enter") $("token-save").click();
		});
	}

	function renderFatal(error) {
		setHeader("OmpDeck", "连接失败", { tabs: true });
		view.innerHTML = `
			<div class="card empty">
				<div>${escapeHtml(error?.message || "无法连接到 OmpDeck")}</div>
				<button id="retry" class="primary" type="button" style="margin-top: 12px">重试</button>
			</div>`;
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
		if (projectId) localStorage.setItem("omp-mobile-project", projectId);
	}

	async function loadSessions() {
		if (!projectId) {
			sessions = [];
			return;
		}
		const requestedProject = projectId;
		try {
			const data = await api(`/api/projects/${encodeURIComponent(requestedProject)}/sessions`);
			if (requestedProject !== projectId) return;
			sessions = Array.isArray(data?.sessions) ? data.sessions.slice() : [];
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

	function sessionTitle(session) {
		return session.name || session.preview?.split("\n")[0] || "未命名会话";
	}

	function filterHomeRows() {
		const query = searchQuery.trim().toLowerCase();
		let visible = 0;
		view.querySelectorAll("[data-session]").forEach((row) => {
			const hit = !query || (row.dataset.search || "").includes(query);
			row.hidden = !hit;
			if (hit) visible += 1;
		});
		const empty = $("no-sessions");
		if (empty) empty.hidden = visible > 0 || sessions.length === 0;
	}

	function renderHome() {
		stopPolling();
		resetChatEpoch();
		currentTab = "home";
		activeAgentId = null;
		activeAgent = null;
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
		const agentRows = agents
			.map(
				(agent) => `
				<div class="row" data-agent="${escapeHtml(agent.id)}">
					<div class="grow">
						<span class="name">${escapeHtml(agent.title || "会话")}</span>
						<span class="meta">${escapeHtml(agent.sessionPath ? "历史会话" : "新会话")} · ${escapeHtml(timeText(agent.createdAt))}</span>
					</div>
					<span class="${badgeClass(agent.status)}">${escapeHtml(statusLabel(agent))}</span>
				</div>`,
			)
			.join("");
		const sessionRows = sessions
			.map((session) => {
				const title = sessionTitle(session);
				const searchKey = `${title} ${session.preview || ""}`.toLowerCase();
				return `
				<div class="row" data-session="${escapeHtml(session.filePath)}" data-search="${escapeHtml(searchKey)}">
					<div class="grow">
						<span class="name">${escapeHtml(title)}</span>
						<span class="preview">${escapeHtml(session.preview || "")}</span>
						<span class="meta">${escapeHtml(timeText(session.updatedAt))} · ${Number(session.messageCount) || 0} 条${session.degraded ? " · 部分损坏" : ""}</span>
					</div>
				</div>`;
			})
			.join("");
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
			<div class="card" id="sessions-card">
				${sessionRows || '<div class="empty">还没有历史会话</div>'}
				<div class="empty" id="no-sessions" hidden>没有匹配的会话</div>
			</div>
			<div class="home-note">点会话继续，点底部 + 新建</div>`;

		view.querySelectorAll("[data-project]").forEach((button) => {
			button.addEventListener("click", async () => {
				const nextProject = button.dataset.project;
				if (!nextProject || nextProject === projectId) return;
				projectId = nextProject;
				searchQuery = "";
				localStorage.setItem("omp-mobile-project", projectId);
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
		view.querySelectorAll("[data-session]").forEach((row) => {
			row.addEventListener("click", () => openSession(row.dataset.session));
		});
		const search = $("session-search");
		search?.addEventListener("input", () => {
			searchQuery = search.value;
			filterHomeRows();
		});
		filterHomeRows();
		view.setAttribute("aria-busy", "false");
	}

	let trustWatchTimer = null;
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
				<div class="grow"><span class="name">本次运行信任</span><span class="meta">仅当前 Agent 会话有效</span></div>
			</button>
			<button class="sheet-row" type="button" data-trust-choice="trust-remember">
				<div class="grow"><span class="name">始终信任</span><span class="meta">写入项目 trust 配置</span></div>
			</button>
			<button class="sheet-row" type="button" data-trust-choice="deny">
				<div class="grow"><span class="name">拒绝</span><span class="meta">本次新建/恢复会话将失败</span></div>
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
	function watchTrustDuringCreate() {
		stopTrustWatch();
		trustWatchTimer = setInterval(async () => {
			try {
				const data = await api("/api/state?light=1");
				const request = Array.isArray(data?.trustRequests) ? data.trustRequests[0] : null;
				if (!request) return;
				stopTrustWatch();
				showTrustSheet(request);
			} catch {
				// 等待期间的轮询失败不打断创建请求本身。
			}
		}, 1500);
	}

	async function createAgentAndOpen(body) {
		if (!projectId || creating) return;
		creating = true;
		newSessionButton.disabled = true;
		watchTrustDuringCreate();
		try {
			// 主进程可能等待项目信任确认（最长 60s），10s 默认超时会误报失败。
			const data = await api("/api/agents", {
				method: "POST",
				timeout: 120000,
				body: JSON.stringify({ projectId, ...body }),
			});
			if (data?.agent?.id) {
				appState.agents.push(data.agent);
				await openAgent(data.agent.id);
			}
		} catch (error) {
			handleError(error);
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
		setHeader(activeAgent?.title || "会话", statusLabel(activeAgent), { back: true, composer: true });
		setConnection("connecting");
		view.innerHTML = `
			<div class="chat-tools">
				<button class="tool" id="model-btn" type="button">模型 <b id="model-name">…</b></button>
				<button class="tool" id="thinking-btn" type="button">思考 <b id="thinking-level">…</b></button>
			</div>
			<div id="messages" aria-live="polite" aria-busy="true"></div>
			<button class="new-messages" id="new-messages" type="button" hidden></button>
			<button class="load-older" id="load-older" type="button" hidden>加载更早消息</button>`;
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
		const requestEpoch = options.epoch ?? epoch;
		const requestAgentId = activeAgentId;
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
			running = Boolean(runtime.isStreaming) || runtime.status === "running";
			const status = running ? "running" : runtime.status || activeAgent?.status || "idle";
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
			if (thinkingName) thinkingName.textContent = runtime.thinkingLevel || "默认";
			stopButton.hidden = !running;
			sendButton.disabled = sending;
			if (options.initial) {
				await loadLatestHistoryCursor(requestEpoch, requestAgentId);
			}
			if (!isCurrentRequest(requestEpoch, requestAgentId)) {
				return;
			}
			setConnection("online");
			renderMessages({
				mode: options.initial ? "initial" : options.keepBottom ? "preserve" : "auto",
				previousHeight,
				previousTop,
				nearBottom,
				newCount,
			});
		} catch (error) {
			if (error?.status === 401) {
				handleError(error);
			} else {
				setConnection("offline");
				if (options.initial) toast(error?.message || "加载消息失败");
			}
		} finally {
			pollInFlight = false;
			if (refreshQueued) {
				refreshQueued = false;
				schedulePoll(0);
			} else {
				schedulePoll(stateApi.pollDelay({ running, hidden: document.hidden }));
			}
		}
	}

	async function loadLatestHistoryCursor(requestEpoch, requestAgentId) {
		try {
			const page = await api(
				`/api/agents/${encodeURIComponent(requestAgentId)}/history-page?limit=40&compact=1`,
			);
			if (!isCurrentRequest(requestEpoch, requestAgentId)) {
				return;
			}
			if (Array.isArray(page?.messages) && page.messages.length > 0) {
				olderMessages = page.messages;
				nextCursor = page.nextCursor || null;
			}
		} catch {
			// 新会话还没有 session 文件时 history-page 会返回空；消息接口仍可用。
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
			handleError(error);
		}
	}

	function mergedMessages() {
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
			output.push(
				`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`,
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
					list = { type: "ol", items: [] };
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
			bash: "命令",
			eval: "执行",
			write: "写入",
			edit: "编辑",
			glob: "查找",
			grep: "搜索",
			task: "子任务",
			wait: "等待",
			todo: "任务",
			web_search: "搜索网页",
			lsp: "分析",
			ask: "询问",
		};
		return names[name] || name || "工具";
	}

	function toolLabel(text) {
		return String(text || "").replace(
			/^([✓✗])\s*([A-Za-z_][\w-]*)/,
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

	/** 工具消息只带工具名；从 meta.args/detailText 里提取一行可读参数，
	 *  让手机端能直接看到执行了什么命令、读了哪个文件，而不是只有“命令”。 */
	function toolSummary(meta) {
		let args = meta.args;
		if (typeof args === "string") {
			try {
				args = JSON.parse(args);
			} catch {
				args = null;
			}
		}
		if (args && typeof args === "object") {
			for (const key of [
				"command",
				"cmd",
				"path",
				"file_path",
				"filePath",
				"pattern",
				"query",
				"url",
				"description",
				"title",
			]) {
				const value = args[key];
				if (typeof value === "string" && value.trim()) return shortText(value);
			}
		}
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
		if (item.duration) parts.push(`<span>${escapeHtml(item.duration)}</span>`);
		return parts.length ? `<div class="msg-meta">${parts.join("")}</div>` : "";
	}

	function messageView(message) {
		const role = message.role || "assistant";
		const label = role === "system" ? "系统" : role === "error" ? "错误" : "助手";
		const images = Array.isArray(message.images)
			? message.images
					.map(
						(image) =>
							`<img src="data:${escapeHtml(image.mimeType)};base64,${escapeHtml(image.data)}" alt="" />`,
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
		const toolMatch = /^([✓✗])\s*([^\s]+)/.exec(String(body || ""));
		const toolName = toolNameLabel(String(meta.toolName || toolMatch?.[2] || "工具"));
		const toolError =
			meta.isError === true || meta.status === "error" || toolMatch?.[1] === "✗";
		const toolStatus = meta.status === "running" ? "▶" : toolError ? "✗" : "✓";
		const duration = durationText(meta.durationMs);
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
			optimistic: Boolean(message.optimistic),
		};
	}

	function renderMessage(item) {
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
			return `<div class="msg tool${item.toolError ? " tool-error" : ""}" ${attrs}><span class="tool-status">${escapeHtml(item.toolStatus)}</span><span class="tool-main"><span class="tool-name">${escapeHtml(item.toolName)}</span>${detail}</span>${item.duration ? `<span class="tool-duration">${escapeHtml(item.duration)}</span>` : ""}</div>`;
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
					items.push({
						key: `group:${group[0].id}`,
						html: `<div class="tool-group"><div class="tool-group-title">执行过程 · ${group.length} 步</div>${group
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

	function openDetailKeys(container) {
		const keys = new Set();
		container.querySelectorAll("details[open]").forEach((details) => {
			const owner = details.closest("[data-mid]")?.dataset.mid || "";
			const siblings = Array.from(details.parentElement?.querySelectorAll("details") || []);
			keys.add(`${owner}:${siblings.indexOf(details)}`);
		});
		return keys;
	}

	function restoreOpenDetails(container, keys) {
		if (!keys.size) return;
		container.querySelectorAll("details").forEach((details) => {
			const owner = details.closest("[data-mid]")?.dataset.mid || "";
			const siblings = Array.from(details.parentElement?.querySelectorAll("details") || []);
			if (keys.has(`${owner}:${siblings.indexOf(details)}`)) details.open = true;
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
		const previousHeight = Number(options.previousHeight) || view.scrollHeight;
		const previousTop = Number(options.previousTop) || view.scrollTop;
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
		const plan = stateApi.scrollPlan({
			mode: options.mode || "auto",
			nearBottom: options.nearBottom,
			previousHeight,
			previousTop,
			scrollHeight: view.scrollHeight,
			newCount: options.newCount,
		});
		view.scrollTop = plan.scrollTop;
		if (options.mode === "initial" || options.nearBottom) {
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
			handleError(error);
		}
	}

	function openSheet(title, html) {
		sheetTitle.textContent = title;
		sheetBody.innerHTML = html;
		sheetEl.hidden = false;
		document.body.classList.add("sheet-open");
	}

	function closeSheet() {
		sheetEl.hidden = true;
		document.body.classList.remove("sheet-open");
	}

	async function openModelSheet() {
		if (!activeAgentId) return;
		openSheet("选择模型", '<div class="empty">加载中…</div>');
		try {
			const data = await api(`/api/agents/${encodeURIComponent(activeAgentId)}/models`);
			if (sheetEl.hidden) return;
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
						<div class="grow">
							<span class="name">${escapeHtml(model.name || model.id)}</span>
							<span class="meta">${escapeHtml(model.provider)}/${escapeHtml(model.id)}</span>
						</div>
						${active ? '<span class="check">✓</span>' : ""}
					</button>`;
				})
				.join("");
			sheetBody.querySelectorAll("[data-provider]").forEach((button) => {
				button.addEventListener("click", async () => {
					closeSheet();
					try {
						await api(`/api/agents/${encodeURIComponent(activeAgentId)}/model`, {
							method: "POST",
							body: JSON.stringify({
								provider: button.dataset.provider,
								modelId: button.dataset.model,
							}),
						});
						toast("模型已切换");
						await refreshChat({ initial: true });
					} catch (error) {
						handleError(error);
					}
				});
			});
		} catch (error) {
			if (sheetEl.hidden) return;
			sheetBody.innerHTML = `<div class="empty">${escapeHtml(error?.message || "加载模型失败")}</div>`;
		}
	}

	async function openThinkingSheet() {
		if (!activeAgentId) return;
		const levels = [
			["auto", "自动"],
			["off", "关闭"],
			["minimal", "最小"],
			["low", "低"],
			["medium", "中"],
			["high", "高"],
			["xhigh", "很高"],
			["max", "最大"],
		];
		const current = currentRuntime.thinkingLevel || "auto";
		openSheet(
			"思考级别",
			levels
				.map(
					([level, label]) => `<button class="sheet-row${level === current ? " active" : ""}" type="button" data-level="${escapeHtml(level)}">
						<div class="grow"><span class="name">${escapeHtml(label)}</span><span class="meta">${escapeHtml(level)}</span></div>
						${level === current ? '<span class="check">✓</span>' : ""}
					</button>`,
				)
				.join(""),
		);
		sheetBody.querySelectorAll("[data-level]").forEach((button) => {
			button.addEventListener("click", async () => {
				closeSheet();
				try {
					await api(`/api/agents/${encodeURIComponent(activeAgentId)}/thinking`, {
						method: "POST",
						body: JSON.stringify({ level: button.dataset.level }),
					});
					toast("思考级别已切换");
					await refreshChat({ initial: true });
				} catch (error) {
					handleError(error);
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

	async function sendPrompt() {
		const text = input.value.trim();
		if (!text || !activeAgentId || sending) return;
		const agentId = activeAgentId;
		const requestEpoch = epoch;
		const optimisticId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const optimistic = {
			id: optimisticId,
			agentId,
			role: "user",
			text,
			timestamp: Date.now(),
			optimistic: true,
		};
		sending = true;
		sendButton.disabled = true;
		const previousHeight = view.scrollHeight;
		const previousTop = view.scrollTop;
		chatMessages = stateApi.appendTail(chatMessages, [optimistic], { limit: TAIL_LIMIT });
		input.value = "";
		input.style.height = "auto";
		saveDraft();
		renderMessages({ mode: "auto", nearBottom: true, previousHeight, previousTop, newCount: 0 });
		try {
			const data = await api(`/api/agents/${encodeURIComponent(agentId)}/prompt`, {
				method: "POST",
				// prompt RPC 可能跑满主进程 rpcTimeout；客户端超时中断无法证明服务端未受理。
				timeout: 0,
				body: JSON.stringify({ message: text }),
			});
			const result = data?.result;
			if (!result?.accepted) {
				removeOptimistic(optimisticId);
				if (!input.value) input.value = text;
				saveDraft();
				renderMessages({ mode: "preserve", previousHeight, previousTop });
				toast(result?.error || "发送失败");
				return;
			}
			if (isCurrentRequest(requestEpoch, agentId)) {
				await refreshChat({ initial: true });
			}
		} catch (error) {
			removeOptimistic(optimisticId);
			if (!input.value) input.value = text;
			saveDraft();
			renderMessages({ mode: "preserve", previousHeight, previousTop });
			handleError(error);
		} finally {
			sending = false;
			sendButton.disabled = false;
		}
	}

	async function stopAgent() {
		if (!activeAgentId) return;
		try {
			await api(`/api/agents/${encodeURIComponent(activeAgentId)}/stop`, { method: "POST" });
			await refreshChat({ initial: true });
		} catch (error) {
			handleError(error);
		}
	}

	async function showHome() {
		// 先切回首页状态，避免返回后仍在跑的轮询把旧会话消息写进新页面。
		stopPolling();
		resetChatEpoch();
		activeAgentId = null;
		activeAgent = null;
		setConnection("connecting");
		try {
			await refreshState();
			await loadSessions();
			renderHome();
			setConnection("online");
		} catch (error) {
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
		setHeader("设置", "连接与令牌", { tabs: true });
		// 桌面版从同源 localStorage 读取令牌，不把令牌再拼进 URL，避免历史记录/分享泄露。
		if (token) localStorage.setItem("ompdeck.web.token", token);
		const desktopHref = "?desktop=1";
		view.innerHTML = `
			<div class="section-title">连接</div>
			<div class="card">
				<div class="row static">
					<div class="grow"><span class="name">服务地址</span><span class="meta">${escapeHtml(location.origin)}</span></div>
				</div>
				<div class="row static">
					<div class="grow"><span class="name">访问令牌</span><span class="meta">${token ? "已配置" : "未配置"}</span></div>
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
					<div class="grow"><span class="name">打开桌面版</span><span class="meta">功能完整，手机可能较慢</span></div>
					<span class="chev">›</span>
				</a>
				<div class="row" id="refresh-all">
					<div class="grow"><span class="name">刷新连接</span><span class="meta">重新加载项目和会话</span></div>
				</div>
			</div>
			<div class="about">OmpDeck Mobile · 轻量手机界面</div>`;
		$("save-token").addEventListener("click", async () => {
			const value = $("settings-token").value.trim();
			if (!value) {
				token = "";
				localStorage.removeItem("omp-mobile-token");
				renderTokenPrompt();
				return;
			}
			token = value;
			localStorage.setItem("omp-mobile-token", token);
			toast("令牌已保存");
			await boot();
		});
		$("refresh-all").addEventListener("click", async () => {
			try {
				await refreshState();
				await loadSessions();
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
		const cached = projectId ? cachedSessions(projectId) : [];
		if (cached.length) {
			sessions = cached;
			renderHome();
		} else {
			renderSkeleton();
		}
		try {
			await refreshState();
			await loadSessions();
			renderHome();
			setConnection("online");
			const pending = pendingResumeAgentId;
			pendingResumeAgentId = null;
			if (pending && appState.agents.some((agent) => agent.id === pending)) {
				await openAgent(pending);
			}
		} catch (error) {
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
				await refreshState();
				await loadSessions();
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
	sendButton.addEventListener("click", sendPrompt);
	stopButton.addEventListener("click", stopAgent);
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
		if (event.target.closest("[data-close]")) closeSheet();
	});
	sheetEl.addEventListener("click", (event) => {
		if (event.target === sheetEl || event.target.closest("[data-close]")) closeSheet();
	});
	$("sheet-close").addEventListener("click", closeSheet);
	document.addEventListener("keydown", (event) => {
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

	function syncViewportHeight() {
		const height = window.visualViewport?.height || window.innerHeight;
		document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
	}
	window.visualViewport?.addEventListener("resize", syncViewportHeight);
	window.visualViewport?.addEventListener("scroll", syncViewportHeight);
	syncViewportHeight();

	// 手机端装到主屏后离线也能打开外壳；API 请求永不缓存，恢复网络即可继续。
	if ("serviceWorker" in navigator) {
		void navigator.serviceWorker.register("./sw.js").catch(() => undefined);
	}

	void boot();
})();
