import type { PiDesktopApi } from "../../shared/api";
import type {
	AgentHistoryPage,
	AgentHistoryPageInput,
	AgentMessagesDelta,
	AgentTab,
	AgentUiRequest,
	ChatMessage,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionSummary,
	WebServiceStatus,
} from "../../shared/types";
import { t } from "./i18n";
import { createPreviewApi } from "./previewApi";

type WebState = {
	projects: Project[];
	agents: AgentTab[];
	messagesByAgent: Record<string, ChatMessage[]>;
	trustRequests?: Array<{ requestId: string; cwd: string; projectName: string; createdAt: number }>;
};

const TOKEN_STORAGE_KEY = "ompdeck.web.token";

/**
 * 令牌来源优先级：URL ?token=（扫码首次打开）> localStorage（后续刷新）。
 * 读到 URL 令牌后立即从地址栏移除，避免被截图/分享链接带出去。
 */
function readInitialToken(): string {
	if (typeof window === "undefined") return "";
	try {
		const url = new URL(window.location.href);
		const fromUrl = url.searchParams.get("token");
		if (fromUrl) {
			window.localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
			url.searchParams.delete("token");
			window.history.replaceState(null, "", url.toString());
			return fromUrl;
		}
		return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

let authToken = readInitialToken();
if (typeof document !== "undefined") {
	document.documentElement.dataset.runtime = "web";
}

// 仅 Web 运行时注册 SW；Electron 里 piDesktop 存在，不注册以免 dev server 缓存干扰。
// HTTPS（Tailscale Serve 等）与 localhost HTTP 是安全上下文，可安装 PWA；
// 局域网裸 HTTP 注册会被浏览器拒绝，catch 掉即可，不影响页面使用。
if (
	typeof navigator !== "undefined" &&
	"serviceWorker" in navigator &&
	window.piDesktop === undefined &&
	(window.location.protocol === "http:" || window.location.protocol === "https:")
) {
	void navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}
const trustListeners = new Set<(request: { requestId: string; cwd: string; projectName: string }) => void>();
const uiRequestListeners = new Set<(request: AgentUiRequest) => void>();
const seenTrustRequests = new Set<string>();
const seenUiRequests = new Set<string>();

const base = createPreviewApi();
let state: WebState = { projects: [], agents: [], messagesByAgent: {} };
let connected = false;
let polling = false;
let pollTimer: number | undefined;
const stateListeners = new Set<(tabs: AgentTab[]) => void>();
// 浏览器模式走 WebService 全量状态轮询：每次推送都是完整 messages，按全量基线（replaceFrom: 0）发送，
// 与主进程的增量推送契约（AgentMessagesDelta）对齐。
const messageListeners = new Set<(payload: AgentMessagesDelta) => void>();
let lastMessages = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Vite dev 会把未知 /api/* 回退到 index.html，写入状态前必须确认是真正的 Web 服务载荷。
function isWebState(value: unknown): value is WebState {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.projects) &&
		Array.isArray(value.agents) &&
		isRecord(value.messagesByAgent)
	);
}

/**
 * 令牌缺失/失效时的最小恢复入口：不依赖 React 是否已挂载。
 * 输入新令牌后写 localStorage 并刷新，避免用户回到桌面端重新扫码。
 */
function showAuthGate() {
	if (document.getElementById("web-auth-gate")) return;
	const overlay = document.createElement("div");
	overlay.id = "web-auth-gate";
	overlay.className = "web-auth-gate";
	const panel = document.createElement("div");
	panel.className = "web-auth-panel";
	const title = document.createElement("strong");
	title.textContent = t("webAuth.title");
	const desc = document.createElement("small");
	desc.textContent = t("webAuth.desc");
	const input = document.createElement("input");
	input.type = "password";
	input.placeholder = t("webAuth.placeholder");
	input.className = "web-auth-input";
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = t("webAuth.submit");
	button.className = "web-auth-submit";
	button.addEventListener("click", () => {
		const token = input.value.trim();
		if (!token) return;
		window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
		window.location.reload();
	});
	panel.append(title, desc, input, button);
	overlay.append(panel);
	document.body.append(overlay);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			"content-type": "application/json",
			...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
			...(init?.headers as Record<string, string> | undefined),
		},
	});
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error(
			t("errors.nonJsonResponse", {
				status: response.status,
				statusText: response.statusText,
			}),
		);
	}
	if (response.status === 401) {
		showAuthGate();
	}
	if (!response.ok || (isRecord(data) && data.ok === false)) {
		throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : response.statusText);
	}
	return data as T;
}

