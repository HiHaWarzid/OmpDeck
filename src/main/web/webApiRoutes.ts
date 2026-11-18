import { isAbsolute, normalize } from "node:path";
import type {
	AgentTab,
	AgentTodoPhase,
	ChatMessage,
	CreateAgentInput,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionSummary,
	WebAgentHistoryPage,
} from "../../shared/types";
import type { PiDesktopApi } from "../../shared/api";
import { matchWebRoute, webRoutes, type WebRestRoute } from "../../shared/ipc";
import { messageStreamVersion } from "../../shared/messageStreamVersion";
import {
	compactChatMessage,
	DELIVERY_LABELS,
	deliveryKind,
	isTopLevelSessionSummary,
	SESSION_STATUS_LABELS,
	sessionStatusKind,
} from "../../shared/sessionDisplayContract";
import type { WebTokenSettings } from "./WebTokenAuth";

/**
 * `/api` 端点分发表 —— 把「路径模板 → 处理器」从 WebServiceManager 的 if 长链里剥出来。
 *
 * 为什么值得收成一个模块：
 * - 表与处理器同源。旧实现靠 `webRouteParity.test.ts` 用正则扫源码，核对「webRoutes 里
 *   每条端点都在 WebServiceManager 里有 matchWebRoute 调用」；那是文本层面的守恒，
 *   加一条端点忘了分发只能靠 CI 猜。这里处理器表的键类型直接映射自 webRoutes，
 *   **少一条端点、多一个拼错的成员名都是编译错误**，运行时不再需要反向守卫。
 * - 处理器是纯的：入参是 `WebApiContext`（参数、URL、读体、失效缓存、依赖面），
 *   出参是 JSON 体，失败抛 `WebApiError`。不碰 ServerResponse，因此可以在没有 socket、
 *   没有 Electron 的环境里直接调用单个处理器测语义（信封、校验、错误码）。
 * - WebServiceManager 只剩传输层：鉴权闸门、gzip、静态资源、跨命名空间聚合端点。
 *
 * 顺序敏感性：分发按本模块扁平化后的条目顺序（即 webRoutes 声明顺序）逐条匹配。
 * 两条模板同时匹配同一 pathname+method 时前一条会遮蔽后一条，故 `webRouteParity.test.ts`
 * 保留了「method + path 组合不重复」的自洽用例。
 */

/** 与 SessionJsonlLogger 同形的日志端口（避免硬依赖 AppLogger）。 */
type WebServiceAgentDeps = Pick<
	PiDesktopApi["agents"],
	| "runtimeState"
	| "cycleModel"
	| "availableModels"
	| "setModel"
	| "refreshModels"
	| "cycleThinking"
	| "setThinking"
	| "availableThinkingLevels"
	| "setFastMode"
	| "setSlowMode"
	| "setAutoCompaction"
	| "setTodos"
	| "abortAndRestoreQueue"
	| "removeQueuedMessage"
	| "promoteQueuedMessage"
>;

/**
 * Web 服务对主进程能力的依赖面（W6-18）。agents 相关成员直接派生自
 * PiDesktopApi['agents'] 的成员类型（Pick），不手抄签名 —— 命名空间任何成员改名/
 * 签名变更都会让本文件在编译期失败，而不是让 web 服务带着旧签名悄悄漂移。
 */
