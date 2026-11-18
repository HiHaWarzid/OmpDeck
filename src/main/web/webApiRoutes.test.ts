import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { webRoutes, webRoutePathParams, webRouteUrl, type WebRestRoute } from "../../shared/ipc";
import type {
	AgentRuntimeState,
	AgentTab,
	ChatMessage,
	SendPromptResult,
} from "../../shared/types";
import { WebServiceManager } from "./WebServiceManager";

/**
 * 分发表 × webRoutes 的运行时奇偶校验。
 *
 * 「每条表内端点都有处理器」已经由 `WebApiHandlerTable` 的映射类型在编译期保证；
 * 这里守的是**接线**：处理器挂在表上，但 WebServiceManager 必须真的把请求分发过去。
 * 漏接（或把分发条件写错）的表现只有一个——请求落到 `/api/` 的 404 分支，而客户端
 * 从同一张表拼出的 URL 看起来完全合法。因此对每条端点发一次真请求，只断言
 * 「不是 404」：POST 走到校验层返回 415/400 也算通过，因为那已经证明分发发生了。
 */
type WebDeps = ConstructorParameters<typeof WebServiceManager>[0];

const agent: AgentTab = {
	id: "agent-1",
	projectId: "project-1",
	title: "测试会话",
	status: "idle",
	createdAt: 1,
} as AgentTab;

const messages: ChatMessage[] = [
	{ id: "m1", agentId: agent.id, role: "user", text: "hello", timestamp: 1 },
	{
		id: "m2",
		agentId: agent.id,
		role: "tool",
		text: "out",
		timestamp: 2,
		meta: { toolName: "bash" },
	},
];

const stubRuntimeState = async () => ({}) as unknown as AgentRuntimeState;

const deps: WebDeps = {
	listProjects: () => [{ id: "project-1", name: "项目一", path: "C:\\project" } as never],
	listAgents: () => [agent],
	listSessions: async () => [],
	getMessages: () => messages,
	createAgent: async () => agent,
	sendPrompt: async () => ({}) as unknown as SendPromptResult,
	stopAgent: async () => {},
	abortAgent: async () => {},
	sendUiResponse: async () => {},
	respondTrustRequest: async () => {},
	getHistoryPage: async () => ({ messages: [], nextCursor: null, hasMore: false }),
	readMessageFullText: async () => ({ text: "full" }),
	listTrustRequests: () => [],
	persistWebToken: async () => {},
	runtimeState: stubRuntimeState,
	cycleModel: stubRuntimeState,
	availableModels: async () => [],
	setModel: stubRuntimeState,
	refreshModels: stubRuntimeState,
	cycleThinking: stubRuntimeState,
	setThinking: stubRuntimeState,
	availableThinkingLevels: async () => [],
	setFastMode: stubRuntimeState,
	setSlowMode: stubRuntimeState,
	setAutoCompaction: stubRuntimeState,
	setTodos: stubRuntimeState,
	abortAndRestoreQueue: async () => ({}) as never,
	removeQueuedMessage: async () => ({}) as never,
	promoteQueuedMessage: async () => ({}) as never,
};

/** 路径参数填成真实存在的对象，避免处理器自己抛 404 掩盖「没分发」这个信号。 */
const PARAM_VALUES: Record<string, string> = {
	projectId: "project-1",
	agentId: agent.id,
	messageId: "m2",
	requestId: "request-1",
};

const HOST = "127.0.0.1";
let manager: WebServiceManager;
let baseUrl: string;

async function freePort(): Promise<number> {
	const probe = createServer();
	const listening = Promise.withResolvers<void>();
	probe.once("error", listening.reject);
	probe.listen(0, HOST, listening.resolve);
	await listening.promise;
	const address = probe.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const closed = Promise.withResolvers<void>();
	probe.close(() => closed.resolve());
	await closed.promise;
	return port;
}

/** 表内全部端点：key 供失败信息定位，route 供拼 URL 与取 method。 */
const ROUTES: Array<{ key: string; route: WebRestRoute }> = Object.entries(
	webRoutes as unknown as Record<string, Record<string, WebRestRoute>>,
).flatMap(([namespace, members]) =>
	Object.entries(members).map(([member, route]) => ({ key: `${namespace}.${member}`, route })),
);

beforeAll(async () => {
	const port = await freePort();
	manager = new WebServiceManager(deps, 50);
	await manager.applySettings({
		webServiceEnabled: true,
		webServiceHost: HOST,
		webServicePort: port,
	});
	baseUrl = `http://${HOST}:${port}`;
});

afterAll(async () => {
	await manager.stop();
});

describe("分发表接线", () => {
	test("webRoutes 里的每条端点都能分发到处理器（不是 404）", async () => {
		const notDispatched: string[] = [];
		for (const { key, route } of ROUTES) {
			const url = webRouteUrl(
				route,
				Object.fromEntries(
					webRoutePathParams(route.path).map((name) => [name, PARAM_VALUES[name] ?? "x"]),
				),
			);
			const response = await fetch(`${baseUrl}${url}`, { method: route.method });
			// 404 只可能来自「API 不存在」分支；处理器自身的 400/415 都说明接线成功。
			if (response.status === 404) {
				const body = await response.text();
				notDispatched.push(`${route.method} ${url}（${key}）→ ${body}`);
			}
			// 消费完响应体，避免 keep-alive 连接堆积影响后续请求。
			await response.arrayBuffer();
		}
		expect(
			notDispatched,
			`这些端点没有分发（客户端能拼出 URL，服务端却 404）: ${notDispatched.join(" | ")}`,
		).toEqual([]);
	});

	test("未知的 /api 路径仍然 404，且带错误信封", async () => {
		const response = await fetch(`${baseUrl}/api/agents/agent-1/not-a-route`);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "API 不存在" });
	});
});
