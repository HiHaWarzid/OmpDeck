import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import type {
	AgentHistoryPage,
	AgentTab,
	AppSettings,
	ChatMessage,
	CreateAgentInput,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionSummary,
	WebServiceStatus,
} from "../../shared/types";
import type { PiDesktopApi } from "../../shared/api";
import { messageStreamVersion } from "../../shared/messageStreamVersion";
import {
	ensureWebTokenState,
	extractRequestToken,
	webTokenPatch,
	isLoopbackAddress,
	verifyWebToken,
	type WebAuthFailureCode,
	type WebTokenSettings,
	type WebTokenState,
} from "./WebTokenAuth";

type WebServiceSettings = Pick<
	AppSettings,
	| "webServiceEnabled"
	| "webServiceHost"
	| "webServicePort"
	| "webServiceToken"
	| "webServiceTokenGeneratedAt"
	| "webServiceTokenExpiresAt"
	| "webServiceTokenTtlDays"
>;

/**
 * Web 服务对 Agent 运行时操作/读取的依赖面（W6-18）：直接派生自 PiDesktopApi['agents']
 * 的成员类型（Pick），不再手抄签名 —— agents 命名空间（或底层 AgentManager）任何成员
 * 改名/签名变更都会让本文件或下方漂移护栏在编译期失败，而不是让 web 服务带着旧签名
 * 悄悄漂移。
 */
type WebServiceAgentDeps = Pick<
	PiDesktopApi["agents"],
	| "runtimeState"
	| "cycleModel"
	| "availableModels"
	| "setModel"
	| "refreshModels"
	| "cycleThinking"
	| "setThinking"
>;

type WebServiceDependencies = {
	listProjects: () => Project[];
	listAgents: () => AgentTab[];
	listSessions: (projectId: string) => Promise<SessionSummary[]>;
	getMessages: (agentId: string) => ChatMessage[];
	/**
	 * 以下三个成员故意用 web 端点语义命名（create/sendPrompt/stopAgent），对应
	 * agents 命名空间的 create/prompt/stop —— 名称映射是 web 面的刻意选择，签名
	 * 仍以 agents 命名空间为准。
	 */
	createAgent: (input: CreateAgentInput) => Promise<AgentTab>;
	sendPrompt: (input: SendPromptInput) => Promise<SendPromptResult>;
	stopAgent: (agentId: string) => Promise<void>;
	/** 扩展 UI 响应：手机端回答 select/confirm/input/editor。 */
	sendUiResponse: PiDesktopApi["agents"]["sendUiResponse"];
	/** 项目信任确认：手机端回传 trust-remember/trust-session/deny。 */
	respondTrustRequest: PiDesktopApi["agents"]["respondTrustRequest"];
	/** 历史分页（与桌面 IPC 同一实现）。 */
	getHistoryPage: (agentId: string, before?: string, limit?: number) => Promise<AgentHistoryPage>;
	/** 手机端轮询待确认的项目信任请求。 */
	listTrustRequests: () => Array<{ requestId: string; cwd: string; projectName: string; createdAt: number }>;
	/** 首次启动自动生成的令牌需要落盘，否则每次重启都会让已扫码设备掉线。 */
	persistWebToken: (patch: WebTokenSettings) => Promise<void>;
} & WebServiceAgentDeps;

/**
 * 编译期漂移护栏（W6-18）：把 agents 命名空间的真实成员形状（按名取型，改名即
 * 编译失败）与 web 声明的依赖成员做结构性比对。若未来有人把上面 WebServiceAgentDeps
 * 改回手写签名并引入偏差（成员缺失、参型不同），或 agents 命名空间删除了这些成员，
 * 下面这条赋值断言直接编译失败。
 */
type AgentsNamespace = PiDesktopApi["agents"];
type _WebAgentDepsDriftGuard = {
	runtimeState: AgentsNamespace["runtimeState"];
	cycleModel: AgentsNamespace["cycleModel"];
	availableModels: AgentsNamespace["availableModels"];
	setModel: AgentsNamespace["setModel"];
	refreshModels: AgentsNamespace["refreshModels"];
	cycleThinking: AgentsNamespace["cycleThinking"];
	setThinking: AgentsNamespace["setThinking"];
} extends Pick<WebServiceDependencies, keyof WebServiceAgentDeps> ? true : never;
const _assertWebAgentDepsAssignable: _WebAgentDepsDriftGuard = true;

/**
 * 关闭 server 的有界宽限期（毫秒，构造时可注入小值便于测试）：内嵌页面每 600ms
 * fetch 轮询走 keep-alive，只要浏览器 tab 开着、或正好有请求在途，server.close()
 * 的回调就要等对应连接结束才触发；连接迟迟不结束则 await applySettings 的 IPC
 * 永不 settle（上层表现为「关闭 web 服务卡住」）。
 */
