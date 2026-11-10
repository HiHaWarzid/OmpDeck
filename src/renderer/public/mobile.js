/* OmpDeck 手机端：轻量页面，不加载桌面 renderer 的 4MB bundle。
 * 只依赖 /api/state?light=1、/api/projects/:id/sessions、
 * /api/agents/:id/messages?tail=N 和 /api/agents/:id/history-page 这些已有接口。 */
(() => {
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
	let token = params.get("token") || localStorage.getItem("omp-mobile-token") || "";
	if (params.get("token")) {
		localStorage.setItem("omp-mobile-token", params.get("token"));
		params.delete("token");
		const query = params.toString();
		history.replaceState(null, "", location.pathname + (query ? `?${query}` : ""));
	}

	let appState = { projects: [], agents: [] };
	let projectId = localStorage.getItem("omp-mobile-project") || "";
	let sessions = [];
	let activeAgentId = null;
	let activeAgent = null;
	let chatMessages = [];
	let olderMessages = [];
	let nextCursor = null;
	let pollTimer = null;
	let supportsTail = null;
	let sending = false;
	let lastStatus = "";
	let toastTimer = null;
	let currentTab = "home";
	let currentRuntime = {};
	let searchQuery = "";

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

	function toast(message) {
		toastEl.textContent = message;
		toastEl.hidden = false;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toastEl.hidden = true;
		}, 3200);
	}

	async function api(path, options = {}) {
		const headers = { accept: "application/json", ...(options.headers || {}) };
		if (token) headers["x-omp-token"] = token;
		if (options.body) headers["content-type"] = "application/json";
		const response = await fetch(path, { ...options, headers });
		const text = await response.text();
		let data = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = null;
		}
		if (!response.ok) {
			const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
			error.status = response.status;
			throw error;
		}
		return data;
	}

	function handleError(error) {
		if (error?.status === 401) {
			token = "";
			localStorage.removeItem("omp-mobile-token");
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

	function renderTokenPrompt() {
		stopPolling();
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
		const data = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
		sessions = Array.isArray(data?.sessions) ? data.sessions.slice() : [];
		sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
				projectId = button.dataset.project;
				searchQuery = "";
				localStorage.setItem("omp-mobile-project", projectId);
				renderHome();
				try {
					await loadSessions();
					renderHome();
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
	}

	async function openSession(filePath) {
		const session = sessions.find((item) => item.filePath === filePath);
		if (!session) return;
		const existing = appState.agents.find(
			(agent) => agent.projectId === projectId && agent.sessionPath === filePath && agent.status !== "closed",
		);
		if (existing) {
			await openAgent(existing.id);
			return;
		}
		try {
			const data = await api("/api/agents", {
				method: "POST",
				body: JSON.stringify({ projectId, sessionPath: filePath, title: sessionTitle(session) }),
			});
			if (data?.agent?.id) {
				appState.agents.push(data.agent);
				await openAgent(data.agent.id);
			}
		} catch (error) {
			handleError(error);
		}
	}

	async function newSession() {
		if (!projectId) {
			toast("没有可用项目");
			return;
		}
		try {
			const data = await api("/api/agents", {
				method: "POST",
				body: JSON.stringify({ projectId, title: "手机会话" }),
			});
			if (data?.agent?.id) {
				appState.agents.push(data.agent);
				await openAgent(data.agent.id);
			}
		} catch (error) {
			handleError(error);
		}
	}

	function agentFromState(id) {
		return appState.agents.find((agent) => agent.id === id) || null;
	}

	async function openAgent(id) {
		stopPolling();
		currentTab = "chat";
		activeAgentId = id;
		activeAgent = agentFromState(id);
		olderMessages = [];
		nextCursor = null;
		lastStatus = "";
		chatMessages = [];
		currentRuntime = {};
		setHeader(activeAgent?.title || "会话", statusLabel(activeAgent), { back: true, composer: true });
		view.innerHTML = `
			<div class="chat-tools">
				<button class="tool" id="model-btn" type="button">模型 <b id="model-name">…</b></button>
				<button class="tool" id="thinking-btn" type="button">思考 <b id="thinking-level">…</b></button>
			</div>
			<div id="messages"></div>
			<button class="load-older" id="load-older" type="button" hidden>加载更早消息</button>`;
		$("model-btn").addEventListener("click", () => void openModelSheet());
		$("thinking-btn").addEventListener("click", () => void openThinkingSheet());
		$("load-older").addEventListener("click", loadOlder);
		await refreshChat({ initial: true });
		pollTimer = setInterval(() => {
			if (!document.hidden) void refreshChat();
		}, 3000);
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	async function refreshChat(options = {}) {
		if (!activeAgentId) return;
		// 旧版主进程没有 tail 参数时，新会话（还没有 session 文件）只能全量拉消息；
		// 不要每 3s 拉一次，等用户手动刷新或主进程更新后再轮询。
		if (supportsTail === false && !activeAgent?.sessionPath && !options.initial) return;
		try {
			const runtimePromise = api(`/api/agents/${encodeURIComponent(activeAgentId)}/runtime`).catch(
				() => null,
			);
			const messagesPromise = (async () => {
				// 旧版主进程没有 tail 参数；历史会话退回 history-page，避免每 3s 拉整段消息。
				if (supportsTail === false && activeAgent?.sessionPath) {
					const page = await api(
						`/api/agents/${encodeURIComponent(activeAgentId)}/history-page?limit=40`,
					);
					nextCursor = page?.nextCursor || null;
					return { messages: Array.isArray(page?.messages) ? page.messages : [] };
				}
				const data = await api(`/api/agents/${encodeURIComponent(activeAgentId)}/messages?tail=40`);
				supportsTail = Boolean(data && Object.prototype.hasOwnProperty.call(data, "tail"));
				return data;
			})();
			const [messagesData, runtimeData] = await Promise.all([messagesPromise, runtimePromise]);
			const list = Array.isArray(messagesData?.messages) ? messagesData.messages : [];
			chatMessages = list.slice(-40);
			const runtime = runtimeData?.state || {};
			currentRuntime = runtime;
			const running = Boolean(runtime.isStreaming) || runtime.status === "running";
			const status = running ? "running" : activeAgent?.status || (runtime.status ?? "idle");
			if (activeAgent) activeAgent.status = status;
			const model = runtime.modelName || runtime.modelId || "";
			const subtitle = [statusLabel({ status }), model].filter(Boolean).join(" · ");
			if (subtitle !== lastStatus) {
				lastStatus = subtitle;
				$("subtitle").textContent = subtitle;
			}
			const modelName = $("model-name");
			if (modelName) modelName.textContent = model || "默认";
			const thinkingName = $("thinking-level");
			if (thinkingName) thinkingName.textContent = runtime.thinkingLevel || "默认";
			stopButton.hidden = !running;
			sendButton.disabled = sending;
			if (options.initial) {
				await loadLatestHistoryCursor();
			}
			renderMessages({ scroll: options.initial || isNearBottom() });
		} catch (error) {
			if (error?.status === 401) handleError(error);
			else if (options.initial) toast(error?.message || "加载消息失败");
		}
	}

	async function loadLatestHistoryCursor() {
		try {
			const page = await api(`/api/agents/${encodeURIComponent(activeAgentId)}/history-page?limit=40`);
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
		try {
			let page;
			if (nextCursor) {
				page = await api(
					`/api/agents/${encodeURIComponent(activeAgentId)}/history-page?before=${encodeURIComponent(nextCursor)}&limit=40`,
				);
			} else {
				page = await api(`/api/agents/${encodeURIComponent(activeAgentId)}/history-page?limit=40`);
			}
			const list = Array.isArray(page?.messages) ? page.messages : [];
			const known = new Set(olderMessages.map((message) => message.id));
			olderMessages = [...list.filter((message) => !known.has(message.id)), ...olderMessages];
			nextCursor = page?.nextCursor || null;
			renderMessages({ scroll: false, keepBottom: true });
		} catch (error) {
			handleError(error);
		}
	}

	function isNearBottom() {
		return view.scrollHeight - view.scrollTop - view.clientHeight < 80;
	}

	function mergedMessages() {
		const byId = new Map();
		for (const message of olderMessages) byId.set(message.id, message);
		for (const message of chatMessages) byId.set(message.id, message);
		return Array.from(byId.values());
	}

	function renderInline(text) {
		return text
			.replace(/`([^`\n]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
			.replace(
				/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
				'<a href="$2" target="_blank" rel="noreferrer">$1</a>',
			);
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

	function renderMarkdown(text) {
		const lines = text.split("\n");
		const output = [];
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
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
				output.push(`<div class="md-h">${renderInline(heading[2])}</div>`);
				continue;
			}
			const quote = /^>\s?(.*)$/.exec(line);
			if (quote) {
				output.push(`<div class="md-quote">${renderInline(quote[1])}</div>`);
				continue;
			}
			const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
			if (bullet) {
				output.push(`<div class="md-li">• ${renderInline(bullet[1])}</div>`);
				continue;
			}
			const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
			if (numbered) {
				output.push(`<div class="md-li">${numbered[1]}. ${renderInline(numbered[2])}</div>`);
				continue;
			}
			output.push(renderInline(line));
		}
		return output.join("\n");
	}

	function renderText(text) {
		const escaped = escapeHtml(text);
		if (!escaped.includes("```")) return renderMarkdown(escaped);
		return escaped
			.split("```")
			.map((part, index) => {
				if (index % 2 === 0) return renderMarkdown(part);
				const body = part.replace(/^[^\n]*\n/, "");
				return `<pre>${body}</pre>`;
			})
			.join("");
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

	function toolLabel(text) {
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
		};
		return String(text || "").replace(/^✓\s*([A-Za-z_]+)/, (_, name) => `✓ ${names[name] || name}`);
	}

	function messageView(message) {
		const role = message.role || "assistant";
		const label =
			role === "user" ? "你" : role === "assistant" ? "助手" : role === "tool" ? "工具" : "系统";
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
		const thinkingBlock = thinking
			? `<details><summary>思考过程</summary><div class="thinking-body">${renderText(thinking)}</div></details>`
			: "";
		const text = role === "tool" ? toolLabel(body) : body;
		return { role, label, images, body, thinking, thinkingOnly, text, thinkingBlock };
	}

	function renderMessage(item) {
		return `<div class="msg ${escapeHtml(item.role)}${item.thinkingOnly ? " thinking-only" : ""}"><span class="role">${escapeHtml(item.label)}</span>${renderText(item.text)}${item.thinkingBlock}${item.images}</div>`;
	}

	function renderMessages(options = {}) {
		const container = $("messages");
		if (!container) return;
		// 只保留有正文的助手消息；纯思考消息和连续工具调用折叠成过程，
		// 避免手机端时间线被大量英文思考和工具行淹没。
		const items = mergedMessages()
			.map(messageView)
			.filter((item) => !(item.role === "assistant" && !item.body && !item.images));
		const loadOlderButton = $("load-older");
		if (loadOlderButton) loadOlderButton.hidden = !nextCursor;
		const previousHeight = view.scrollHeight;
		const html = [];
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			if (item.role === "tool") {
				const group = [item];
				while (index + 1 < items.length && items[index + 1].role === "tool") {
					index += 1;
					group.push(items[index]);
				}
				if (group.length > 1) {
					html.push(
						`<details class="tool-group"><summary>工具 · ${group.length} 次</summary>${group
							.map(renderMessage)
							.join("")}</details>`,
					);
				} else {
					html.push(renderMessage(item));
				}
				continue;
			}
			html.push(renderMessage(item));
		}
		container.innerHTML = html.join("");
		if (options.keepBottom) {
			view.scrollTop += view.scrollHeight - previousHeight;
		} else if (options.scroll) {
			view.scrollTop = view.scrollHeight;
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

	async function sendPrompt() {
		const text = input.value.trim();
		if (!text || !activeAgentId || sending) return;
		sending = true;
		sendButton.disabled = true;
		try {
			const data = await api(`/api/agents/${encodeURIComponent(activeAgentId)}/prompt`, {
				method: "POST",
				body: JSON.stringify({ message: text }),
			});
			const result = data?.result;
			if (!result?.accepted) {
				toast(result?.error || "发送失败");
			} else {
				input.value = "";
				input.style.height = "auto";
				await refreshChat({ initial: true });
			}
		} catch (error) {
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
		try {
			await refreshState();
			await loadSessions();
			renderHome();
		} catch (error) {
			if (error?.status === 401) {
				handleError(error);
				return;
			}
			if (!appState.projects.length) {
				renderFatal(error);
				return;
			}
			renderHome();
			toast(error?.message || "刷新失败");
		}
	}

	function renderSettings() {
		stopPolling();
		currentTab = "settings";
		activeAgentId = null;
		activeAgent = null;
		setHeader("设置", "连接与令牌", { tabs: true });
		const desktopHref = `?desktop=1${token ? `&token=${encodeURIComponent(token)}` : ""}`;
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
		view.innerHTML = '<div class="loading"><span class="spinner"></span>正在连接…</div>';
		try {
			await refreshState();
			await loadSessions();
			renderHome();
		} catch (error) {
			if (error?.status === 401) {
				handleError(error);
				return;
			}
			renderFatal(error);
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
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && activeAgentId) void refreshChat();
	});

	void boot();
})();