export type WebServiceDependencies = {
	listProjects: () => Project[];
	listAgents: () => AgentTab[];
	listSessions: (projectId: string) => Promise<SessionSummary[]>;
	getMessages: (agentId: string) => ChatMessage[];
	/**
	 * 以下成员故意用 web 端点语义命名（create/sendPrompt/stopAgent/abortAgent），
	 * 对应 agents 命名空间的 create/prompt/stop/abort —— 名称映射是 web 面的刻意
	 * 选择，签名仍以 agents 命名空间为准。
	 *
	 * stopAgent 会退役并结束 pi 进程（关闭会话），abortAgent 只中止当前回合。
	 * 手机聊天页的「停止」必须走 abort，不能复用 stop，否则会话会被直接关闭。
	 */
	createAgent: (input: CreateAgentInput) => Promise<AgentTab>;
	sendPrompt: (input: SendPromptInput) => Promise<SendPromptResult>;
	stopAgent: (agentId: string) => Promise<void>;
	abortAgent: (agentId: string) => Promise<void>;
	/** 扩展 UI 响应：手机端回答 select/confirm/input/editor。 */
	sendUiResponse: PiDesktopApi["agents"]["sendUiResponse"];
	/** 项目信任确认：手机端回传 trust-remember/trust-session/deny。 */
	respondTrustRequest: PiDesktopApi["agents"]["respondTrustRequest"];
	/** 历史分页（与桌面 IPC 同一实现）。 */
	getHistoryPage: (agentId: string, before?: string, limit?: number) => Promise<WebAgentHistoryPage>;
	/**
	 * 工具输出超过截断阈值时按需读取全文（与桌面「查看完整输出」同一实现）。
	 * 老版本主进程没有这个能力时路由返回 404，手机端保留截断结果。
	 */
	readMessageFullText?: (
		agentId: string,
		messageId: string,
		entryId?: string,
	) => Promise<{ text: string }>;
	/** 手机端轮询待确认的项目信任请求。 */
	listTrustRequests: () => Array<{ requestId: string; cwd: string; projectName: string; createdAt: number }>;
	/** 首次启动自动生成的令牌需要落盘，否则每次重启都会让已扫码设备掉线。 */
	persistWebToken: (patch: WebTokenSettings) => Promise<void>;
} & WebServiceAgentDeps;

/**
 * 编译期漂移护栏（W6-18）：把 agents 命名空间的真实成员形状（按名取型，改名即
 * 编译失败）与上面声明的依赖成员做结构性比对。若有人把 WebServiceAgentDeps 改回
 * 手写签名并引入偏差（成员缺失、参型不同），或 agents 命名空间删除了这些成员，
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
	availableThinkingLevels: AgentsNamespace["availableThinkingLevels"];
	setFastMode: AgentsNamespace["setFastMode"];
	setSlowMode: AgentsNamespace["setSlowMode"];
	setAutoCompaction: AgentsNamespace["setAutoCompaction"];
	setTodos: AgentsNamespace["setTodos"];
	abortAndRestoreQueue: AgentsNamespace["abortAndRestoreQueue"];
	removeQueuedMessage: AgentsNamespace["removeQueuedMessage"];
	promoteQueuedMessage: AgentsNamespace["promoteQueuedMessage"];
} extends Pick<WebServiceDependencies, keyof WebServiceAgentDeps> ? true : never;
const _assertWebAgentDepsAssignable: _WebAgentDepsDriftGuard = true;
void _assertWebAgentDepsAssignable;

/** HTTP 语义的失败：由传输层翻译成状态码 + `{ error, code }` 信封。 */
export class WebApiError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

/**
 * /api/state 的 agent 视图：在 AgentTab 上附加手机端直接渲染的状态文案。
 * 手机端（classic script）不 import 契约、也不维护中文状态表，只读 `statusText`。
 */
export type WebAgentView = AgentTab & { statusText: string };

/** 三个状态出口（light 状态、完整状态、创建会话）必须用同一份文案，故统一走这个投影。 */
export function toWebAgentView(agent: AgentTab): WebAgentView {
	return { ...agent, statusText: SESSION_STATUS_LABELS[sessionStatusKind(agent.status)] };
}

/** 处理器可见的全部上下文：请求形状 + 传输能力 + 主进程依赖面。 */
export interface WebApiContext {
	/** 路径模板里的命名参数（来自 matchWebRoute，已 URL 解码）。 */
	readonly params: Record<string, string>;
	readonly url: URL;
	/** 读 JSON 请求体；Content-Type/体积校验失败抛 WebApiError。 */
	readJson: <T>() => Promise<T>;
	/** 写操作生效后清 /api/state 序列化缓存。 */
	invalidateState: () => void;
}

