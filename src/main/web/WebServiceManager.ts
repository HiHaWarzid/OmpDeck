import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { AppSettings, ChatMessage, WebServiceStatus } from "../../shared/types";
import { messageStreamVersion } from "../../shared/messageStreamVersion";
import { attachDisplayMeta } from "../../shared/sessionDisplayContract";
import {
	createWebApiHandlers,
	dispatchWebApi,
	flattenWebApiHandlers,
	toWebAgentView,
	WebApiError,
	type WebApiRouteEntry,
	type WebServiceDependencies,
} from "./webApiRoutes";
/**
 * 无 renderer 产物时的降级页：独立静态资源，不再以模板字符串嵌在这里。
 * 原因见该文件头部注释——页面里的路由字面量必须被奇偶守卫扫描，而扫描器
 * 曾需要手写「找 private renderPage() → 定位反引号 → 逐字符走转义」的抽取器。
 */
import fallbackPageHtml from "./fallbackPage.html?raw";
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

/** 隧道/反向代理注入的转发头；存在即视为非本机直连，不能走回环免令牌。 */
function hasForwardedHeaders(request: IncomingMessage): boolean {
	const headers = request.headers;
	return Boolean(
		headers.forwarded ||
			headers["x-forwarded-for"] ||
			headers["x-forwarded-host"] ||
			headers["x-forwarded-proto"] ||
			headers["x-forwarded-port"] ||
			headers["x-real-ip"] ||
			headers["cf-connecting-ip"] ||
			headers["true-client-ip"] ||
			headers.via ||
			headers["tailscale-user-login"] ||
			headers["tailscale-ingress-target"],
	);
}

/**
 * 展示推导（顶层过滤、compact 截断、工具摘要）统一在 shared SessionDisplayContract；
 * 本文件只用到 `attachDisplayMeta`（单条消息详情不截断，但仍要补派生字段）。
 */
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
 * 关闭 server 的有界宽限期（毫秒，构造时可注入小值便于测试）：内嵌页面每 1000ms
 * fetch 轮询走 keep-alive，只要浏览器 tab 开着、或正好有请求在途，server.close()
 * 的回调就要等对应连接结束才触发；连接迟迟不结束则 await applySettings 的 IPC
 * 永不 settle（上层表现为「关闭 web 服务卡住」）。
 */
const DEFAULT_CLOSE_GRACE_MS = 1000;
/** 请求体上限：prompt 可带图片 base64，但 2MB 足够覆盖手机端截图，避免无界内存。 */
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
/** prompt/停止等写操作按 IP 每分钟上限，避免误触或脚本刷屏。 */
const MUTATION_RATE_LIMIT_PER_MINUTE = 120;

export type WebServiceManagerOptions = {
	/** 测试注入时钟，验证令牌过期分支 */
	now?: () => number;
	/** 测试强制非回环请求也校验令牌（默认按 socket 地址判断） */
	requireAuth?: boolean;
};

/**
 * /api/state 序列化缓存的硬上限（字符）。超过这个体积（例如压缩归档/巨型工具结果
 * 尚未被 transcript 预算裁掉）就只本次返回、不再驻留：缓存是为了省重复 stringify
 * 的 CPU，不是把一份超大 JSON 长期钉在主进程内存里；不缓存时按 uncached 路径重算。
 */
