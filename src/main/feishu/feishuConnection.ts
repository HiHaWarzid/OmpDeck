/**
 * FeishuConnection — 单个飞书连接生命周期的唯一属主（单飞）
 *
 * 为什么单独成模块：连接状态此前散在 FeishuBridge 的十几个字段、FeishuTransport
 * 与 feishuHandlers 的调用顺序里。两次并发 connect 时，第二次会在第一次仍卡在
 * lark 动态 import 期间把它 stop 掉——那时它既没有 WS 可停、也没有订阅可退；
 * 第一次恢复后照常启动 WS 并挂上 AgentManager 监听器，于是同一个 App 留下两条
 * WS、一个永不释放的监听器，而 getFeishuBridge() 只指向第二条，第一条再也停不掉。
 *
 * 本模块把「建立 / 拆除连接」的全部副作用收进一条串行队列：
 * - connect 依次执行，已连接的相同凭证直接复用（不产生第二条 WS，不重复订阅）；
 * - 任一步抛错即整体回滚（退订 + 停 WS + 置空），调用方看不到半成品连接；
 * - disconnect 幂等，返回时订阅与 WS 一定已释放；
 * - AgentManager 订阅在模块内部注册，恰好一次，拆除时保证退订。
 *
 * 模块只依赖窄接口 FeishuWsLifecycle（startWs/stopWs），不感知 SDK 细节，
 * 因此测试注入两条方法的假传输即可断言连接与订阅次数。
 */

import type { LarkClient } from "./types";

export interface FeishuConnectionConfig {
	appId: string;
	appSecret: string;
}

/** WS 事件名 → 处理器；在 WS 启动前一次性注册，避免漏掉首批事件。 */
export interface FeishuWsHandlers {
	[event: string]: (data: unknown) => Promise<void>;
}

/** 连接模块需要的全部传输能力（完整端口 FeishuTransport 天然满足）。 */
export interface FeishuWsLifecycle {
	startWs(handlers?: FeishuWsHandlers): Promise<void>;
	stopWs(): void;
}

/** 一次连接对应的 SDK 会话：client 供业务调用 REST，transport 供卡片与 WS 使用。 */
export interface FeishuSession<TTransport extends FeishuWsLifecycle = FeishuWsLifecycle> {
	/** 假会话（测试）允许没有 REST client。 */
	client: LarkClient | null;
	transport: TTransport;
}

export interface FeishuConnectionDeps<TTransport extends FeishuWsLifecycle = FeishuWsLifecycle> {
	/** 建 SDK 会话；测试注入假实现以计数连接次数。 */
	createSession(config: FeishuConnectionConfig): Promise<FeishuSession<TTransport>>;
	/** 订阅 AgentManager 本地事件，返回退订函数。 */
	subscribeAgentEvents(handler: (agentId: string, event: unknown) => void): () => void;
	/** agent 事件的唯一 sink：模块不解释事件，只保证交付一次。 */
	handleAgentEvent(agentId: string, event: unknown): void;
}

export interface FeishuConnectOptions<TTransport extends FeishuWsLifecycle = FeishuWsLifecycle> {
	/** WS 事件处理器。 */
	handlers?: FeishuWsHandlers;
	/** 会话就绪后、WS 启动前的准备（如拉取 Bot 自身信息）；抛错即整体回滚。 */
	prepare?: (session: FeishuSession<TTransport>) => Promise<void>;
}

export class FeishuConnection<TTransport extends FeishuWsLifecycle = FeishuWsLifecycle> {
	private session: FeishuSession<TTransport> | null = null;
	private activeConfig: FeishuConnectionConfig | null = null;
	private unsubscribeAgentEvents: (() => void) | null = null;
	/** 串行队列：并发 connect/disconnect 按调用顺序执行，任何时刻至多一次拆建在途。 */
	private queue: Promise<void> = Promise.resolve();
	/**
	 * 连接作用域的消息去重指纹：与连接同生命周期，拆除 / 换凭证时一并清空。
	 * 旧连接的记录若留存，会吞掉新连接下本应正常同步的回复。
	 */
	private readonly syncedMessages = new Set<string>();

	constructor(private readonly deps: FeishuConnectionDeps<TTransport>) {}

	/** 当前会话的 REST client；未连接为 null。 */
	get client(): LarkClient | null { return this.session?.client ?? null; }
	/** 当前会话的传输端口；未连接为 null。 */
	get transport(): TTransport | null { return this.session?.transport ?? null; }
	/** 是否已建立连接：WS 已启动且 AgentManager 订阅已就绪。 */
	get connected(): boolean { return this.session !== null && this.unsubscribeAgentEvents !== null; }
	/** 当前连接使用的凭证。 */
	get config(): FeishuConnectionConfig | null { return this.activeConfig; }

	hasSyncedMessage(fingerprint: string): boolean { return this.syncedMessages.has(fingerprint); }
	markSyncedMessage(fingerprint: string): void { this.syncedMessages.add(fingerprint); }

	/** 单飞连接：同凭证的在途 / 已连接调用不会产生第二条 WS，也不会重复订阅。 */
	connect(config: FeishuConnectionConfig, options: FeishuConnectOptions<TTransport> = {}): Promise<void> {
		return this.enqueue(() => this.connectOnce(config, options));
	}

	/** 幂等断开：重复调用安全，返回时订阅与 WS 都已释放。 */
	disconnect(): Promise<void> {
		return this.enqueue(() => { this.teardown(); });
	}

	private enqueue(op: () => void | Promise<void>): Promise<void> {
		const run = this.queue.then(op, op);
		// 队列本身只负责串行：失败由 run 的调用方感知，不能污染后续排队者。
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async connectOnce(config: FeishuConnectionConfig, options: FeishuConnectOptions<TTransport>): Promise<void> {
		// 已连接同一凭证：复用现有连接（重复 connect 不再建 WS / 再订阅）。
		if (
			this.session && this.activeConfig &&
			this.activeConfig.appId === config.appId && this.activeConfig.appSecret === config.appSecret
		) return;
		// 换凭证或重连：先干净拆除旧连接，保证任何时刻只有一条 WS。
		if (this.session) this.teardown();

		const session = await this.deps.createSession(config);
		this.session = session;
		try {
			if (options.prepare) await options.prepare(session);
			await session.transport.startWs(options.handlers);
			this.unsubscribeAgentEvents = this.deps.subscribeAgentEvents(
				(agentId, event) => this.deps.handleAgentEvent(agentId, event),
			);
			this.activeConfig = config;
			this.syncedMessages.clear();
		} catch (error) {
			// 失败不得留半成品：退订 + 停 WS + 置空，让调用方回到干净的未连接态。
			this.teardown();
			throw error;
		}
	}

	private teardown(): void {
		const unsubscribe = this.unsubscribeAgentEvents;
		this.unsubscribeAgentEvents = null;
		try { unsubscribe?.(); } catch { /* 退订失败不阻断拆除 */ }
		const session = this.session;
		this.session = null;
		this.activeConfig = null;
		this.syncedMessages.clear();
		try { session?.transport.stopWs(); } catch { /* 停 WS 失败也要把状态归零 */ }
	}
}
