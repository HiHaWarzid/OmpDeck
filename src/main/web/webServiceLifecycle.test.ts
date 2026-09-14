import { Agent as HttpAgent, createServer as createHttpServer, get as httpGet, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import type { AgentRuntimeState, AgentTab, SendPromptResult } from "../../shared/types";
import { WebServiceManager } from "./WebServiceManager";

// 生命周期回归：真实 node:http 在 127.0.0.1 上起服务，覆盖三条实锤缺陷
//  1) apply 换端口先绑定新端口、绑定失败旧服务必须原样存活；
//  2) keep-alive 连接（内嵌页面 600ms 轮询）挂着时 stop 必须有限期 settle；
//  3) apply 成功后端口真的迁移。
// 有界性用 vitest 的 test timeout 判定：旧实现里 stop 永不 settle，会直接把用例挂到超时。
// deps 只在 /api/* 业务端点用到，生命周期用例走 /api/health，故全部为桩。

type WebDeps = ConstructorParameters<typeof WebServiceManager>[0];

const stubRuntimeState = async () => ({}) as unknown as AgentRuntimeState;

const deps: WebDeps = {
	listProjects: () => [],
	listAgents: () => [],
	listSessions: async () => [],
	getMessages: () => [],
	createAgent: async () => ({}) as unknown as AgentTab,
	sendPrompt: async () => ({}) as unknown as SendPromptResult,
	stopAgent: async () => {},
	runtimeState: stubRuntimeState,
	cycleModel: stubRuntimeState,
	availableModels: async () => [],
	setModel: stubRuntimeState,
	refreshModels: stubRuntimeState,
	cycleThinking: stubRuntimeState,
	setThinking: stubRuntimeState,
};

const HOST = "127.0.0.1";

/** 借临时 listen(0) 取一个空闲端口后立即释放；测试间端口不冲突即可 */
async function freePort(): Promise<number> {
	const probe = createHttpServer();
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

/** 占位服务：模拟目标端口已被别的进程占用 */
async function occupy(port: number): Promise<Server> {
	const server = createHttpServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("occupant");
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(port, HOST, listening.resolve);
	await listening.promise;
	return server;
}

async function closeServer(server: Server): Promise<void> {
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	server.closeAllConnections();
	await closed.promise;
}

async function health(port: number) {
	const response = await fetch(`http://${HOST}:${port}/api/health`);
	return (await response.json()) as { ok: boolean; host: string; port: number };
}

/** 用 keep-alive agent 发一次完整请求，响应读完后 socket 回到服务端空闲连接池 */
function getKeepAlive(port: number, agent: HttpAgent): Promise<void> {
	const done = Promise.withResolvers<void>();
	httpGet({ host: HOST, port, path: "/api/health", agent }, (response) => {
		response.resume();
		response.once("end", done.resolve);
	}).once("error", done.reject);
	return done.promise;
}

describe("WebServiceManager 生命周期", () => {
	test("apply 到被占用端口失败：如实报错且原服务继续服务", async () => {
		const livePort = await freePort();
		const occupiedPort = await freePort();
		const occupant = await occupy(occupiedPort);
		const manager = new WebServiceManager(deps, 50);
		try {
			await manager.applySettings({ webServiceEnabled: true, webServiceHost: HOST, webServicePort: livePort });
			expect((await health(livePort)).ok).toBe(true);

			await expect(
				manager.applySettings({ webServiceEnabled: true, webServiceHost: HOST, webServicePort: occupiedPort }),
			).rejects.toThrow(/EADDRINUSE/);

			// 旧 server 未被 stop、旧端口仍可响应；占用端口仍是占用者的响应
			expect((await health(livePort)).port).toBe(livePort);
			const occupiedResponse = await fetch(`http://${HOST}:${occupiedPort}/`);
			expect(await occupiedResponse.text()).toBe("occupant");
			// 上层据此区分「新端口起不来」与「确实没有任何服务」，不误停正在工作的服务
			expect(manager.isRunning()).toBe(true);
		} finally {
			await manager.stop();
			expect(manager.isRunning()).toBe(false);
			await closeServer(occupant);
		}
	});

	test("keep-alive 空闲连接挂着时 stop 在有界时间内 settle", { timeout: 2000 }, async () => {
		const port = await freePort();
		const manager = new WebServiceManager(deps, 100);
		await manager.applySettings({ webServiceEnabled: true, webServiceHost: HOST, webServicePort: port });
		const agent = new HttpAgent({ keepAlive: true });
		try {
			await getKeepAlive(port, agent);
			expect(manager.isRunning()).toBe(true);
			// 不 settle 就在 test timeout 内失败（旧实现即如此）
			await manager.stop();
			expect(manager.isRunning()).toBe(false);
			await expect(health(port)).rejects.toThrow();
		} finally {
			agent.destroy();
		}
	});

	test("存在未完成请求的活跃连接时，stop 仍在有界时间内强断 settle", { timeout: 2000 }, async () => {
		const port = await freePort();
		const manager = new WebServiceManager(deps, 100);
		await manager.applySettings({ webServiceEnabled: true, webServiceHost: HOST, webServicePort: port });
		const socket = connect({ host: HOST, port });
		try {
			await once(socket, "connect");
			// 故意不发完整的请求头：服务端视为活跃连接（非空闲），只能靠宽限期后的强断收口
			socket.write(`GET /api/health HTTP/1.1\r\nHost: ${HOST}\r\n`);
			await manager.stop();
			await expect(health(port)).rejects.toThrow();
		} finally {
			socket.destroy();
		}
	});

	test("apply 成功后端口真的切换：新端口响应、旧端口不再响应", async () => {
		const oldPort = await freePort();
		const newPort = await freePort();
		const manager = new WebServiceManager(deps, 50);
		try {
			await manager.applySettings({ webServiceEnabled: true, webServiceHost: HOST, webServicePort: oldPort });
			expect((await health(oldPort)).ok).toBe(true);

			await manager.applySettings({ webServiceEnabled: true, webServiceHost: HOST, webServicePort: newPort });

			const migrated = await health(newPort);
			expect(migrated.ok).toBe(true);
			expect(migrated.port).toBe(newPort);
			await expect(health(oldPort)).rejects.toThrow();
		} finally {
			await manager.stop();
		}
	});
});
