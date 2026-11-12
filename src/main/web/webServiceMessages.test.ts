import { createServer, get as httpGet } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
	AgentRuntimeState,
	AgentTab,
	ChatMessage,
	SendPromptInput,
	SendPromptResult,
	SessionSummary,
} from "../../shared/types";
import { WebServiceManager } from "./WebServiceManager";

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
		text: "x".repeat(2048),
		timestamp: 2,
		meta: { toolName: "bash" },
	},
	{
		id: "m3",
		agentId: agent.id,
		role: "assistant",
		text: "done",
		timestamp: 3,
		thinking: "t".repeat(2048),
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
	readMessageFullText: async (_agentId, messageId, entryId) => {
		if (messageId !== "m2") throw new Error("unavailable");
		return { text: `full:${entryId ?? ""}` };
	},
	listTrustRequests: () => [],
	persistWebToken: async () => {},
	runtimeState: stubRuntimeState,
	cycleModel: stubRuntimeState,
	availableModels: async () => [],
	setModel: stubRuntimeState,
	refreshModels: stubRuntimeState,
	cycleThinking: stubRuntimeState,
	setThinking: stubRuntimeState,
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

function rawGet(path: string, headers: Record<string, string> = {}) {
	return new Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>(
		(resolve, reject) => {
			const request = httpGet(`${baseUrl}${path}`, { headers }, (response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.once("end", () =>
					resolve({ headers: response.headers, body: Buffer.concat(chunks) }),
				);
			});
			request.once("error", reject);
		},
	);
}

async function getJson(path: string, headers: Record<string, string> = {}) {
	const response = await fetch(`${baseUrl}${path}`, { headers });
	return {
		response,
		data: (await response.json()) as Record<string, unknown>,
	};
}

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

describe("手机端消息增量契约", () => {
	test("聊天页停止走 abort，只有显式关闭才走 stop", async () => {
		const calls: string[] = [];
		const originalAbort = deps.abortAgent;
		const originalStop = deps.stopAgent;
		deps.abortAgent = async (agentId) => {
			calls.push(`abort:${agentId}`);
		};
		deps.stopAgent = async (agentId) => {
			calls.push(`stop:${agentId}`);
		};
		try {
			const abort = await fetch(`${baseUrl}/api/agents/agent-1/abort`, { method: "POST" });
			expect(abort.status).toBe(200);
			const stop = await fetch(`${baseUrl}/api/agents/agent-1/stop`, { method: "POST" });
			expect(stop.status).toBe(200);
			expect(calls).toEqual(["abort:agent-1", "stop:agent-1"]);
		} finally {
			deps.abortAgent = originalAbort;
			deps.stopAgent = originalStop;
		}
	});

	test("light 状态不携带 messagesByAgent", async () => {
		const { data } = await getJson("/api/state?light=1");
		expect(data.projects).toBeTruthy();
		expect(data.agents).toBeTruthy();
		expect(data).not.toHaveProperty("messagesByAgent");
	});

	test("sessions 接口可按 topLevel 过滤子会话", async () => {
		const original = deps.listSessions;
		const top = {
			filePath: "C:/sessions/top.jsonl",
			preview: "顶层会话",
			updatedAt: 1,
			messageCount: 1,
		} as SessionSummary;
		const child = {
			...top,
			filePath: "C:/sessions/child.jsonl",
			parentSessionPath: top.filePath,
		} as SessionSummary;
		const codexChild = {
			...top,
			filePath: "C:/sessions/codex-child.jsonl",
			codexParentThreadId: "thread-1",
			codexThreadSource: "subagent",
		} as SessionSummary;
		deps.listSessions = async () => [top, child, codexChild];
		try {
			const all = await getJson("/api/projects/project-1/sessions");
			expect(all.data.sessions).toHaveLength(3);

			const filtered = await getJson("/api/projects/project-1/sessions?topLevel=1");
			expect(filtered.data.sessions).toEqual([top]);
		} finally {
			deps.listSessions = original;
		}
	});

	test("tail 限制窗口条数并返回内容版本", async () => {
		const { data } = await getJson("/api/agents/agent-1/messages?tail=2");
		expect((data.messages as ChatMessage[]).map((message) => message.id)).toEqual(["m2", "m3"]);
		expect(data.total).toBe(3);
		expect(data.tail).toBe(2);
		expect(data.reset).toBe(false);
		expect(data.unchanged).toBe(false);
		expect(typeof data.version).toBe("string");
	});

	test("afterId 命中时只返回尾部增量", async () => {
		const { data } = await getJson(
			"/api/agents/agent-1/messages?tail=2&afterId=m2&length=2",
		);
		expect((data.messages as ChatMessage[]).map((message) => message.id)).toEqual(["m2", "m3"]);
		expect(data.reset).toBe(false);
		expect(data.unchanged).toBe(false);
	});

	test("afterId 是最后一条且长度一致时返回 unchanged 且不传消息体", async () => {
		const { data } = await getJson(
			"/api/agents/agent-1/messages?tail=2&afterId=m3&length=2",
		);
		expect(data.unchanged).toBe(true);
		expect(data).not.toHaveProperty("messages");
	});

	test("末条版本变化时回传最后一条，供流式正文/thinking 就地更新", async () => {
		const current = await getJson("/api/agents/agent-1/messages?tail=2");
		const version = String(current.data.version);

		const changed = await getJson(
			`/api/agents/agent-1/messages?tail=2&afterId=m3&length=2&version=stale`,
		);
		expect(changed.data.unchanged).toBe(false);
		expect((changed.data.messages as ChatMessage[]).map((message) => message.id)).toEqual(["m3"]);

		const same = await getJson(
			`/api/agents/agent-1/messages?tail=2&afterId=m3&length=2&version=${encodeURIComponent(version)}`,
		);
		expect(same.data.unchanged).toBe(true);
		expect(same.data).not.toHaveProperty("messages");
	});

	test("客户端窗口长度不一致时整窗 reset", async () => {
		const { data } = await getJson(
			"/api/agents/agent-1/messages?tail=2&afterId=m2&length=1",
		);
		expect(data.reset).toBe(true);
		expect((data.messages as ChatMessage[]).map((message) => message.id)).toEqual(["m2", "m3"]);
	});

	test("afterId 找不到时整窗 reset", async () => {
		const { data } = await getJson(
			"/api/agents/agent-1/messages?tail=2&afterId=missing&length=2",
		);
		expect(data.reset).toBe(true);
		expect((data.messages as ChatMessage[]).map((message) => message.id)).toEqual(["m2", "m3"]);
	});

	test("compact 裁剪 tool 文本和 thinking，并保留完整内容详情", async () => {
		const { data } = await getJson("/api/agents/agent-1/messages?tail=40&compact=1");
		const list = data.messages as ChatMessage[];
		const tool = list.find((message) => message.id === "m2")!;
		const assistant = list.find((message) => message.id === "m3")!;
		expect(tool.text).toHaveLength(1024);
		expect(tool.meta).toMatchObject({ hasMore: true, fullLength: 2048 });
		expect(assistant.thinking).toHaveLength(800);
		expect(assistant.meta).toMatchObject({ thinkingHasMore: true, fullThinkingLength: 2048 });

		const detail = await getJson("/api/agents/agent-1/messages/m2");
		expect(detail.data.message).toMatchObject({ id: "m2", text: messages[1].text });
	});

	test("history-page 的 compact 同样裁剪折叠内容", async () => {
		const original = deps.getHistoryPage;
		deps.getHistoryPage = async () => ({ messages, nextCursor: null, hasMore: false });
		try {
			const { data } = await getJson(
				"/api/agents/agent-1/history-page?limit=40&compact=1",
			);
			const list = data.messages as ChatMessage[];
			expect(list.find((message) => message.id === "m2")?.text).toHaveLength(1024);
			expect(list.find((message) => message.id === "m3")?.thinking).toHaveLength(800);
			expect(data.nextCursor).toBeNull();
		} finally {
			deps.getHistoryPage = original;
		}
	});

	test("不存在的消息详情返回 404", async () => {
		const { response } = await getJson("/api/agents/agent-1/messages/missing");
		expect(response.status).toBe(404);
	});

	test("工具全文按 entryId 读取，找不到时返回 404", async () => {
		const full = await getJson("/api/agents/agent-1/messages/m2/full-text?entryId=entry-2");
		expect(full.response.status).toBe(200);
		expect(full.data).toEqual({ text: "full:entry-2" });

		const missing = await getJson("/api/agents/agent-1/messages/m9/full-text");
		expect(missing.response.status).toBe(404);
	});

	test("prompt 透传图片与排队语义", async () => {
		const original = deps.sendPrompt;
		let captured: SendPromptInput | undefined;
		deps.sendPrompt = async (input) => {
			captured = input;
			return { accepted: true };
		};
		try {
			const response = await fetch(`${baseUrl}/api/agents/agent-1/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					message: "看看这张图",
					images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
					streamingBehavior: "followUp",
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ result: { accepted: true } });
			expect(captured).toEqual({
				agentId: "agent-1",
				message: "看看这张图",
				images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				streamingBehavior: "followUp",
			});
			const imageOnly = await fetch(`${baseUrl}/api/agents/agent-1/prompt`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					message: "",
					images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				}),
			});
			expect(imageOnly.status).toBe(200);
			expect(captured).toEqual({
				agentId: "agent-1",
				message: "",
				images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			});
		} finally {
			deps.sendPrompt = original;
		}
	});

	test("大响应带 gzip 编码", async () => {
		const response = await rawGet("/api/state", { "accept-encoding": "gzip" });
		expect(response.headers["content-encoding"]).toBe("gzip");
		expect(JSON.parse(gunzipSync(response.body).toString("utf8"))).toHaveProperty(
			"messagesByAgent",
		);
	});

	test("带转发头的请求仍要求令牌", async () => {
		const response = await fetch(`${baseUrl}/api/agents/agent-1/messages?tail=2`, {
			headers: { "x-forwarded-for": "100.64.0.2" },
		});
		expect(response.status).toBe(401);
	});
});