const DEFAULT_CLOSE_GRACE_MS = 1000;
/** 请求体上限：prompt 可带图片 base64，但 2MB 足够覆盖手机端截图，避免无界内存。 */
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
/** prompt/停止等写操作按 IP 每分钟上限，避免误触或脚本刷屏。 */
const MUTATION_RATE_LIMIT_PER_MINUTE = 120;

class HttpError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

export type WebServiceManagerOptions = {
	/** 测试注入时钟，验证令牌过期分支 */
	now?: () => number;
	/** 测试强制非回环请求也校验令牌（默认按 socket 地址判断） */
	requireAuth?: boolean;
};

export class WebServiceManager {
	private server: Server | null = null;
	private current: { host: string; port: number } | null = null;
	private readonly rendererRoot = join(__dirname, "../renderer");
	private tokenState: WebTokenState = {
		token: "",
		generatedAt: 0,
		expiresAt: null,
		ttlDays: 30,
	};
	private readonly rateBuckets = new Map<string, { windowStart: number; count: number }>();
	private readonly now: () => number;
	private readonly requireAuth: boolean;

	constructor(
		private readonly deps: WebServiceDependencies,
		private readonly closeGraceMs: number = DEFAULT_CLOSE_GRACE_MS,
		options: WebServiceManagerOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.requireAuth = options.requireAuth ?? false;
	}

	async applySettings(settings: WebServiceSettings) {
		// 令牌先于启停更新：服务已运行时用户轮换令牌，不需要重启监听也能立即生效。
		const tokenState = ensureWebTokenState(settings, this.now());
		this.tokenState = tokenState.state;
		if (tokenState.changed) {
			// 写盘失败不阻塞服务启动：内存令牌仍可用，只是重启后会再生成一次。
			void this.deps.persistWebToken(webTokenPatch(tokenState.state)).catch(() => undefined);
		}
		if (!settings.webServiceEnabled) {
			await this.stop();
			return;
		}

		const host = settings.webServiceHost.trim() || "127.0.0.1";
		const port = this.normalizePort(settings.webServicePort);
		if (this.server && this.current?.host === host && this.current.port === port) return;
		// 先绑定新端口，成功后才关旧 server：端口被占用/非法时 start 会 reject，
		// 旧服务原样继续服务，绝不因一次设置笔误把正在工作的服务打下来。
		const previous = this.server;
		await this.start(host, port);
		if (previous) await this.closeServer(previous);
	}

	async stop() {
		const server = this.server;
		if (!server) return;
		this.server = null;
		this.current = null;
		await this.closeServer(server);
	}

	/** 当前是否有 server 在监听：用于区分「新端口起不来但旧服务仍可用」与「确实没有任何服务」。 */
	isRunning(): boolean {
		// applySettings 失败路径不会给 this.server 赋新值，因此旧 server 仍登记在此，返回 true
		return this.server !== null;
	}

	/** 设置页/手机状态页共用的监听信息；令牌只回传给本机调用方。 */
	getStatus(includeToken = true): WebServiceStatus {
		const host = this.current?.host ?? "";
		const port = this.current?.port ?? 0;
		const lanAddresses = this.findLanAddresses();
		const advertisedHost =
			host === "0.0.0.0" || host === "::" ? lanAddresses[0] ?? "localhost" : host || "127.0.0.1";
		return {
			running: this.isRunning(),
			host,
			port,
			token: includeToken ? this.tokenState.token : null,
			tokenGeneratedAt: this.tokenState.generatedAt || null,
			tokenExpiresAt: this.tokenState.expiresAt,
			loopback: true,
			url: `http://${advertisedHost}:${port}`,
			// 多网卡主机只挑第一个地址可能不可达，设置页让用户选择实际可路由的网段。
			lanUrls: lanAddresses.map((address) => `http://${address}:${port}`),
		};
	}

	/** 枚举所有非内部 IPv4；0.0.0.0 时手机扫码/复制地址的候选来源。 */
	private findLanAddresses(): string[] {
		const addresses: string[] = [];
		for (const entries of Object.values(networkInterfaces())) {
			for (const entry of entries ?? []) {
				if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
			}
		}
		return addresses;
	}

	/**
	 * 关闭 server 且有界 settle：先 closeIdleConnections() 踢掉 keep-alive 空闲连接
	 * 让 close 回调尽快触发；超过宽限期用 closeAllConnections() 强断剩余连接，到点
	 * 也 resolve。本方法刻意不 reject —— server 引用此时已从实例摘除，没有重试机会，
	 * 卡住比报错更糟。
	 */
	private closeServer(server: Server): Promise<void> {
		const closed = Promise.withResolvers<void>();
		// resolve 幂等：宽限期到点与 close 回调谁先来都能安全收口
		const timer = setTimeout(() => {
			server.closeAllConnections();
			closed.resolve();
		}, this.closeGraceMs);
		// 绝大多数情况下空闲连接一踢，close 回调立刻触发，无需等满宽限期
		server.closeIdleConnections();
		server.close(() => {
			clearTimeout(timer);
			closed.resolve();
		});
		return closed.promise;
	}

