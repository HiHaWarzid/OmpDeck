import type { PiDesktopApi } from "../../shared/api";
import type {
	WebAgentHistoryPage,
	WebAgentHistoryPageInput,
	AbortAndRestoreQueueResult,
	AgentMessagesDelta,
	AgentRuntimeState,
	AgentTab,
	AgentUiRequest,
	AvailableModel,
	ChatMessage,
	Project,
	PromoteQueuedMessageResult,
	RemoveQueuedMessageResult,
	SendPromptInput,
	SendPromptResult,
	SessionSummary,
	WebServiceStatus,
} from "../../shared/types";
import { t } from "./i18n";
import { messageStreamVersion } from "../../shared/messageStreamVersion";
import { webRouteUrl, webRoutes, type WebRestRoute } from "../../shared/ipc";
import { createPreviewApi } from "./previewApi";
import { detectRuntimeSurface } from "./utils/runtimeSurface";

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
/**
 * 宿主判定只经 `detectRuntimeSurface`（见 utils/runtimeSurface）。
 * 本模块在 `runtimeApi` 安装 api 之前求值，所以这里读到的 `window.piDesktop === undefined`
 * 恰好就是「preload 不存在」；不要在别处再写第二份 userAgent / protocol 判定。
 */
const surface = detectRuntimeSurface({
	hasPreload: typeof window !== "undefined" && Boolean(window.piDesktop),
	userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
	protocol: typeof window === "undefined" ? "" : window.location.protocol,
});
const isBrowserRuntime = surface === "lan-web" || surface === "preview";

// 静态 import 在 Electron 里也会执行本模块；无条件标记会让桌面端误判为手机页面，
// 隐藏令牌轮换、远程访问等桌面专属设置。
if (typeof document !== "undefined" && isBrowserRuntime) {
	document.documentElement.dataset.runtime = "web";
}

/**
 * 仅 Web 运行时注册 SW；Electron 里不注册，以免 dev server 缓存干扰。
 * HTTPS（Tailscale Serve 等）与 localhost HTTP 是安全上下文，可安装 PWA；
 * 局域网裸 HTTP 注册会被浏览器拒绝，catch 掉即可，不影响页面使用。
 *
 * Vite dev 里也必须跳过：`sw.js` / `mobile.*` 在 dev 下由 Vite 直接下发 public 目录的
 * 原文，`__SHELL_VERSION__` 不会被替换（替换发生在 Main 的 sendFile 里）。缓存键因此
 * 变成一个永不变化的字面量，改了手机端脚本也照旧命中旧缓存，只能手动清站点数据。
 */
