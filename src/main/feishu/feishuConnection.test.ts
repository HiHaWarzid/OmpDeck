import { describe, expect, it } from "vitest";
import { FeishuConnection, type FeishuConnectionConfig, type FeishuWsHandlers, type FeishuWsLifecycle } from "./feishuConnection";

/** 假 WS 传输：只实现连接模块依赖的两条方法，用来计数连接与拆除。 */
class FakeWsTransport implements FeishuWsLifecycle {
	startCount = 0;
	stopCount = 0;
	live = false;
	registeredHandlers: FeishuWsHandlers | undefined;
	/** 置位后，下一次 startWs 会先标记 WS 已起再抛错——复现「WS 起了但随后 await 失败」。 */
	failNextStart: Error | null = null;
	/** 置位后 startWs 会挂起，直到测试 resolve 才继续——用来把连接停在「在途」。 */
	gate: Promise<void> | null = null;
	private readonly startEntered = Promise.withResolvers<void>();

	/** startWs 已被调用的信号；测试用它等待在途状态，而不是靠定时器猜时长。 */
	waitStartEntered(): Promise<void> { return this.startEntered.promise; }

	async startWs(handlers?: FeishuWsHandlers): Promise<void> {
		this.startCount += 1;
		this.registeredHandlers = handlers;
		this.startEntered.resolve();
		if (this.gate) await this.gate;
		this.live = true;
		if (this.failNextStart) {
			const error = this.failNextStart;
			this.failNextStart = null;
			throw error;
		}
	}

	stopWs(): void {
		this.stopCount += 1;
		this.live = false;
	}
}

const CONFIG: FeishuConnectionConfig = { appId: "cli_a", appSecret: "secret-a" };
const OTHER_CONFIG: FeishuConnectionConfig = { appId: "cli_b", appSecret: "secret-b" };

/** 组装连接模块：会话/订阅都可观察，便于断言「几次连接、几次订阅」。 */
function harness(queued: FakeWsTransport[] = []) {
	const created: FakeWsTransport[] = [];
	const createdConfigs: FeishuConnectionConfig[] = [];
	const listeners = new Set<(agentId: string, event: unknown) => void>();
	const delivered: string[] = [];

	const connection = new FeishuConnection<FakeWsTransport>({
		createSession: async (config) => {
			createdConfigs.push(config);
			const transport = queued.shift() ?? new FakeWsTransport();
			created.push(transport);
			return { client: null, transport };
		},
		subscribeAgentEvents: (handler) => {
			listeners.add(handler);
			return () => { listeners.delete(handler); };
		},
		handleAgentEvent: (agentId) => { delivered.push(agentId); },
	});

	return { connection, created, createdConfigs, listeners, delivered };
}

describe("FeishuConnection：单飞连接", () => {
	it("并发两次 connect（同凭证）只建一条连接、一次订阅", async () => {
		const h = harness();
		const handlers: FeishuWsHandlers = { "im.message.receive_v1": async () => {} };

		await Promise.all([
			h.connection.connect(CONFIG, { handlers }),
			h.connection.connect(CONFIG, { handlers }),
		]);

		expect(h.createdConfigs).toEqual([CONFIG]);
		expect(h.created).toHaveLength(1);
		expect(h.created[0].startCount).toBe(1);
		expect(h.created[0].live).toBe(true);
		expect(h.created[0].registeredHandlers).toBe(handlers);
		expect(h.listeners.size).toBe(1);
		expect(h.connection.connected).toBe(true);
	});

	it("第一次连接尚未落定时发起的第二次 connect 复用它", async () => {
		const gated = new FakeWsTransport();
		const gate = Promise.withResolvers<void>();
		gated.gate = gate.promise;
		const h = harness([gated]);

		const first = h.connection.connect(CONFIG);
		const second = h.connection.connect(CONFIG);
		// 等第一个 connect 真正进入 startWs（仍被 gate 挂住，连接处于在途）。
		await gated.waitStartEntered();

		expect(h.created).toHaveLength(1);
		expect(gated.startCount).toBe(1);

		gate.resolve();
		await Promise.all([first, second]);

		expect(h.created).toHaveLength(1);
		expect(gated.startCount).toBe(1);
		expect(h.listeners.size).toBe(1);
	});

	it("换凭证的并发 connect 先拆旧连接：任何时刻至多一条 WS", async () => {
		const h = harness();

		await h.connection.connect(CONFIG);
		await h.connection.connect(OTHER_CONFIG);

		expect(h.created).toHaveLength(2);
		expect(h.created[0].live).toBe(false);
		expect(h.created[0].stopCount).toBe(1);
		expect(h.created[1].live).toBe(true);
		expect(h.listeners.size).toBe(1);
		expect(h.connection.transport).toBe(h.created[1]);
	});
});