	private async start(host: string, port: number) {
		const server = createServer(async (request, response) => {
			try {
				await this.handleRequest(request, response, host, port, server);
			} catch (error) {
				if (error instanceof HttpError) {
					this.sendError(response, error.statusCode, error.message, error.code);
					return;
				}
				this.sendError(response, 500, error instanceof Error ? error.message : String(error));
			}
		});

		server.on("clientError", (_error, socket) => {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		});

		// 全生命周期常驻 error 监听：Node 对没有监听者的 'error' 事件直接抛未捕获异常。
		// 旧代码只在 listen 成功前临时挂监听、成功即摘除，之后运行期或 close 竞争触发的
		// error 会变成未处理 rejection。绑定阶段的一次性失败经 pendingReject 转成 promise
		// reject 如实返回调用方；绑定成功后的运行期错误只在此收口，不再外抛。
		const listening = Promise.withResolvers<void>();
		let pendingReject: ((error: Error) => void) | null = listening.reject;
		server.on("error", (error: Error) => {
			const reject = pendingReject;
			pendingReject = null;
			reject?.(error);
		});
		server.listen(port, host, () => {
			pendingReject = null;
			listening.resolve();
		});
		await listening.promise;
		this.server = server;
		this.current = { host, port: this.getPort(server, port) };
	}