if (
	import.meta.env.DEV === false &&
	isBrowserRuntime &&
	typeof navigator !== "undefined" &&
	"serviceWorker" in navigator &&
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

/**
 * 按 webRoutes 描述符发起 REST 调用：路径、method、响应解包字段全部来自共享表，
 * 成员实现只补路径参数/查询/请求体。路径参数与模板占位符不匹配时 webRouteUrl
 * 直接抛错，避免成员签名与路由漂移后静默打到错误端点。
 */
async function callRoute<T>(
	route: WebRestRoute,
	call: {
		params?: Readonly<Record<string, string>>;
		query?: URLSearchParams;
		body?: unknown;
	} = {},
): Promise<T> {
	const search = call.query && call.query.size > 0 ? `?${call.query.toString()}` : "";
	const payload = await request<Record<string, unknown>>(
		`${webRouteUrl(route, call.params)}${search}`,
		{
			method: route.method,
			...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
		},
	);
	const result = route.result;
	if (result === "body") return payload as T;
	if (result) return payload[result.field] as T;
	return undefined as T;
}

async function refreshState() {
	// /api/state 是跨命名空间聚合端点（多份 deps 拼装），没有对应 api 成员，故不进 webRoutes。
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
		// 只比较流式版本（长度/末条 id/时间戳/文本长度），不序列化整份 transcript；
		// 与 WebServiceManager 的指纹语义一致，避免 Web 模式每轮轮询在主线程
		// 对全部消息做 JSON.stringify。
		const key = messageStreamVersion(messages);
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
	}, 1000);
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
				return callRoute<SessionSummary[]>(webRoutes.sessions.list, {
					params: { projectId },
				});
			},
			readMessageFullText: async (agentId, messageId, entryId) => {
				// 工具输出被截断时手机端按需取全文；entryId 是查询参数，不进路径。
				const query = new URLSearchParams();
				if (entryId) query.set("entryId", entryId);
				return callRoute<{ text: string }>(webRoutes.sessions.readMessageFullText, {
					params: { agentId, messageId },
					query,
				});
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
			getMessages: async (agentId) =>
				callRoute<ChatMessage[]>(webRoutes.agents.getMessages, { params: { agentId } }),
			create: async (input) => callRoute<AgentTab>(webRoutes.agents.create, { body: input }),
			historyPage: async (input: WebAgentHistoryPageInput): Promise<WebAgentHistoryPage> => {
				const query = new URLSearchParams();
				if (input.before) query.set("before", input.before);
				if (input.limit) query.set("limit", String(input.limit));
				return callRoute<WebAgentHistoryPage>(webRoutes.agents.historyPage, {
					params: { agentId: input.agentId },
					query,
				});
			},
			stop: async (agentId) => {
				await callRoute(webRoutes.agents.stop, { params: { agentId } });
				await refreshState();
			},
			abort: async (agentId) => {
				// abort 只中止当前回合；会话仍存活，不能复用 /stop（会退役 pi 进程）。
				await callRoute(webRoutes.agents.abort, { params: { agentId } });
				await refreshState();
			},
			abortAndRestoreQueue: async (agentId) => {
				const response = await callRoute<AbortAndRestoreQueueResult>(
					webRoutes.agents.abortAndRestoreQueue,
					{ params: { agentId } },
				);
				await refreshState();
				return response;
			},
			removeQueuedMessage: async (agentId, message, queue) => {
				const response = await callRoute<RemoveQueuedMessageResult>(
					webRoutes.agents.removeQueuedMessage,
					{ params: { agentId }, body: { message, queue } },
				);
				await refreshState();
				return response;
			},
			promoteQueuedMessage: async (agentId, message) => {
				const response = await callRoute<PromoteQueuedMessageResult>(
					webRoutes.agents.promoteQueuedMessage,
					{ params: { agentId }, body: { message } },
				);
				await refreshState();
				return response;
			},
			prompt: async (input: SendPromptInput) => {
				const response = await callRoute<SendPromptResult>(webRoutes.agents.prompt, {
					params: { agentId: input.agentId },
					body: input,
				});
				// The SendPromptResult is already authoritative. State refresh is best-effort and
				// must not turn an explicit semantic rejection into an indeterminate delivery.
				void refreshState().catch(() => undefined);
				return response;
			},
			runtimeState: async (agentId) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.runtimeState, { params: { agentId } }),
			cycleModel: async (agentId) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.cycleModel, { params: { agentId } }),
			availableModels: async (agentId) =>
				callRoute<AvailableModel[]>(webRoutes.agents.availableModels, { params: { agentId } }),
			setModel: async (agentId, provider, modelId) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.setModel, {
					params: { agentId },
					body: { provider, modelId },
				}),
			refreshModels: async (agentId) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.refreshModels, { params: { agentId } }),
			cycleThinking: async (agentId) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.cycleThinking, { params: { agentId } }),
			setThinking: async (agentId, level) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.setThinking, {
					params: { agentId },
					body: { level },
				}),
			availableThinkingLevels: async (agentId) =>
				callRoute<string[]>(webRoutes.agents.availableThinkingLevels, { params: { agentId } }),
			setFastMode: async (agentId, enabled) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.setFastMode, {
					params: { agentId },
					body: { enabled },
				}),
			setSlowMode: async (agentId, enabled) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.setSlowMode, {
					params: { agentId },
					body: { enabled },
				}),
			setAutoCompaction: async (agentId, enabled) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.setAutoCompaction, {
					params: { agentId },
					body: { enabled },
				}),
			setTodos: async (agentId, phases) =>
				callRoute<AgentRuntimeState>(webRoutes.agents.setTodos, {
					params: { agentId },
					body: { phases },
				}),
			onState: (callback) => subscribe(stateListeners, callback),
			onMessages: (callback) => subscribe(messageListeners, callback),
			onThinking: () => () => undefined,
			onNotice: () => () => undefined,
			onLog: () => () => undefined,
			onRpcLog: () => () => undefined,
			onRuntimeState: () => () => undefined,
			onCommandCatalog: () => () => undefined,
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
				await callRoute(webRoutes.agents.sendUiResponse, {
					params: { agentId },
					body: { requestId, ...response },
				});
				void refreshState().catch(() => undefined);
			},
			respondTrustRequest: async (requestId, choice) => {
				await callRoute(webRoutes.agents.respondTrustRequest, {
					params: { requestId },
					body: { choice },
				});
				void refreshState().catch(() => undefined);
			},
		},
		web: {
			...base.web,
			// 手机端读真实服务状态；非回环请求拿不到令牌，设置页不会显示假的预览令牌。
			// /api/web/status 是状态聚合端点（叠加 loopback 字段），不对应单个 api 成员，不进 webRoutes。
			status: async () => request<WebServiceStatus>("/api/web/status"),
			// 轮换必须在桌面端设置页完成，避免手机端误操作后所有设备一起掉线。
			rotateToken: async () => {
				throw new Error(t("settings.webTokenRotateDesktopOnly"));
			},
		},
		remoteAccess: {
			...base.remoteAccess,
			// Tailscale Serve 由桌面端主进程管理；手机端没有可用的真实状态接口，
			// 不要回退到 preview 的假 installed/loggedIn，设置页会隐藏该区块。
			status: async () => {
				throw new Error(t("settings.remoteAccessDesktopOnly"));
			},
			start: async () => {
				throw new Error(t("settings.remoteAccessDesktopOnly"));
			},
			stop: async () => {
				throw new Error(t("settings.remoteAccessDesktopOnly"));
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
