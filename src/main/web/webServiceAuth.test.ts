import { createServer, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import type { AgentRuntimeState, AgentTab, CreateAgentInput, SendPromptResult } from "../../shared/types";
import { WebServiceManager } from "./WebServiceManager";

// 用真实局域网地址访问 0.0.0.0 监听：socket.remoteAddress 不是回环，
// 才能覆盖「手机必须带令牌」的主路径；CI 无网卡时跳过。
const stubRuntimeState = async () => ({}) as unknown as AgentRuntimeState;

function lanAddress(): string | null {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return null;
}

async function freePort(): Promise<number> {
	const probe = createServer();
	const listening = Promise.withResolvers<void>();
	probe.once("error", listening.reject);
	probe.listen(0, "0.0.0.0", listening.resolve);
	await listening.promise;
	const address = probe.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const closed = Promise.withResolvers<void>();
	probe.close(() => closed.resolve());
	await closed.promise;
	return port;
}

type WebDeps = ConstructorParameters<typeof WebServiceManager>[0];

function createManager(overrides: Partial<WebDeps> = {}) {
	return new WebServiceManager({
		listProjects: () => [],
		listAgents: () => [],
		listSessions: async () => [],
		getMessages: () => [],
		createAgent: async () => ({}) as unknown as AgentTab,
		sendPrompt: async () => ({}) as unknown as SendPromptResult,
		stopAgent: async () => {},
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
		...overrides,
	}, 50);
}

const lan = lanAddress();

describe.skipIf(!lan)("web service token gate", () => {
	test("rejects missing token and accepts the configured token over LAN", async () => {
		const token = "omp_integration_token";
		const manager = createManager();
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "0.0.0.0",
			webServicePort: port,
			webServiceToken: token,
			webServiceTokenGeneratedAt: Date.now(),
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		const status = manager.getStatus(false);
		const baseUrl = `http://${lan}:${status.port}`;
		try {
			const denied = await fetch(`${baseUrl}/api/state`);
			expect(denied.status).toBe(401);
			const deniedBody = (await denied.json()) as { error?: string; code?: string };
			expect(deniedBody.code).toBe("token_missing");

			const allowed = await fetch(`${baseUrl}/api/state`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(allowed.status).toBe(200);
			const state = (await allowed.json()) as { projects?: unknown[]; trustRequests?: unknown[] };
			expect(Array.isArray(state.projects)).toBe(true);
			expect(Array.isArray(state.trustRequests)).toBe(true);

			const wrongOrigin = await fetch(`${baseUrl}/api/agents`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					origin: "http://evil.example",
				},
				body: JSON.stringify({ projectId: "p1" }),
			});
			expect(wrongOrigin.status).toBe(403);
		} finally {
			await manager.stop();
		}
	});

	test("POST /api/agents forwards sessionPath so a history session is resumed", async () => {
		const calls: CreateAgentInput[] = [];
		const manager = createManager({
			listProjects: () => [{ id: "p1" } as never],
			listSessions: async () => [{ filePath: "C:/sessions/history.jsonl" } as never],
			createAgent: async (input) => {
				calls.push(input);
				return { id: "agent-1" } as unknown as AgentTab;
			},
		});
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "0.0.0.0",
			webServicePort: port,
			webServiceToken: "omp_session_token",
			webServiceTokenGeneratedAt: Date.now(),
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		try {
			const response = await fetch(`http://${lan}:${port}/api/agents`, {
				method: "POST",
				headers: {
					authorization: "Bearer omp_session_token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					projectId: "p1",
					sessionPath: "C:/sessions/history.jsonl",
					title: "History",
					noSession: false,
				}),
			});
			expect(response.status).toBe(200);
			expect(calls).toEqual([
				{
					projectId: "p1",
					sessionPath: "C:/sessions/history.jsonl",
					title: "History",
					noSession: false,
				},
			]);
		} finally {
			await manager.stop();
		}
	});

	test("POST /api/agents rejects cwd and sessions outside the project", async () => {
		const calls: CreateAgentInput[] = [];
		const manager = createManager({
			listProjects: () => [{ id: "p1" } as never],
			listSessions: async () => [{ filePath: "C:/sessions/inside.jsonl" } as never],
			createAgent: async (input) => {
				calls.push(input);
				return { id: "agent-1" } as unknown as AgentTab;
			},
		});
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "0.0.0.0",
			webServicePort: port,
			webServiceToken: "omp_validation_token",
			webServiceTokenGeneratedAt: Date.now(),
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		const post = (body: Record<string, unknown>) =>
			fetch(`http://${lan}:${port}/api/agents`, {
				method: "POST",
				headers: {
					authorization: "Bearer omp_validation_token",
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		try {
			const cwdResponse = await post({ projectId: "p1", cwd: "C:/work" });
			expect(cwdResponse.status).toBe(400);
			expect(((await cwdResponse.json()) as { code?: string }).code).toBe("cwd_not_allowed");

			const foreignResponse = await post({
				projectId: "p1",
				sessionPath: "C:/sessions/outside.jsonl",
			});
			expect(foreignResponse.status).toBe(400);
			expect(((await foreignResponse.json()) as { code?: string }).code).toBe(
				"session_path_not_found",
			);

			const relativeResponse = await post({ projectId: "p1", sessionPath: "history.jsonl" });
			expect(relativeResponse.status).toBe(400);
			expect(((await relativeResponse.json()) as { code?: string }).code).toBe(
				"session_path_invalid",
			);
			expect(calls).toEqual([]);
		} finally {
			await manager.stop();
		}
	});

	test("GET /api/agents/:id/messages forwards the message dependency", async () => {
		const manager = createManager({
			getMessages: (agentId) => [
				{ id: "m1", role: "user", content: `hello ${agentId}` } as never,
			],
		});
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "0.0.0.0",
			webServicePort: port,
			webServiceToken: "omp_messages_token",
			webServiceTokenGeneratedAt: Date.now(),
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		try {
			const response = await fetch(`http://${lan}:${port}/api/agents/agent-1/messages`, {
				headers: { authorization: "Bearer omp_messages_token" },
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { messages: Array<{ content?: string }> };
			expect(body.messages[0]?.content).toBe("hello agent-1");
		} finally {
			await manager.stop();
		}
	});

	test("light state omits message bodies for the mobile shell", async () => {
		const manager = createManager({
			listProjects: () => [{ id: "p1" } as never],
			listAgents: () => [{ id: "agent-1", projectId: "p1" } as never],
			getMessages: () => [{ id: "m1", text: "x".repeat(4096) } as never],
		});
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "0.0.0.0",
			webServicePort: port,
			webServiceToken: "omp_light_token",
			webServiceTokenGeneratedAt: Date.now(),
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		try {
			const response = await fetch(`http://${lan}:${port}/api/state?light=1`, {
				headers: { authorization: "Bearer omp_light_token" },
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			expect(Object.keys(body).sort()).toEqual(["agents", "projects"]);
		} finally {
			await manager.stop();
		}
	});

	test("messages tail window is gzipped for slow mobile links", async () => {
		const allMessages = Array.from({ length: 50 }, (_, index) => ({
			id: `m${index}`,
			agentId: "agent-1",
			role: "user",
			text: "x".repeat(120),
			timestamp: index,
		}));
		const manager = createManager({ getMessages: () => allMessages as never });
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "0.0.0.0",
			webServicePort: port,
			webServiceToken: "omp_tail_token",
			webServiceTokenGeneratedAt: Date.now(),
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		try {
			const result = await new Promise<{
				status: number;
				headers: Record<string, string | string[] | undefined>;
				body: Buffer;
			}>((resolve, reject) => {
				const request = httpRequest(
					{
						hostname: lan,
						port,
						path: "/api/agents/agent-1/messages?tail=10",
						headers: {
							authorization: "Bearer omp_tail_token",
							"accept-encoding": "gzip",
						},
					},
					(response) => {
						const chunks: Buffer[] = [];
						response.on("data", (chunk: Buffer) => chunks.push(chunk));
						response.on("end", () =>
							resolve({
								status: response.statusCode ?? 0,
								headers: response.headers,
								body: Buffer.concat(chunks),
							}),
						);
					},
				);
				request.on("error", reject);
				request.end();
			});
			expect(result.status).toBe(200);
			expect(result.headers["content-encoding"]).toBe("gzip");
			const body = JSON.parse(gunzipSync(result.body).toString("utf8")) as {
				messages: Array<{ id: string }>;
				total: number;
				tail: number;
			};
			expect(body.total).toBe(50);
			expect(body.tail).toBe(10);
			expect(body.messages.map((message) => message.id)).toEqual(
				Array.from({ length: 10 }, (_, index) => `m${index + 40}`),
			);
		} finally {
			await manager.stop();
		}
	});

	test("does not exempt a non-IP Host from the token gate (DNS rebinding)", async () => {
		const manager = createManager();
		const port = await freePort();
		await manager.applySettings({
			webServiceEnabled: true,
			webServiceHost: "0.0.0.0",
			webServicePort: port,
			webServiceToken: "omp_host_token",
			webServiceTokenGeneratedAt: Date.now(),
			webServiceTokenExpiresAt: null,
			webServiceTokenTtlDays: 0,
		});
		try {
			// Node fetch 会覆盖 Host 头，DNS rebinding 场景必须用原始 HTTP 请求模拟。
			// 攻击页面没有令牌；Host 不是 IP/localhost 时不能再享受回环免令牌。
			const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
				const request = httpRequest(
					{
						hostname: lan,
						port,
						path: "/api/state",
						headers: { host: "evil.example" },
					},
					(response) => {
						const chunks: Buffer[] = [];
						response.on("data", (chunk: Buffer) => chunks.push(chunk));
						response.on("end", () =>
							resolve({
								status: response.statusCode ?? 0,
								body: Buffer.concat(chunks).toString("utf8"),
							}),
						);
					},
				);
				request.on("error", reject);
				request.end();
			});
			expect(result.status).toBe(401);
			expect((JSON.parse(result.body) as { code?: string }).code).toBe("token_missing");

			// 隧道域名（Tailscale/Cloudflare）不是 IP，但带令牌仍应可用。
			const tunnelStatus = await new Promise<number>((resolve, reject) => {
				const request = httpRequest(
					{
						hostname: lan,
						port,
						path: "/api/state",
						headers: { host: "omp.example.ts.net", authorization: "Bearer omp_host_token" },
					},
					(response) => {
						response.resume();
						resolve(response.statusCode ?? 0);
					},
				);
				request.on("error", reject);
				request.end();
			});
			expect(tunnelStatus).toBe(200);
		} finally {
			await manager.stop();
		}
	});
});