async function refreshState() {
	const nextState = await request<unknown>("/api/state");
	if (!isWebState(nextState)) {
		throw new Error("Invalid web service state payload");
	}
	state = nextState;
	updateConnection(true);
	// 轮询状态下补发交互请求：手机端没有主进程 push，靠 state 里的 trustRequests
	// 和消息 meta.uiRequest 驱动与桌面端相同的弹窗组件。
	const currentTrustIds = new Set<string>();
	for (const request of state.trustRequests ?? []) {
		currentTrustIds.add(request.requestId);
		if (seenTrustRequests.has(request.requestId)) continue;
		seenTrustRequests.add(request.requestId);
		for (const listener of trustListeners) listener(request);
	}
	for (const requestId of seenTrustRequests) {
		if (!currentTrustIds.has(requestId)) seenTrustRequests.delete(requestId);
	}
	const currentUiIds = new Set<string>();
	for (const messages of Object.values(state.messagesByAgent)) {
		for (const message of messages) {
			const uiRequest = message.meta?.uiRequest;
			if (!uiRequest || typeof uiRequest !== "object") continue;
			const request = uiRequest as AgentUiRequest;
			if (!request.requestId || message.meta?.status !== "pending") continue;
			currentUiIds.add(request.requestId);
			if (seenUiRequests.has(request.requestId)) continue;
			seenUiRequests.add(request.requestId);
			for (const listener of uiRequestListeners) listener(request);
		}
	}
	for (const requestId of seenUiRequests) {
		if (!currentUiIds.has(requestId)) seenUiRequests.delete(requestId);
	}
	for (const listener of stateListeners) listener(state.agents);
	for (const [agentId, messages] of Object.entries(state.messagesByAgent)) {
		const key = JSON.stringify(messages);
		if (lastMessages.get(agentId) === key) continue;
		lastMessages.set(agentId, key);
		for (const listener of messageListeners) listener({ agentId, replaceFrom: 0, messages });
	}
	return state;
}

let connectionKnown = false;
function updateConnection(next: boolean) {
	// 首次结果也要广播：初始 connected=false，若第一次轮询就失败，
	// 只按「值变化」判断会让 UI 永远停在在线状态。
	if (connectionKnown && connected === next) return;
	connectionKnown = true;
	connected = next;
	window.dispatchEvent(new CustomEvent("ompdeck:web-connection", { detail: next }));
}

function ensurePolling() {
	if (polling) return;
	polling = true;
	void refreshState().catch(() => updateConnection(false));
	pollTimer = window.setInterval(() => {
		void refreshState().catch(() => updateConnection(false));
	}, 600);
}

function subscribe<T>(set: Set<(payload: T) => void>, callback: (payload: T) => void) {
	ensurePolling();
	set.add(callback);
	return () => {
		set.delete(callback);
		if (stateListeners.size === 0 && messageListeners.size === 0 && pollTimer) {
			window.clearInterval(pollTimer);
			pollTimer = undefined;
			polling = false;
		}
	};
}