const STATE_PAYLOAD_CACHE_MAX_CHARS = 16 * 1024 * 1024;

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
	/**
	 * 分发表在构造时扁平化一次：处理器闭包只读 `deps` 的属性，因此测试替换
	 * `deps.sendPrompt` 之类的成员后仍然生效，不需要重建表。
	 */
	private readonly routeEntries: WebApiRouteEntry[];

	constructor(
		private readonly deps: WebServiceDependencies,
		private readonly closeGraceMs: number = DEFAULT_CLOSE_GRACE_MS,
		options: WebServiceManagerOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.requireAuth = options.requireAuth ?? false;
		this.routeEntries = flattenWebApiHandlers(createWebApiHandlers(deps));
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
		const current = this.current;
		if (this.server && current && current.host === host && current.port === port) return;
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
		// 服务停掉后缓存没有任何消费者，不必把最多 16MB 的字符串一直留在主进程。
		this.invalidateStateCache();
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
				if (error instanceof WebApiError) {
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

		// 非 IPC 聚合端点（健康检查 / 服务状态 / 跨命名空间 state）没有对应的
		// window.piDesktop 成员，故不进 shared/ipc.ts 的 webRoutes，只能在此手写路径。
		if (url.pathname === "/api/health") {
			this.sendJson(request, response, {
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
			this.sendJson(request, response, { ...status, loopback });
			return;
		}
		if (url.pathname === "/api/state") {
			// 手机端只依赖项目/Agent 列表；不传大会话消息，首屏从 1MB 降到几 KB。
			if (url.searchParams.get("light") === "1") {
				this.sendJson(request, response, {
					projects: this.deps.listProjects(),
					agents: this.deps.listAgents().map(toWebAgentView),
					// 手机端在等待新建会话时轮询这里，才能弹出项目信任确认；
					// 信任请求本身只有 requestId/cwd/projectName，不含会话内容。
					trustRequests: this.deps.listTrustRequests(),
				});
				return;
			}
			// 直接写出缓存/新序列化的 JSON 字符串，避免 JSON.parse + 再 stringify
			// 的双重序列化（web UI 每 1000ms 轮询，命中缓存时零 stringify 开销）
			const payload = this.getStatePayload();
			this.sendJsonText(request, response, payload);
			return;
		}
		// 单个消息详情 /api/agents/:id/messages/:mid 没有对应 api 成员（移动端展开时
		// 直连本端点），因此不进 webRoutes、也不在上面那张分发表里。
		const messageDetailMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/messages\/([^/]+)$/);
		if (messageDetailMatch && request.method === "GET") {
			const agentId = decodeURIComponent(messageDetailMatch[1]);
			const messageId = decodeURIComponent(messageDetailMatch[2]);
			const message = this.deps.getMessages(agentId).find((item) => item.id === messageId);
			if (!message) {
				this.sendError(response, 404, "消息不存在", "message_not_found");
				return;
			}
			// 详情端点不截断（展开全文用），但仍要补派生字段：手机端展开后替换掉
			// compact 消息，不能因此丢掉摘要/状态标签。
			this.sendJson(request, response, { message: attachDisplayMeta(message) });
			return;
		}
		// 其余全部端点走 webApiRoutes 的处理器表：键与 webRoutes 同构，漏接一条即编译失败。
		const dispatched = await dispatchWebApi(
			this.routeEntries,
			request.method ?? "",
			url,
			() => this.readJson(request),
			() => this.invalidateStateCache(),
		);
		if (dispatched) {
			this.sendJson(request, response, dispatched.body);
			return;
		}
		if (url.pathname.startsWith("/api/")) {
			this.sendError(response, 404, "API 不存在");
			return;
		}

		await this.serveRenderer(url.pathname, response, request);
	}

	private isLoopbackRequest(request: IncomingMessage): boolean {
		// 回环连接本身不够：DNS rebinding 会让攻击者页面的 Host 指向 127.0.0.1，
		// socket 同样是回环。只有 Host 也是回环地址/实际绑定主机时才免令牌。
		// 反向代理（Tailscale Serve / Cloudflare Tunnel）从本机回源，socket 一定是回环，
		// 但 Host 可能被客户端伪造；带转发头说明请求来自隧道，必须继续校验令牌。
		if (hasForwardedHeaders(request)) return false;
		return (
			!this.requireAuth &&
			isLoopbackAddress(request.socket.remoteAddress) &&
			this.isTrustedHost(request)
		);
	}

	/**
	 * 可信 Host：回环地址、localhost 或实际绑定的主机名。
	 * 不能放行任意 IP 字面量：本机反向代理若把 Host 改写成 127.0.0.1（nginx 默认
	 * `$proxy_host`）且不带转发头，会让远端请求被误判成本机直连。其他主机名
	 * （如 Tailscale/Cloudflare 隧道域名）不放行免令牌，但也不拒绝——它们必须带令牌。
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
		return isLoopbackAddress(bareHost) || matchesConfiguredHost;
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
			throw new WebApiError(
				401,
				failure === "token_missing" ? "缺少访问令牌" : failure === "token_expired" ? "访问令牌已过期" : "访问令牌无效",
				failure,
			);
		}
	}

	private assertSameOrigin(request: IncomingMessage): void {
		const origin = request.headers.origin;
		// 非浏览器客户端（curl/脚本）通常不带 Origin，不因此拒绝。
		if (!origin) return;
		let originHost: string;
		try {
			originHost = new URL(origin).host;
		} catch {
			throw new WebApiError(403, "Origin 无效", "origin_invalid");
		}
		const expectedHost = request.headers.host;
		if (!expectedHost || originHost !== expectedHost) {
			throw new WebApiError(403, "跨站请求已拒绝", "origin_mismatch");
		}
	}

	private assertRateLimit(request: IncomingMessage): void {
		const key = request.socket.remoteAddress ?? "unknown";
		const now = this.now();
		// 隧道/反代会让所有客户端共享一个回环 key，桶数量本身不大；但公网直连时
		// 每个源 IP 一个桶，长时间运行需要清理过期窗口，避免 map 无界增长。
		if (this.rateBuckets.size > 2048) {
			for (const [bucketKey, bucket] of this.rateBuckets) {
				if (now - bucket.windowStart >= 60_000) this.rateBuckets.delete(bucketKey);
			}
		}
		const bucket = this.rateBuckets.get(key);
		if (!bucket || now - bucket.windowStart >= 60_000) {
			this.rateBuckets.set(key, { windowStart: now, count: 1 });
			return;
		}
		bucket.count += 1;
		if (bucket.count > MUTATION_RATE_LIMIT_PER_MINUTE) {
			throw new WebApiError(429, "请求过于频繁，请稍后再试", "rate_limited");
		}
	}

	/**
	 * /api/state 序列化缓存：web UI 每 1000ms 轮询一次，流式期间消息逐条增长，
	 * 每次都全量 JSON.stringify 所有 agent 全部消息是主进程 CPU 大头。
	 * 指纹覆盖 agents 状态与每个 agent 消息流的版本（见 shared/messageStreamVersion：
	 * 长度 + 末条 id/timestamp/文本长度），覆盖流式追加、末条就地更新、消息增删；
	 * 指纹未变（轮询间隔内无新内容）时直接复用上次的 JSON 字符串。
	 * 与主进程 messageDirtyFrom/replaceFrom 增量推送互补（下标级 vs 内容签名级）。
	 */
	private statePayloadCache: { fingerprint: string; payload: string } | null = null;

	/**
	 * 主动失效 /api/state 缓存：web 变更端点（创建/发送/停止/模型/思考）返回后，
	 * 页面会立刻 refresh；这里清掉旧快照，避免「变更已生效但页面仍显示变更前状态」。
	 * 指纹本身也能发现 agents 变化，主动失效只是把这次可见延迟压到零。
	 */
	invalidateStateCache(): void {
		this.statePayloadCache = null;
	}

	private getStatePayload(): string {
		// 项目与 agent 列表都在内存里（无 I/O），一次取出供指纹与 payload 共用，
		// 避免同一轮询内重复读取、也避免两处数据不一致。
		const projects = this.deps.listProjects();
		const agents = this.deps.listAgents();
		const trustRequests = this.deps.listTrustRequests();
		// 每个 agent 的消息数组只取一次：指纹与 payload 共用同一份快照。
		// getMessages 在超预算路径会 slice 出新数组，旧实现每个轮询周期取两次，
		// 等于把同样的复制与预算扫描做两遍。
		//
		// 指纹直接序列化 projects/agents：payload 里出现的一切元数据（cwd、压缩次数、
		// lastError 等）都必须参与失效判定；旧实现只看 id/status/title，其余字段变化
		// 会一直命中旧缓存。只序列化轻量元数据，消息仍走版本签名，不构成轮询热点。
		const messagesByAgent = new Map<string, ChatMessage[]>();
		const fingerprintParts: string[] = [JSON.stringify(projects), JSON.stringify(agents)];
		for (const agent of agents) {
			const messages = this.deps.getMessages(agent.id);
			messagesByAgent.set(agent.id, messages);
			fingerprintParts.push(messageStreamVersion(messages));
		}
		fingerprintParts.push(trustRequests.map((request) => request.requestId).join(","));
		const fingerprint = fingerprintParts.join("|");
		if (this.statePayloadCache && this.statePayloadCache.fingerprint === fingerprint) {
			return this.statePayloadCache.payload;
		}
		const state = {
			projects,
			// statusText 只是 status 的派生投影，指纹仍用原始 agents（status 变化已覆盖）。
			agents: agents.map(toWebAgentView),
			messagesByAgent: Object.fromEntries(
				agents.map((agent) => [agent.id, messagesByAgent.get(agent.id) ?? []]),
			),
			trustRequests,
		};
		const payload = JSON.stringify(state);
		// 超过硬上限只本次返回、不驻留；下一次轮询按 uncached 路径重新序列化。
		this.statePayloadCache = payload.length <= STATE_PAYLOAD_CACHE_MAX_CHARS
			? { fingerprint, payload }
			: null;
		return payload;
	}

	private renderPage() {
		return fallbackPageHtml;
	}

	private async serveRenderer(pathname: string, response: ServerResponse, request: IncomingMessage) {
		const requestedPath = decodeURIComponent(pathname);
		// 手机默认进轻量页面：桌面 bundle 首屏 4MB，经 Tailscale DERP 基本不可用。
		// 需要桌面版时显式访问 /index.html 或加 ?desktop=1。
		const mobilePage = join(this.rendererRoot, "mobile.html");
		// iPadOS 13+ 的 Safari UA 伪装成 Macintosh，靠 sec-ch-ua-mobile 或 ?mobile=1
		// 才能进手机页；桌面端仍可用 ?desktop=1 强制回桌面版。
		const isMobile =
			/Android|iPhone|iPad|iPod|Mobile/i.test(request.headers["user-agent"] ?? "") ||
			request.headers["sec-ch-ua-mobile"] === "?1" ||
			request.url?.includes("mobile=1") === true;
		const wantsDesktop = request.url?.includes("desktop=1") ?? false;
		if (requestedPath === "/" && isMobile && !wantsDesktop && existsSync(mobilePage)) {
			await this.sendFile(mobilePage, response, request);
			return;
		}
		const relativePath = requestedPath === "/" || !extname(requestedPath)
			? "index.html"
			: requestedPath.replace(/^\/+/, "");
		const filePath = normalize(join(this.rendererRoot, relativePath));
		const fromRoot = relative(normalize(this.rendererRoot), filePath);
		// relative() 比 startsWith 前缀判断可靠：避免 renderer-evil/ 被误判在 renderer/ 内。
		if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || !existsSync(filePath)) {
			if (relativePath !== "index.html" && existsSync(join(this.rendererRoot, "index.html"))) {
				return this.sendFile(join(this.rendererRoot, "index.html"), response, request);
			}
			this.sendHtml(response, this.renderPage());
			return;
		}
		await this.sendFile(filePath, response, request);
	}

	private async sendFile(filePath: string, response: ServerResponse, request: IncomingMessage) {
		const body = await readFile(filePath);
		// 只有 Vite 产出的 /assets/ 带内容哈希，可以长缓存；public 下的
		// mobile.* / boot-diagnostics.js 等文件名固定，必须每次回源。
		const noStore =
			filePath.endsWith("index.html") ||
			filePath.endsWith("sw.js") ||
			filePath.endsWith(".webmanifest") ||
			!filePath.includes(`${sep}assets${sep}`);
		const headers: Record<string, string | number> = {
			...this.baseHeaders(),
			"content-type": this.contentType(filePath),
			"cache-control": noStore ? "no-store" : "public, max-age=31536000, immutable",
		};
		// 手机端外壳（mobile.js/css/html）未压缩合计约 100KB，Tailscale 弱网下
		// 传输时间远超解析时间。只压文本且限制体积，避免桌面 4MB bundle 每请求
		// 都花 CPU 做同步 gzip。
		const acceptEncoding = request.headers["accept-encoding"];
		const compressible =
			body.length <= 512 * 1024 &&
			/\.(?:html|js|css|json|svg|webmanifest)$/i.test(filePath) &&
			typeof acceptEncoding === "string" &&
			/\bgzip\b/.test(acceptEncoding);
		const payload = compressible ? gzipSync(body) : body;
		if (compressible) {
			headers["content-encoding"] = "gzip";
			headers.vary = "accept-encoding";
		}
		headers["content-length"] = payload.length;
		response.writeHead(200, headers);
		response.end(payload);
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

	private sendJson(request: IncomingMessage, response: ServerResponse, body: unknown) {
		this.sendJsonText(request, response, JSON.stringify(body));
	}

	/**
	 * 已序列化的 JSON 也走同一压缩路径：/api/state 命中缓存时直接复用字符串，
	 * 不能为了 gzip 再 JSON.parse + stringify 一遍。
	 */
	private sendJsonText(request: IncomingMessage, response: ServerResponse, payload: string) {
		// 手机通过 Tailscale DERP 访问时带宽只有几百 KB/s；大会话状态 JSON 压缩后
		// 通常只剩 10%，这是远程可用性的关键路径。
		if (payload.length > 1024 && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "")) {
			response.writeHead(200, {
				...this.baseHeaders(),
				"content-type": "application/json; charset=utf-8",
				"content-encoding": "gzip",
				vary: "accept-encoding",
			});
			response.end(gzipSync(payload));
			return;
		}
		response.writeHead(200, {
			...this.baseHeaders(),
			"content-type": "application/json; charset=utf-8",
		});
		response.end(payload);
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
			throw new WebApiError(415, "Content-Type 必须是 application/json", "unsupported_media_type");
		}
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buffer.length;
			if (total > MAX_REQUEST_BODY_BYTES) {
				throw new WebApiError(413, "请求体过大", "payload_too_large");
			}
			chunks.push(buffer);
		}
		if (chunks.length === 0) return {} as T;
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
		} catch {
			throw new WebApiError(400, "请求体不是合法 JSON", "invalid_json");
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