	private async handleRequest(
		request: IncomingMessage,
		response: ServerResponse,
		host: string,
		port: number,
		server: Server,
	) {
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
			if (request.method === "OPTIONS") {
				this.sendNoContent(response);
				return;
			}

			if (url.pathname === "/api/health") {
				this.sendJson(response, {
					ok: true,
					service: "OmpDeck",
					host,
					port: this.getPort(server, port),
					authRequired: true,
				});
				return;
			}
			this.assertRequestAllowed(request, url);
			// 写操作期间可能有并发轮询把旧快照重新写进缓存；响应结束时再清一次，
			// 保证下一轮轮询看到 UI 请求已应答、消息已追加等中间字段变化。
			if (request.method && request.method !== "GET" && request.method !== "HEAD") {
				this.statePayloadCache = null;
				response.once("finish", () => {
					this.statePayloadCache = null;
				});
			}
			if (url.pathname === "/api/web/status") {
				const loopback = this.isLoopbackRequest(request);
				const status = this.getStatus(loopback);
				this.sendJson(response, { ...status, loopback });
				return;
			}
			if (url.pathname === "/api/state") {
				// 直接写出缓存/新序列化的 JSON 字符串，避免 JSON.parse + 再 stringify
				// 的双重序列化（web UI 每 600ms 轮询，命中缓存时零 stringify 开销）
				const payload = this.getStatePayload();
				response.writeHead(200, {
					...this.baseHeaders(),
					"content-type": "application/json; charset=utf-8",
				});
				response.end(payload);
				return;
			}
			const sessionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
			if (sessionsMatch && request.method === "GET") {
				const projectId = decodeURIComponent(sessionsMatch[1]);
				this.assertProjectExists(projectId);
				const sessions = await this.deps.listSessions(projectId);
				this.sendJson(response, { sessions });
				return;
			}
			if (url.pathname === "/api/agents" && request.method === "POST") {
				// 透传完整 CreateAgentInput：带 sessionPath 即「打开历史会话」，
				// 不带则新建会话；title/noSession/cwd 与桌面端共用同一语义。
				const body = await this.readJson<Partial<CreateAgentInput>>(request);
				if (!body.projectId) {
					this.sendError(response, 400, "projectId 不能为空");
					return;
				}
				await this.assertResumeTargetAllowed(body);
				const agent = await this.deps.createAgent({
					projectId: body.projectId,
					title: body.title,
					sessionPath: body.sessionPath,
					noSession: body.noSession,
				});
				this.sendJson(response, { agent });
				return;
			}
			const messagesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
			if (messagesMatch && request.method === "GET") {
				const messages = this.deps.getMessages(decodeURIComponent(messagesMatch[1]));
				this.sendJson(response, { messages });
				return;
			}
			const historyMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/history-page$/);
			if (historyMatch && request.method === "GET") {
				const limit = Number(url.searchParams.get("limit") ?? 40);
				const page = await this.deps.getHistoryPage(
					decodeURIComponent(historyMatch[1]),
					url.searchParams.get("before") ?? undefined,
					Number.isFinite(limit) ? limit : 40,
				);
				this.sendJson(response, page);
				return;
			}
			const uiResponseMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/ui-response$/);
			if (uiResponseMatch && request.method === "POST") {
				const body = await this.readJson<{
					requestId?: string;
					value?: string | boolean | null;
					cancelled?: boolean;
					confirmed?: boolean;
				}>(request);
				if (!body.requestId) {
					this.sendError(response, 400, "requestId 不能为空");
					return;
				}
				await this.deps.sendUiResponse(decodeURIComponent(uiResponseMatch[1]), body.requestId, {
					value: body.value,
					cancelled: body.cancelled,
					confirmed: body.confirmed,
				});
				this.sendJson(response, { ok: true });
				return;
			}
			const trustMatch = url.pathname.match(/^\/api\/trust\/([^/]+)$/);
			if (trustMatch && request.method === "POST") {
				const body = await this.readJson<{ choice?: "trust-remember" | "trust-session" | "deny" }>(request);
				if (!body.choice || !["trust-remember", "trust-session", "deny"].includes(body.choice)) {
					this.sendError(response, 400, "choice 无效");
					return;
				}
				await this.deps.respondTrustRequest(decodeURIComponent(trustMatch[1]), body.choice);
				this.sendJson(response, { ok: true });
				return;
			}
			const promptMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/prompt$/);
			if (promptMatch && request.method === "POST") {
				const body = await this.readJson<Omit<SendPromptInput, "agentId">>(request);
				const message = body.message?.trim() ?? "";
				if (!message && !body.images?.length) {
					this.sendError(response, 400, "message 或 images 不能为空");
					return;
				}
				const result = await this.deps.sendPrompt({
					...body,
					agentId: decodeURIComponent(promptMatch[1]),
					message,
				});
				// prompt endpoint is a transport for SendPromptResult. Semantic rejection is still
				// a successful HTTP exchange so browser clients can distinguish rejected from
				// post-write unknown instead of collapsing both into a thrown fetch error.
				this.sendJson(response, { result });
				return;
			}
			const stopMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
			if (stopMatch && request.method === "POST") {
				await this.deps.stopAgent(decodeURIComponent(stopMatch[1]));
				this.sendJson(response, { ok: true });
				return;
			}
			const runtimeMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/runtime$/);
			if (runtimeMatch && request.method === "GET") {
				const state = await this.deps.runtimeState(decodeURIComponent(runtimeMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const cycleModelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/cycle-model$/);
			if (cycleModelMatch && request.method === "POST") {
				const state = await this.deps.cycleModel(decodeURIComponent(cycleModelMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const modelsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/models$/);
			if (modelsMatch && request.method === "GET") {
				const models = await this.deps.availableModels(decodeURIComponent(modelsMatch[1]));
				this.sendJson(response, { models });
				return;
			}
			const setModelMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/model$/);
			if (setModelMatch && request.method === "POST") {
				const body = await this.readJson<{ provider?: string; modelId?: string }>(request);
				const state = await this.deps.setModel(
					decodeURIComponent(setModelMatch[1]),
					body.provider ?? "",
					body.modelId ?? "",
				);
				this.sendJson(response, { state });
				return;
			}
			const refreshModelsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/refresh-models$/);
			if (refreshModelsMatch && request.method === "POST") {
				const state = await this.deps.refreshModels(decodeURIComponent(refreshModelsMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const cycleThinkingMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/cycle-thinking$/);
			if (cycleThinkingMatch && request.method === "POST") {
				const state = await this.deps.cycleThinking(decodeURIComponent(cycleThinkingMatch[1]));
				this.sendJson(response, { state });
				return;
			}
			const setThinkingMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/thinking$/);
			if (setThinkingMatch && request.method === "POST") {
				const body = await this.readJson<{ level?: string }>(request);
				const state = await this.deps.setThinking(decodeURIComponent(setThinkingMatch[1]), body.level ?? "");
				this.sendJson(response, { state });
				return;
			}
			if (url.pathname.startsWith("/api/")) {
				this.sendError(response, 404, "API 不存在");
				return;
			}

			await this.serveRenderer(url.pathname, response);
	}

	private isLoopbackRequest(request: IncomingMessage): boolean {
		// 回环连接本身不够：DNS rebinding 会让攻击者页面的 Host 指向 127.0.0.1，
		// socket 同样是回环。只有 Host 也是 IP/localhost/实际绑定主机时才免令牌。
		return (
			!this.requireAuth &&
			isLoopbackAddress(request.socket.remoteAddress) &&
			this.isTrustedHost(request)
		);
	}

	/**
	 * 可信 Host：IP 字面量、localhost 或实际绑定的主机名。
	 * 其他主机名（如 Tailscale/Cloudflare 隧道域名）不放行免令牌，但也不拒绝——
	 * 它们必须带令牌，既保留隧道用法，又挡住 DNS rebinding 的无凭据访问。
	 */
	private isTrustedHost(request: IncomingMessage): boolean {
		const hostHeader = request.headers.host;
		if (!hostHeader) return false;
		let hostname: string;
		try {
			hostname = new URL(`http://${hostHeader}`).hostname;
		} catch {
			return false;
		}
		const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
		const configuredHost = this.current?.host;
		const matchesConfiguredHost =
			!!configuredHost &&
			configuredHost !== "0.0.0.0" &&
			configuredHost !== "::" &&
			configuredHost.toLowerCase() === bareHost.toLowerCase();
		return bareHost === "localhost" || isIP(bareHost) !== 0 || matchesConfiguredHost;
	}

	/**
	 * API 访问闸门：
	 * - 回环地址（桌面本机）免令牌，保留排障/内置浏览器体验；
	 * - 非回环请求必须带 Bearer / X-Omp-Token / ?token=；
	 * - 写请求校验 Origin 与 Host 一致，挡住跨站页面直接 POST；
	 * - 写请求按 IP 限流，避免手机误触或脚本刷屏。
	 */
	private assertRequestAllowed(request: IncomingMessage, url: URL): void {
		if (!url.pathname.startsWith("/api/")) return;
		const method = request.method ?? "GET";
		const mutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
		if (mutating) this.assertSameOrigin(request);
		if (this.isLoopbackRequest(request)) return;
		if (mutating) this.assertRateLimit(request);
		const failure = verifyWebToken(extractRequestToken(request), this.tokenState, this.now());
		if (failure) {
			throw new HttpError(
				401,
				failure === "token_missing" ? "缺少访问令牌" : failure === "token_expired" ? "访问令牌已过期" : "访问令牌无效",
				failure,
			);
		}
	}

	private assertProjectExists(projectId: string): void {
		if (!this.deps.listProjects().some((project) => project.id === projectId)) {
			throw new HttpError(404, "项目不存在", "project_not_found");
		}
	}

	/**
	 * Web 端创建 Agent 的边界：
	 * - 不接受 cwd，进程目录只能由项目/worktree 决定，避免令牌持有者把 pi 起在任意目录；
	 * - 历史会话必须属于该项目，否则等于用一个项目的工作目录打开另一个项目的会话文件；
	 * - 路径必须是绝对路径，且与 SessionSummary.filePath 归一化后一致。
	 */
	private async assertResumeTargetAllowed(body: Partial<CreateAgentInput>): Promise<void> {
		const projectId = body.projectId as string;
		this.assertProjectExists(projectId);
		if (body.cwd !== undefined) {
			throw new HttpError(400, "Web 端不接受 cwd", "cwd_not_allowed");
		}
		if (!body.sessionPath) return;
		if (!isAbsolute(body.sessionPath)) {
			throw new HttpError(400, "sessionPath 必须是绝对路径", "session_path_invalid");
		}
		const sessions = await this.deps.listSessions(projectId);
		const target = this.normalizePathForCompare(body.sessionPath);
		if (!sessions.some((session) => this.normalizePathForCompare(session.filePath) === target)) {
			throw new HttpError(400, "sessionPath 不属于该项目", "session_path_not_found");
		}
	}

	private normalizePathForCompare(value: string): string {
		const normalized = normalize(value).replace(/[\\/]+$/, "");
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	}

	private assertSameOrigin(request: IncomingMessage): void {
		const origin = request.headers.origin;
		// 非浏览器客户端（curl/脚本）通常不带 Origin，不因此拒绝。
		if (!origin) return;
		let originHost: string;
		try {
			originHost = new URL(origin).host;
		} catch {
			throw new HttpError(403, "Origin 无效", "origin_invalid");
		}
		const expectedHost = request.headers.host;
		if (!expectedHost || originHost !== expectedHost) {
			throw new HttpError(403, "跨站请求已拒绝", "origin_mismatch");
		}
	}

	private assertRateLimit(request: IncomingMessage): void {
		const key = request.socket.remoteAddress ?? "unknown";
		const now = this.now();
		const bucket = this.rateBuckets.get(key);
		if (!bucket || now - bucket.windowStart >= 60_000) {
			this.rateBuckets.set(key, { windowStart: now, count: 1 });
			return;
		}
		bucket.count += 1;
		if (bucket.count > MUTATION_RATE_LIMIT_PER_MINUTE) {
			throw new HttpError(429, "请求过于频繁，请稍后再试", "rate_limited");
		}
	}

	/**
	 * /api/state 序列化缓存：web UI 每 600ms 轮询一次，流式期间消息逐条增长，
	 * 每次都全量 JSON.stringify 所有 agent 全部消息是主进程 CPU 大头。
	 * 指纹覆盖 agents 状态与每个 agent 消息流的版本（见 shared/messageStreamVersion：
	 * 长度 + 末条 id/timestamp/文本长度），覆盖流式追加、末条就地更新、消息增删；
	 * 指纹未变（轮询间隔内无新内容）时直接复用上次的 JSON 字符串。
	 * 与主进程 messageDirtyFrom/replaceFrom 增量推送互补（下标级 vs 内容签名级）。
	 */
	private statePayloadCache: { fingerprint: string; payload: string } | null = null;

	private getStatePayload(): string {
		const agents = this.deps.listAgents();
		const trustRequests = this.deps.listTrustRequests();
		const fingerprint = `${agents
			.map((agent) => {
				const messages = this.deps.getMessages(agent.id);
				return [agent.id, agent.status, agent.title, messageStreamVersion(messages)].join(":");
			})
			.join("|")}#${trustRequests.map((request) => request.requestId).join(",")}`;
		if (this.statePayloadCache && this.statePayloadCache.fingerprint === fingerprint) {
			return this.statePayloadCache.payload;
		}
		const state = {
			projects: this.deps.listProjects(),
			agents,
			messagesByAgent: Object.fromEntries(
				agents.map((agent) => [agent.id, this.deps.getMessages(agent.id)]),
			),
			trustRequests,
		};
		const payload = JSON.stringify(state);
		this.statePayloadCache = { fingerprint, payload };
		return payload;
	}

	private renderPage() {
		return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>OmpDeck Web Service</title>
	<style>
		:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		body { margin: 0; background: #f4f6f8; color: #252a31; }
		.app { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
		aside { border-right: 1px solid #dfe5ee; background: #fff; padding: 16px; overflow: auto; }
		main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
		header { min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 18px; border-bottom: 1px solid #dfe5ee; background: #fff; }
		h1 { margin: 0; font-size: 16px; }
		.status { font-size: 12px; color: #687280; }
		.list { display: grid; gap: 8px; }
		button { border: 1px solid #d7dce4; background: #fff; border-radius: 8px; padding: 8px 10px; color: #252a31; cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease, opacity .12s ease; }
		button:hover:not(:disabled) { transform: translateY(-1px); border-color: #b8c2d0; }
		button.primary { border-color: #14a514; background: #14a514; color: #fff; min-width: 88px; font-weight: 700; }
		button.primary:hover:not(:disabled) { background: #129212; border-color: #129212; }
		button.danger { color: #d93025; border-color: #f1b9b9; background: #fff7f7; }
		button.ghost { color: #687280; background: #f8fafc; }
		.header-actions { display: flex; align-items: center; gap: 8px; }
		.header-actions button { height: 34px; padding: 0 12px; }
		button:disabled { opacity: .6; cursor: not-allowed; }
		.item { text-align: left; display: grid; gap: 3px; min-width: 0; }
		.item.loading { border-color: #14a514; background: #f0fdf4; }
		.item.active { border-color: #14a514; box-shadow: 0 0 0 2px rgba(20,165,20,.12); }
		.item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.item small { color: #687280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.section-title { margin: 18px 0 8px; color: #687280; font-size: 12px; font-weight: 700; }
		.agent-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; }
		.close-agent { padding: 0 10px; font-size: 12px; }
		.messages { overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
		.message { max-width: min(820px, 88%); border: 1px solid #dfe5ee; background: #fff; border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; line-height: 1.55; }
		.message.user { align-self: flex-end; background: #eaf8ee; border-color: #bee8c6; }
		.message.error { border-color: #ffd0d0; background: #fff4f4; color: #b42318; }
		.role { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 700; color: #687280; }
		.composer { display: grid; gap: 8px; padding: 12px; border-top: 1px solid #dfe5ee; background: #fff; }
		.composer-box { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; border: 1px solid #d7dce4; border-radius: 10px; padding: 8px; background: #fff; }
		textarea { width: 100%; min-height: 44px; max-height: 160px; resize: vertical; border: 0; outline: 0; padding: 6px 8px; font: inherit; line-height: 1.5; }
		.composer-actions { display: flex; align-items: center; gap: 8px; }
		.composer-hint { color: #8a94a6; font-size: 12px; padding-left: 4px; }
		.empty { margin: auto; color: #687280; text-align: center; }
		.pulse { display: inline-flex; width: 8px; height: 8px; border-radius: 999px; background: #14a514; animation: pulse 1s infinite ease-in-out; margin-right: 6px; }
		@keyframes pulse { 0%, 100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
		@media (max-width: 760px) { .app { grid-template-columns: 1fr; } aside { max-height: 42vh; border-right: 0; border-bottom: 1px solid #dfe5ee; } }
	</style>
</head>
<body>
	<div class="app">
		<aside>
		<h1>OmpDeck</h1>
			<div class="section-title">项目</div>
			<div id="projects" class="list"></div>
			<div class="section-title">Agent</div>
			<div id="agents" class="list"></div>
		</aside>
		<main>
			<header>
				<h1 id="title">选择或创建 Agent</h1>
				<div class="header-actions">
					<span id="status" class="status">连接中...</span>
					<button class="danger" type="button" id="stop">关闭 Agent</button>
				</div>
			</header>
			<div id="messages" class="messages"><div class="empty">从左侧选择项目创建 Agent，或选择现有 Agent。</div></div>
			<form id="composer" class="composer">
				<div class="composer-box">
					<textarea id="prompt" placeholder="发送消息到当前 Agent"></textarea>
					<div class="composer-actions">
						<button class="primary" type="submit">发送</button>
					</div>
				</div>
				<div class="composer-hint">Enter 发送，Shift/Ctrl + Enter 换行</div>
			</form>
		</main>
	</div>
	<script>
		let state = { projects: [], agents: [], messagesByAgent: {} };
		let activeAgentId = "";
		let creatingProjectId = "";
		let refreshing = false;
		const el = (id) => document.getElementById(id);
		async function api(path, options) {
			const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
			if (!res.ok) throw new Error((await res.json()).error || res.statusText);
			return res.json();
		}
		async function refresh() {
			if (refreshing) return;
			refreshing = true;
			try {
				state = await api("/api/state");
				if (!activeAgentId && state.agents[0]) activeAgentId = state.agents[0].id;
				render();
				el("status").textContent = "已连接";
			} catch (error) {
				el("status").textContent = error.message || String(error);
			} finally {
				refreshing = false;
			}
		}
		function render() {
			el("projects").innerHTML = state.projects.map(project => \`
				<button class="item \${project.id === creatingProjectId ? "loading" : ""}" data-project="\${project.id}" \${creatingProjectId ? "disabled" : ""}>
					<strong>\${escapeHtml(project.name)}</strong>
					<small>\${project.id === creatingProjectId ? '<span class="pulse"></span>正在打开...' : escapeHtml(project.path)}</small>
				</button>\`).join("");
			el("agents").innerHTML = state.agents.map(agent => \`
				<div class="agent-row">
					<button class="item \${agent.id === activeAgentId ? "active" : ""}" data-agent="\${agent.id}">
						<strong>\${escapeHtml(agent.title)}</strong>
						<small>\${agent.status === "running" ? '<span class="pulse"></span>' : ""}\${agent.status} · \${escapeHtml(agent.cwd)}</small>
					</button>
					<button class="close-agent ghost" data-close-agent="\${agent.id}" title="关闭 Agent">关闭</button>
				</div>\`).join("");
			const agent = state.agents.find(item => item.id === activeAgentId);
			el("title").textContent = agent ? agent.title : "选择或创建 Agent";
			el("status").innerHTML = agent?.status === "running" ? '<span class="pulse"></span>正在响应...' : (agent ? agent.status : "已连接");
			const messages = activeAgentId ? state.messagesByAgent[activeAgentId] || [] : [];
			el("messages").innerHTML = messages.length
				? messages.map(message => \`<div class="message \${message.role}"><span class="role">\${message.role}</span>\${escapeHtml(message.text || "")}</div>\`).join("")
				: '<div class="empty">暂无消息</div>';
			el("prompt").disabled = !agent;
			el("composer").querySelector("button[type=submit]").disabled = !agent;
			el("stop").disabled = !agent || agent.status === "closed";
			el("stop").textContent = agent?.status === "running" ? "停止响应" : "关闭 Agent";
		}
		document.addEventListener("click", async (event) => {
			const closeButton = event.target.closest("[data-close-agent]");
			if (closeButton) {
				const agentId = closeButton.dataset.closeAgent;
				closeButton.disabled = true;
				closeButton.textContent = "关闭中";
				try {
					await api(\`/api/agents/\${encodeURIComponent(agentId)}/stop\`, { method: "POST" });
					if (activeAgentId === agentId) activeAgentId = "";
					await refresh();
				} finally {
					closeButton.disabled = false;
					closeButton.textContent = "关闭";
				}
				return;
			}
			const projectButton = event.target.closest("[data-project]");
			if (projectButton) {
				creatingProjectId = projectButton.dataset.project;
				render();
				try {
					const result = await api("/api/agents", { method: "POST", body: JSON.stringify({ projectId: projectButton.dataset.project }) });
					activeAgentId = result.agent.id;
					await refresh();
				} finally {
					creatingProjectId = "";
					render();
				}
				return;
			}
			const agentButton = event.target.closest("[data-agent]");
			if (agentButton) {
				activeAgentId = agentButton.dataset.agent;
				render();
			}
		});
		el("composer").addEventListener("submit", async (event) => {
			event.preventDefault();
			const prompt = el("prompt");
			const message = prompt.value.trim();
			if (!message || !activeAgentId) return;
			const targetAgentId = activeAgentId;
			prompt.value = "";
			try {
				const response = await api(\`/api/agents/\${encodeURIComponent(targetAgentId)}/prompt\`, { method: "POST", body: JSON.stringify({ message }) });
				if (!response.result.accepted) {
					if (response.result.delivery !== "unknown" && activeAgentId === targetAgentId) {
						prompt.value = message;
					}
					throw new Error(response.result.error);
				}
				await refresh();
			} catch (error) {
				// Only transport errors reach this branch. The request may already have been
				// accepted, so restoring an apparently retryable draft could duplicate it.
				throw error;
			}
		});
		el("prompt").addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			el("composer").requestSubmit();
		});
		el("stop").addEventListener("click", async () => {
			if (!activeAgentId) return;
			el("stop").disabled = true;
			el("stop").textContent = "处理中";
			try {
				await api(\`/api/agents/\${encodeURIComponent(activeAgentId)}/stop\`, { method: "POST" });
				activeAgentId = "";
				await refresh();
			} finally {
				el("stop").textContent = "关闭 Agent";
			}
		});
		function escapeHtml(value) {
			return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
		}
		refresh();
		setInterval(refresh, 600);
	</script>
</body>
</html>`;
	}

	private async serveRenderer(pathname: string, response: ServerResponse) {
		const requestedPath = decodeURIComponent(pathname);
		const relativePath = requestedPath === "/" || !extname(requestedPath)
			? "index.html"
			: requestedPath.replace(/^\/+/, "");
		const filePath = normalize(join(this.rendererRoot, relativePath));
		const fromRoot = relative(normalize(this.rendererRoot), filePath);
		// relative() 比 startsWith 前缀判断可靠：避免 renderer-evil/ 被误判在 renderer/ 内。
		if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || !existsSync(filePath)) {
			if (relativePath !== "index.html" && existsSync(join(this.rendererRoot, "index.html"))) {
				return this.sendFile(join(this.rendererRoot, "index.html"), response);
			}
			this.sendHtml(response, this.renderPage());
			return;
		}
		await this.sendFile(filePath, response);
	}

	private async sendFile(filePath: string, response: ServerResponse) {
		const body = await readFile(filePath);
		const noStore =
			filePath.endsWith("index.html") ||
			filePath.endsWith("sw.js") ||
			filePath.endsWith(".webmanifest");
		response.writeHead(200, {
			...this.baseHeaders(),
			"content-type": this.contentType(filePath),
			"cache-control": noStore ? "no-store" : "public, max-age=31536000, immutable",
		});
		response.end(body);
	}

	private sendHtml(response: ServerResponse, html: string) {
		response.writeHead(200, {
			...this.baseHeaders(),
			"content-type": "text/html; charset=utf-8",
		});
		response.end(html);
	}

	private contentType(filePath: string) {
		switch (extname(filePath).toLowerCase()) {
			case ".html":
				return "text/html; charset=utf-8";
			case ".js":
				return "text/javascript; charset=utf-8";
			case ".css":
				return "text/css; charset=utf-8";
			case ".svg":
				return "image/svg+xml";
			case ".png":
				return "image/png";
			case ".ico":
				return "image/x-icon";
			case ".webmanifest":
				return "application/manifest+json; charset=utf-8";
			case ".json":
				return "application/json; charset=utf-8";
			case ".woff2":
				return "font/woff2";
			default:
				return "application/octet-stream";
		}
	}

	/** 统一安全响应头；不发送 CORS 通配，避免任意站点借浏览器读走状态。 */
	private baseHeaders(): Record<string, string> {
		return {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-frame-options": "DENY",
			"content-security-policy": "frame-ancestors 'none'",
			"referrer-policy": "no-referrer",
		};
	}

	private sendJson(response: ServerResponse, body: unknown) {
		response.writeHead(200, {
			...this.baseHeaders(),
			"content-type": "application/json; charset=utf-8",
		});
		response.end(JSON.stringify(body));
	}

	private sendError(response: ServerResponse, statusCode: number, error: string, code?: string) {
		response.writeHead(statusCode, {
			...this.baseHeaders(),
			"content-type": "application/json; charset=utf-8",
		});
		response.end(JSON.stringify(code ? { error, code } : { error }));
	}

	private sendNoContent(response: ServerResponse) {
		response.writeHead(204, this.baseHeaders());
		response.end();
	}

	private async readJson<T>(request: IncomingMessage) {
		// 强制 JSON：text/plain 表单跨站 POST 不触发 CORS 预检，必须在服务端拒绝。
		const contentType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
		if (contentType !== "application/json") {
			throw new HttpError(415, "Content-Type 必须是 application/json", "unsupported_media_type");
		}
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buffer.length;
			if (total > MAX_REQUEST_BODY_BYTES) {
				throw new HttpError(413, "请求体过大", "payload_too_large");
			}
			chunks.push(buffer);
		}
		if (chunks.length === 0) return {} as T;
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
		} catch {
			throw new HttpError(400, "请求体不是合法 JSON", "invalid_json");
		}
	}

	private getPort(server: Server, fallback: number) {
		const address = server.address();
		return typeof address === "object" && address ? (address as AddressInfo).port : fallback;
	}

	private normalizePort(value: number) {
		const port = Number(value);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error("Web 服务端口必须是 1-65535 之间的整数");
		}
		return port;
	}
}