/** 处理器返回将被 `JSON.stringify` 的体；失败抛 WebApiError。 */
export type WebApiHandler = (ctx: WebApiContext) => unknown | Promise<unknown>;

/**
 * 处理器表：键与 webRoutes 逐层同构，值是统一签名的处理器。
 * 映射类型（而非 Record<string, …>）就是奇偶守卫本身：webRoutes 新增成员而这里没接，
 * `createWebApiHandlers` 的返回值缺键，函数体里的返回对象当场编译失败。
 */
export type WebApiHandlerTable = {
	readonly [Ns in keyof typeof webRoutes]: {
		readonly [M in keyof (typeof webRoutes)[Ns]]: WebApiHandler;
	};
};

/** 扁平条目：分发循环用它按声明顺序逐条尝试匹配。 */
export interface WebApiRouteEntry {
	/** `"agents.prompt"`：模板匹配失败时的可读定位（不是路由真值）。 */
	readonly key: string;
	readonly route: WebRestRoute;
	readonly handler: WebApiHandler;
}

function normalizePathForCompare(value: string): string {
	const normalized = normalize(value).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertProjectExists(deps: WebServiceDependencies, projectId: string): void {
	if (!deps.listProjects().some((project) => project.id === projectId)) {
		throw new WebApiError(404, "项目不存在", "project_not_found");
	}
}

/**
 * Web 端创建 Agent 的边界：
 * - 不接受 cwd，进程目录只能由项目/worktree 决定，避免令牌持有者把 pi 起在任意目录；
 * - 历史会话必须属于该项目，否则等于用一个项目的工作目录打开另一个项目的会话文件；
 * - 路径必须是绝对路径，且与 SessionSummary.filePath 归一化后一致。
 */
async function assertResumeTargetAllowed(
	deps: WebServiceDependencies,
	body: Partial<CreateAgentInput>,
): Promise<void> {
	const projectId = body.projectId as string;
	assertProjectExists(deps, projectId);
	if (body.cwd !== undefined) {
		throw new WebApiError(400, "Web 端不接受 cwd", "cwd_not_allowed");
	}
	if (!body.sessionPath) return;
	if (!isAbsolute(body.sessionPath)) {
		throw new WebApiError(400, "sessionPath 必须是绝对路径", "session_path_invalid");
	}
	const sessions = await deps.listSessions(projectId);
	const target = normalizePathForCompare(body.sessionPath);
	if (!sessions.some((session) => normalizePathForCompare(session.filePath) === target)) {
		throw new WebApiError(400, "sessionPath 不属于该项目", "session_path_not_found");
	}
}

/**
 * 构造处理器表。全部依赖通过闭包读取 `deps` 的属性（而不是在构造时解构），
 * 因此测试替换 `deps.sendPrompt = …` 后，已建好的表立刻走新实现。
 */
export function createWebApiHandlers(deps: WebServiceDependencies): WebApiHandlerTable {
	return {
		sessions: {
			list: async ({ params, url }) => {
				const projectId = params.projectId;
				assertProjectExists(deps, projectId);
				const sessions = await deps.listSessions(projectId);
				// 手机首页只展示顶层会话；子会话占列表的 60%+，在服务端剔除可显著减少
				// 弱网传输和手机端解析/渲染成本。桌面端不传该参数，保留完整嵌套数据。
				const onlyTopLevel = url.searchParams.get("topLevel") === "1";
				return {
					sessions: onlyTopLevel ? sessions.filter(isTopLevelSessionSummary) : sessions,
				};
			},
			readMessageFullText: async ({ params, url }) => {
				const unavailable = () =>
					new WebApiError(404, "完整输出不可用", "message_full_text_unavailable");
				if (!deps.readMessageFullText) throw unavailable();
				try {
					return await deps.readMessageFullText(
						params.agentId,
						params.messageId,
						url.searchParams.get("entryId") ?? undefined,
					);
				} catch {
					// 全文缓存被 LRU 淘汰或历史 entry 找不到时，不要回退成截断文本冒充全文。
					throw unavailable();
				}
			},
		},
		agents: {
			/** 手机端只轮询最近窗口，避免大会话每 2s 重传整段消息。 */
			getMessages: ({ params, url }) => {
				const messages = deps.getMessages(params.agentId);
				const tailParam = url.searchParams.get("tail");
				const tail = tailParam === null ? null : Math.min(200, Math.max(1, Number(tailParam) || 40));
				const window = tail === null ? messages : messages.slice(-tail);
				// 手机要看到 thinking 流式增长，但 messageStreamVersion 只看正文；
				// 追加末条 thinking 长度，避免「正文没变就不刷新」卡住思考块。
				const version = `${messageStreamVersion(messages)}:${messages[messages.length - 1]?.thinking?.length ?? 0}`;
				const compact = url.searchParams.get("compact") === "1";
				const afterId = url.searchParams.get("afterId") || null;
				const clientVersion = url.searchParams.get("version");
				const lengthParam = url.searchParams.get("length");
				const length = lengthParam === null ? null : Number(lengthParam);
				const payload = (list: ChatMessage[]) =>
					compact ? list.map((message) => compactChatMessage(message)) : list;
				const base = {
					total: messages.length,
					...(tail === null ? {} : { tail }),
					version,
				};
				const windowBody = (reset: boolean) => ({
					...base,
					messages: payload(window),
					reset,
					unchanged: false,
				});

				if (!afterId) return windowBody(false);

				// length 是客户端当前 tail 窗口的条数。服务端窗口长度变化说明客户端的
				// 基线已经不可靠（例如新会话只有几条消息），必须整窗重置；只有长度一致
				// 时才按 afterId 做尾部增量。
				if (length !== null && Number.isFinite(length) && length !== window.length) {
					return windowBody(true);
				}

				const afterIndex = messages.findIndex((message) => message.id === afterId);
				if (afterIndex === -1) return windowBody(true);

				if (afterIndex === messages.length - 1) {
					// 最后一条 id 相同：客户端带 version 时用它判断内容是否真的变化
					// （流式正文/thinking 会就地增长），只回传最后一条替换即可；
					// 未带 version 的旧客户端保持「不传消息体」的兼容行为。
					if (clientVersion === null || clientVersion === version) {
						return { ...base, reset: false, unchanged: true };
					}
					return {
						...base,
						messages: payload([messages[afterIndex]]),
						reset: false,
						unchanged: false,
					};
				}

				return {
					...base,
					messages: payload(messages.slice(afterIndex)),
					reset: false,
					unchanged: false,
				};
			},
			create: async (ctx) => {
				// 透传完整 CreateAgentInput：带 sessionPath 即「打开历史会话」，
				// 不带则新建会话；title/noSession/cwd 与桌面端共用同一语义。
				const body = await ctx.readJson<Partial<CreateAgentInput>>();
				if (!body.projectId) throw new WebApiError(400, "projectId 不能为空");
				await assertResumeTargetAllowed(deps, body);
				const agent = await deps.createAgent({
					projectId: body.projectId,
					title: body.title,
					sessionPath: body.sessionPath,
					noSession: body.noSession,
				});
				ctx.invalidateState();
				return { agent: toWebAgentView(agent) };
			},
			historyPage: async ({ params, url }) => {
				const limit = Number(url.searchParams.get("limit") ?? 40);
				const page = await deps.getHistoryPage(
					params.agentId,
					url.searchParams.get("before") ?? undefined,
					Number.isFinite(limit) ? limit : 40,
				);
				// 手机翻页同样只取折叠预览；展开时再按消息 id 拉完整内容。
				const compact = url.searchParams.get("compact") === "1";
				return compact
					? { ...page, messages: page.messages.map((message) => compactChatMessage(message)) }
					: page;
			},
			// 关闭会话（退役 pi 进程），不是「停止当前回合」；手机端「停止」走 abort。
			stop: async ({ params, invalidateState }) => {
				await deps.stopAgent(params.agentId);
				invalidateState();
				return { ok: true };
			},
			prompt: async (ctx) => {
				const body = await ctx.readJson<Omit<SendPromptInput, "agentId">>();
				const message = body.message?.trim() ?? "";
				if (!message && !body.images?.length) {
					throw new WebApiError(400, "message 或 images 不能为空");
				}
				const result = await deps.sendPrompt({
					...body,
					agentId: ctx.params.agentId,
					message,
				});
				ctx.invalidateState();
				// prompt endpoint is a transport for SendPromptResult. Semantic rejection is still
				// a successful HTTP exchange so browser clients can distinguish rejected from
				// post-write unknown instead of collapsing both into a thrown fetch error.
				// deliveryText：手机端发送后的「已排队/已接管」提示也由服务端派生，
				// 客户端不再各写一份中文投递文案。
				const delivery = deliveryKind(body.streamingBehavior);
				return { result: delivery ? { ...result, deliveryText: DELIVERY_LABELS[delivery] } : result };
			},
			// abort 只停止当前回合，保留 pi 进程和会话；/stop 才会关闭会话。
			// 手机聊天页的停止按钮走这里，不能复用 /stop。
			abort: async ({ params }) => {
				await deps.abortAgent(params.agentId);
				return { ok: true };
			},
			abortAndRestoreQueue: async ({ params, invalidateState }) => {
				const result = await deps.abortAndRestoreQueue(params.agentId);
				invalidateState();
				return { result };
			},
			removeQueuedMessage: async (ctx) => {
				const body = await ctx.readJson<{ message?: string; queue?: "steering" | "followUp" }>();
				if (typeof body.message !== "string" || !body.message) {
					throw new WebApiError(400, "message 不能为空");
				}
				if (body.queue !== "steering" && body.queue !== "followUp") {
					throw new WebApiError(400, "queue 必须是 steering 或 followUp");
				}
				const result = await deps.removeQueuedMessage(
					ctx.params.agentId,
					body.message,
					body.queue,
				);
				ctx.invalidateState();
				return { result };
			},
			promoteQueuedMessage: async (ctx) => {
				const body = await ctx.readJson<{ message?: string }>();
				if (typeof body.message !== "string" || !body.message) {
					throw new WebApiError(400, "message 不能为空");
				}
				const result = await deps.promoteQueuedMessage(ctx.params.agentId, body.message);
				ctx.invalidateState();
				return { result };
			},
			sendUiResponse: async (ctx) => {
				const body = await ctx.readJson<{
					requestId?: string;
					value?: string | boolean | null;
					cancelled?: boolean;
					confirmed?: boolean;
				}>();
				if (!body.requestId) throw new WebApiError(400, "requestId 不能为空");
				await deps.sendUiResponse(ctx.params.agentId, body.requestId, {
					value: body.value,
					cancelled: body.cancelled,
					confirmed: body.confirmed,
				});
				return { ok: true };
			},
			respondTrustRequest: async (ctx) => {
				const body = await ctx.readJson<{ choice?: "trust-remember" | "trust-session" | "deny" }>();
				if (!body.choice || !["trust-remember", "trust-session", "deny"].includes(body.choice)) {
					throw new WebApiError(400, "choice 无效");
				}
				await deps.respondTrustRequest(ctx.params.requestId, body.choice);
				return { ok: true };
			},
			runtimeState: async ({ params }) => {
				const agentId = params.agentId;
				const state = await deps.runtimeState(agentId);
				// 手机端头部副标题的状态文案由此派生：isStreaming 优先，其次 runtime 自带
				// 的 status（老版本主进程），最后回退 /api/state 的 agent 状态。
				const agentStatus = deps.listAgents().find((agent) => agent.id === agentId)?.status;
				const rawStatus =
					!state.isStreaming && "status" in state && typeof state.status === "string"
						? state.status
						: agentStatus;
				const status = state.isStreaming ? "running" : rawStatus;
				return {
					state: {
						...state,
						statusText: SESSION_STATUS_LABELS[sessionStatusKind(status)],
					},
				};
			},
			cycleModel: async ({ params, invalidateState }) => {
				const state = await deps.cycleModel(params.agentId);
				invalidateState();
				return { state };
			},
			availableModels: async ({ params }) => ({ models: await deps.availableModels(params.agentId) }),
			setModel: async (ctx) => {
				const body = await ctx.readJson<{ provider?: string; modelId?: string }>();
				const state = await deps.setModel(
					ctx.params.agentId,
					body.provider ?? "",
					body.modelId ?? "",
				);
				ctx.invalidateState();
				return { state };
			},
			refreshModels: async ({ params, invalidateState }) => {
				const state = await deps.refreshModels(params.agentId);
				invalidateState();
				return { state };
			},
			cycleThinking: async ({ params, invalidateState }) => {
				const state = await deps.cycleThinking(params.agentId);
				invalidateState();
				return { state };
			},
			setThinking: async (ctx) => {
				const body = await ctx.readJson<{ level?: string }>();
				const state = await deps.setThinking(ctx.params.agentId, body.level ?? "");
				ctx.invalidateState();
				return { state };
			},
			availableThinkingLevels: async ({ params }) => ({
				levels: await deps.availableThinkingLevels(params.agentId),
			}),
			setFastMode: async (ctx) => {
				const enabled = await readEnabled(ctx);
				const state = await deps.setFastMode(ctx.params.agentId, enabled);
				ctx.invalidateState();
				return { state };
			},
			setSlowMode: async (ctx) => {
				const enabled = await readEnabled(ctx);
				const state = await deps.setSlowMode(ctx.params.agentId, enabled);
				ctx.invalidateState();
				return { state };
			},
			setAutoCompaction: async (ctx) => {
				const enabled = await readEnabled(ctx);
				const state = await deps.setAutoCompaction(ctx.params.agentId, enabled);
				ctx.invalidateState();
				return { state };
			},
			setTodos: async (ctx) => {
				const body = await ctx.readJson<{ phases?: unknown }>();
				if (!Array.isArray(body.phases)) throw new WebApiError(400, "phases 必须是数组");
				const state = await deps.setTodos(ctx.params.agentId, body.phases as AgentTodoPhase[]);
				ctx.invalidateState();
				return { state };
			},
		},
	};
}

/** 三个开关端点共用同一份布尔校验，避免各自写一遍 400 文案。 */
async function readEnabled(ctx: WebApiContext): Promise<boolean> {
	const body = await ctx.readJson<{ enabled?: unknown }>();
	if (typeof body.enabled !== "boolean") throw new WebApiError(400, "enabled 必须是布尔值");
	return body.enabled;
}

/**
 * 表 → 扁平条目（声明顺序）。分发表是映射类型，值层没有可枚举的字符串键，
 * 故此处按 webRoutes 的键遍历再回查一次；这一处断言由
 * `WebApiHandlerTable` 的映射类型保证安全（每个键都存在）。
 */
export function flattenWebApiHandlers(table: WebApiHandlerTable): WebApiRouteEntry[] {
	const entries: WebApiRouteEntry[] = [];
	for (const [namespace, members] of Object.entries(webRoutes) as Array<
		[keyof typeof webRoutes, Record<string, WebRestRoute>]
	>) {
		const handlers = table[namespace] as unknown as Record<string, WebApiHandler>;
		for (const [member, route] of Object.entries(members)) {
			entries.push({ key: `${namespace}.${member}`, route, handler: handlers[member] });
		}
	}
	return entries;
}

/**
 * 单次请求的分发：命中第一条模板即执行，返回值交给传输层序列化。
 * 未命中返回 null（调用方决定落 404 还是静态资源）。
 */
export async function dispatchWebApi(
	entries: readonly WebApiRouteEntry[],
	method: string,
	url: URL,
	readJson: <T>() => Promise<T>,
	invalidateState: () => void,
): Promise<{ body: unknown } | null> {
	for (const entry of entries) {
		const params = matchWebRoute(entry.route, url.pathname, method);
		if (!params) continue;
		return { body: await entry.handler({ params, url, readJson, invalidateState }) };
	}
	return null;
}