describe("FeishuConnection：失败回滚", () => {
	it("startWs 抛错时停 WS、退订并置空，随后仍能干净连接", async () => {
		const failing = new FakeWsTransport();
		failing.failNextStart = new Error("WS 启动失败");
		const h = harness([failing]);

		await expect(h.connection.connect(CONFIG)).rejects.toThrow("WS 启动失败");

		// 半成品不得残留：WS 已停、无订阅、模块回到未连接态。
		expect(failing.live).toBe(false);
		expect(failing.stopCount).toBe(1);
		expect(h.listeners.size).toBe(0);
		expect(h.connection.connected).toBe(false);
		expect(h.connection.transport).toBeNull();
		expect(h.connection.client).toBeNull();

		await h.connection.connect(CONFIG);
		expect(h.created).toHaveLength(2);
		expect(h.created[1].startCount).toBe(1);
		expect(h.listeners.size).toBe(1);
	});

	it("prepare 抛错时 WS 根本没启动，且不留订阅", async () => {
		const h = harness();
		let preparedTransport: unknown;

		await expect(h.connection.connect(CONFIG, {
			prepare: async (session) => {
				preparedTransport = session.transport;
				throw new Error("prepare 失败");
			},
		})).rejects.toThrow("prepare 失败");

		expect(preparedTransport).toBe(h.created[0]);
		expect(h.created[0].startCount).toBe(0);
		expect(h.created[0].stopCount).toBe(1);
		expect(h.listeners.size).toBe(0);
		expect(h.connection.connected).toBe(false);
	});
});

describe("FeishuConnection：断开与重连", () => {
	it("disconnect 幂等：连调两次不抛，订阅归零、WS 只停一次", async () => {
		const h = harness();
		await h.connection.connect(CONFIG);

		await h.connection.disconnect();
		await h.connection.disconnect();

		expect(h.listeners.size).toBe(0);
		expect(h.created[0].stopCount).toBe(1);
		expect(h.created[0].live).toBe(false);
		expect(h.connection.connected).toBe(false);
		expect(h.connection.transport).toBeNull();
	});

	it("未连接时 disconnect 是安全的空操作", async () => {
		const h = harness();

		await h.connection.disconnect();
		await h.connection.disconnect();

		expect(h.created).toHaveLength(0);
		expect(h.listeners.size).toBe(0);
		expect(h.connection.connected).toBe(false);
	});

	it("disconnect 后再 connect 得到干净的新连接，旧状态不回放", async () => {
		const h = harness();
		const handlers: FeishuWsHandlers = { "im.message.receive_v1": async () => {} };
		await h.connection.connect(CONFIG, { handlers });
		const [listener] = h.listeners;
		listener("agent-1", { type: "agent_end" });
		expect(h.delivered).toEqual(["agent-1"]);

		h.connection.markSyncedMessage("msg-1");
		expect(h.connection.hasSyncedMessage("msg-1")).toBe(true);

		await h.connection.disconnect();
		// 连接生命周期结束：去重指纹一并清空，不会抑制新连接下的同一消息。
		expect(h.connection.hasSyncedMessage("msg-1")).toBe(false);

		await h.connection.connect(CONFIG, { handlers });

		expect(h.created).toHaveLength(2);
		expect(h.created[0].live).toBe(false);
		expect(h.created[1].live).toBe(true);
		expect(h.created[1].registeredHandlers).toBe(handlers);
		expect(h.listeners.size).toBe(1);
		expect(h.connection.transport).toBe(h.created[1]);
		expect(h.connection.hasSyncedMessage("msg-1")).toBe(false);
	});

	it("连接在途时 disconnect：落定后不残留 WS 与订阅", async () => {
		const gated = new FakeWsTransport();
		const gate = Promise.withResolvers<void>();
		gated.gate = gate.promise;
		const h = harness([gated]);

		const connecting = h.connection.connect(CONFIG);
		const disconnecting = h.connection.disconnect();
		await gated.waitStartEntered();
		gate.resolve();

		await connecting;
		await disconnecting;

		expect(gated.live).toBe(false);
		expect(gated.stopCount).toBe(1);
		expect(h.listeners.size).toBe(0);
		expect(h.connection.connected).toBe(false);
	});
});