export function createBrowserApi(): PiDesktopApi {
	return {
		...base,
		projects: {
			...base.projects,
			list: async () => {
				try {
					return (await refreshState()).projects;
				} catch {
					return connected ? state.projects : base.projects.list();
				}
			},
		},
		sessions: {
			...base.sessions,
			list: async (projectId) => {
				if (!projectId) return [];
				const result = await request<{ sessions: SessionSummary[] }>(
					`/api/projects/${encodeURIComponent(projectId)}/sessions`,
				);
				return result.sessions;
			},
		},
		agents: {
			...base.agents,
			list: async () => {
				try {
					return (await refreshState()).agents;
				} catch {
					return connected ? state.agents : base.agents.list();
				}
			},
			getMessages: async (agentId) => {
				const result = await request<{ messages: ChatMessage[] }>(
					`/api/agents/${encodeURIComponent(agentId)}/messages`,
				);
				return result.messages;
			},
			create: async (input) => {
				const result = await request<{ agent: AgentTab }>("/api/agents", {
					method: "POST",
					body: JSON.stringify(input),
				});
				return result.agent;
			},
			historyPage: async (input: AgentHistoryPageInput): Promise<AgentHistoryPage> => {
				const params = new URLSearchParams();
				if (input.before) params.set("before", input.before);
				if (input.limit) params.set("limit", String(input.limit));
				const query = params.size > 0 ? `?${params.toString()}` : "";
				return request<AgentHistoryPage>(
					`/api/agents/${encodeURIComponent(input.agentId)}/history-page${query}`,
				);
			},
			stop: async (agentId) => {
				await request(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
					method: "POST",
					body: "{}",
				});
				await refreshState();
			},
			abort: async (agentId) => {
				await request(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
					method: "POST",
					body: "{}",
				});
				await refreshState();
			},
			prompt: async (input: SendPromptInput) => {
				const response = await request<{ result: SendPromptResult }>(
					`/api/agents/${encodeURIComponent(input.agentId)}/prompt`,
					{
						method: "POST",
						body: JSON.stringify(input),
					},
				);
				// The SendPromptResult is already authoritative. State refresh is best-effort and
				// must not turn an explicit semantic rejection into an indeterminate delivery.
				void refreshState().catch(() => undefined);
				return response.result;
			},
			runtimeState: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["runtimeState"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/runtime`,
				);
				return result.state;
			},
			cycleModel: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["cycleModel"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/cycle-model`,
					{ method: "POST", body: "{}" },
				);
				return result.state;
			},
			availableModels: async (agentId) => {
				const result = await request<{ models: Awaited<ReturnType<PiDesktopApi["agents"]["availableModels"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/models`,
				);
				return result.models;
			},
			setModel: async (agentId, provider, modelId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["setModel"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/model`,
					{ method: "POST", body: JSON.stringify({ provider, modelId }) },
				);
				return result.state;
			},
			refreshModels: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["refreshModels"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/refresh-models`,
					{ method: "POST", body: "{}" },
				);
				return result.state;
			},
			cycleThinking: async (agentId) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["cycleThinking"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/cycle-thinking`,
					{ method: "POST", body: "{}" },
				);
				return result.state;
			},
			setThinking: async (agentId, level) => {
				const result = await request<{ state: Awaited<ReturnType<PiDesktopApi["agents"]["setThinking"]>> }>(
					`/api/agents/${encodeURIComponent(agentId)}/thinking`,
					{ method: "POST", body: JSON.stringify({ level }) },
				);
				return result.state;
			},
			onState: (callback) => subscribe(stateListeners, callback),
			onMessages: (callback) => subscribe(messageListeners, callback),
			onThinking: () => () => undefined,
			onNotice: () => () => undefined,
			onLog: () => () => undefined,
			onRpcLog: () => () => undefined,
			onRuntimeState: () => () => undefined,
			onUiRequest: (callback) => {
				ensurePolling();
				uiRequestListeners.add(callback);
				return () => uiRequestListeners.delete(callback);
			},
			onFocusTarget: () => () => undefined,
			onTrustRequest: (callback) => {
				ensurePolling();
				trustListeners.add(callback);
				return () => trustListeners.delete(callback);
			},
			sendUiResponse: async (agentId, requestId, response) => {
				await request(`/api/agents/${encodeURIComponent(agentId)}/ui-response`, {
					method: "POST",
					body: JSON.stringify({ requestId, ...response }),
				});
				void refreshState().catch(() => undefined);
			},
			respondTrustRequest: async (requestId, choice) => {
				await request(`/api/trust/${encodeURIComponent(requestId)}`, {
					method: "POST",
					body: JSON.stringify({ choice }),
				});
				void refreshState().catch(() => undefined);
			},
		},
		web: {
			...base.web,
			// 手机端读真实服务状态；非回环请求拿不到令牌，设置页不会显示假的预览令牌。
			status: async () => request<WebServiceStatus>("/api/web/status"),
			// 轮换必须在桌面端设置页完成，避免手机端误操作后所有设备一起掉线。
			rotateToken: async () => {
				throw new Error(t("settings.webTokenRotateDesktopOnly"));
			},
		},
		settings: {
			...base.settings,
			get: async () => ({
				...(await base.settings.get()),
				webServiceEnabled: true,
			}),
		},
	};
}
