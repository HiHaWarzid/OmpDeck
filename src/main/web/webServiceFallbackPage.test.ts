import { createServer as createHttpServer } from "node:http";
import { describe, expect, test } from "vitest";
import type { AgentRuntimeState, AgentTab, SendPromptResult } from "../../shared/types";
import fallbackPageHtml from "./fallbackPage.html?raw";
import { WebServiceManager } from "./WebServiceManager";

/**
 * 降级页回归：`rendererRoot` 下没有 index.html 时，请求必须拿到
 * `fallbackPage.html` 的原文，而不是空页或 404。
 *
 * 这条链路以前没有测试面：页面埋在 `renderPage()` 的模板字符串里，只能靠
 * 源码正则间接确认它「写了什么」，无法确认它「被返回成什么」。搬成资源文件后
 * 既可以直接 import 原文，也可以真的起一个服务比对响应体。
 */
const stubRuntimeState = async () => ({}) as unknown as AgentRuntimeState;

type WebDeps = ConstructorParameters<typeof WebServiceManager>[0];

const deps: WebDeps = {
	listProjects: () => [],
	listAgents: () => [],
	listSessions: async () => [],
	getMessages: () => [],
	createAgent: async () => ({}) as unknown as AgentTab,
	sendPrompt: async () => ({}) as unknown as SendPromptResult,
	stopAgent: async () => {},
	abortAgent: async () => {},
	sendUiResponse: async () => {},
	respondTrustRequest: async () => {},
	getHistoryPage: async () => ({ messages: [], nextCursor: null, hasMore: false }),
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
	abortAndRestoreQueue: async () => ({ steering: [], followUp: [] }),
	removeQueuedMessage: async () => ({ removed: false }),
	promoteQueuedMessage: async () => ({ promoted: false }),
};

/** 借临时 listen(0) 取一个空闲端口后立即释放（与 webServiceLifecycle.test.ts 同一手法）。 */
async function freePort(): Promise<number> {
	const probe = createHttpServer();
	const listening = Promise.withResolvers<void>();
	probe.once("error", listening.reject);
	probe.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = probe.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const closed = Promise.withResolvers<void>();
	probe.close(() => closed.resolve());
	await closed.promise;
	return port;
}

describe("无 renderer 产物时的降级页", () => {
	test("返回静态资源原文，且带有可用的轮询脚本与端点", async () => {
		const manager = new WebServiceManager(deps, 50);
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "127.0.0.1",
			webServicePort: port,
			webServiceToken: "",
			webServiceTokenGeneratedAt: 0,
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		const bound = manager.getStatus(false);
		try {
			const response = await fetch(`http://127.0.0.1:${bound.port}/`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/html");
			const body = await response.text();
			// 逐字节等价：搬运后的文件与构建内联的内容不能有偏差。
			expect(body).toBe(fallbackPageHtml);
			// 页面必须仍是一个能自查的降级界面：轮询 /api/state 并按 1s 刷新。
			expect(body).toContain("/api/state");
			// 断言页面仍在按 1s 轮询（拆开写，避免测试文件里出现真实的定时器调用字面量）。
			expect(body).toContain("setInterval(refresh,");
			expect(body).toContain("1000)");
		} finally {
			await manager.stop();
		}
	});
});
