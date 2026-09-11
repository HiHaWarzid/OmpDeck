/**
 * SessionRunCards — 每会话流式卡片的运行生命周期
 *
 * 原先 FeishuBridge 用五张 session 键控表分别跟踪卡片、运行状态、待回放事件与两个交付标记，
 * 时序规则散在 runAgent / handleAgentEvent / startSessionMirrorRun / stop 四处。这里把它们
 * 收进一个深模块，对外只暴露“一次运行”的生命周期动词。不变量：
 *
 * - **就绪前缓冲**：openStream 完成前 feed 的事件全部缓冲，就绪后按序回放一次；同一事件不会
 *   既进缓冲又被 reduce（旧实现靠“有 pending 就 return”防止重复轨迹）。
 * - **恰好一次交付**：同一事件序列只渲染一次；终态走 flush + close，flush 失败时只回调一次
 *   onDeliveryFailed，调用方据此补发纯文本（旧实现里 handleAgentEvent 与 runAgent 各兜底一次，
 *   终态 patch 失败时可能双发）。
 * - **迟到流不复活**：begin 之后、openStream 完成之前 run 被 abort/drop/closeAll 的话，
 *   迟到的 stream 会被立即关闭，不会再被写入。
 *
 * 状态由纯 reducer（CardRunState）驱动；卡片创建通过注入的 openStream 完成，
 * 因此本模块不触碰 lark SDK，测试可用 fake stream 直接断言事件序列。
 */

import { markError, markInterrupted, reduceFromPiEvent, type RunState } from "./CardRunState";

/** 卡片流的最小接口：生产为 CardStream，测试可注入 fake。 */
export interface CardSink {
	update(card: object): void;
	flush(card?: object): Promise<void>;
	close(): Promise<void>;
	readonly lastPatchFailed: boolean;
	readonly lastPatchError: string;
}

export interface RunSpec {
	chatId: string;
	/** 运行初始状态（通常 createInitialState()）。 */
	state: RunState;
	/** 初始卡片；由调用方渲染，保持各自既有首屏（是否带 stopHint 不同）。 */
	initialCard: object;
	replyToMessageId?: string;
	/** 终态卡片交付失败时的降级回调：调用方补发纯文本。 */
	onDeliveryFailed?: () => void;
}

export interface RunHandle {
	/**
	 * 卡片消息是否已在飞书创建。false 仅表示创建失败（该运行已被丢弃，调用方必须走纯文本兜底）；
	 * 创建成功但随后被 abort/drop/stop 关闭时仍为 true——此时卡片消息确实存在，不应再补发文本。
	 */
	opened: Promise<boolean>;
	/** 终态 flush + close 完成（或被 abort/drop/closeAll）后 resolve；供测试与需要定序的调用方等待。 */
	settled: Promise<void>;
}

export interface SessionRunCardsDeps {
	openStream(chatId: string, initialCard: object, opts: { replyToMessageId?: string }): Promise<CardSink>;
	/** RunState → 卡片 JSON；流式更新与终态共用同一渲染。 */
	render(state: RunState): object;
}

interface RunRecord {
	chatId: string;
	state: RunState;
	stream: CardSink | null;
	/** 非 null 表示卡片尚未就绪：事件先入此数组，就绪后按序回放。 */
	buffer: Record<string, unknown>[] | null;
	dropped: boolean;
	onDeliveryFailed?: () => void;
	resolveSettled: () => void;
}

function safeLog(level: "warn" | "error", ...args: unknown[]): void {
	try { console[level](...args); } catch { /* EPIPE */ }
}

export class SessionRunCards {
	private readonly runs = new Map<string, RunRecord>();

	constructor(private readonly deps: SessionRunCardsDeps) {}

	/** 该会话是否有一轮正在进行的卡片运行（含卡片尚未就绪的缓冲期）。 */
	has(sessionId: string): boolean { return this.runs.has(sessionId); }

	/**
	 * 开始一次运行：登记状态并立即发起卡片创建。返回后即可 feed 事件，
	 * 卡片就绪前的事件会被缓冲。若同会话已有未结束的运行，先按 drop 语义清理旧运行。
	 */
	begin(sessionId: string, spec: RunSpec): RunHandle {
		const stale = this.runs.get(sessionId);
		if (stale) {
			safeLog("warn", `[飞书 SessionRunCards] 会话 ${sessionId.slice(0, 8)} 已有运行，先丢弃旧运行`);
			this.discard(stale);
			this.runs.delete(sessionId);
		}

		const record: RunRecord = {
			chatId: spec.chatId,
			state: spec.state,
			stream: null,
			buffer: [],
			dropped: false,
			onDeliveryFailed: spec.onDeliveryFailed,
			resolveSettled: () => {},
		};
		const settled = new Promise<void>((resolve) => { record.resolveSettled = resolve; });
		this.runs.set(sessionId, record);

		let opening: Promise<CardSink>;
		try {
			opening = this.deps.openStream(spec.chatId, spec.initialCard, {
				replyToMessageId: spec.replyToMessageId,
			});
		} catch (e) {
			opening = Promise.reject(e);
		}

		const opened = opening
			.then((stream) => {
				// 卡片消息已经发出（openStream 失败才会 reject）：即便已被 abort/drop/stop
				// 关闭，也如实返回 true，调用方据此不再补发纯文本。
				if (record.dropped) { void stream.close().catch(() => {}); return true; }
				record.stream = stream;
				const buffered = record.buffer ?? [];
				record.buffer = null;
				for (const event of buffered) {
					// 回放中进入终态会移除 run，剩余缓冲事件不再回放。
					if (record.dropped) break;
					this.applyEvent(sessionId, record, event);
				}
				return true;
			})
			.catch((e) => {
				safeLog("error", "[飞书 SessionRunCards] 流式卡片创建失败:", e);
				if (!record.dropped) {
					record.dropped = true;
					this.runs.delete(sessionId);
					record.resolveSettled();
				}
				return false;
			});

		return { opened, settled };
	}

	/** 喂入 Agent 事件；该 session 无运行返回 false（调用方决定是否走纯文本同步）。 */
	feed(sessionId: string, event: Record<string, unknown>): boolean {
		const record = this.runs.get(sessionId);
		if (!record) return false;
		if (record.buffer) { record.buffer.push(event); return true; }
		this.applyEvent(sessionId, record, event);
		return true;
	}

	/** 以错误终态收尾（Agent 超时/异常等调用方显式判定）。 */
	fail(sessionId: string, message: string): void {
		const record = this.runs.get(sessionId);
		if (!record) return;
		// 必须走 markError：它会收尾流式文本块与思考态，否则终态卡片仍显示“思考中/正在调用”。
		this.terminalize(sessionId, record, markError(record.state, message));
	}

	/** 主动中断（/stop 或 mirror 停止）：以 interrupted 终态 flush + close，不触发降级回调。 */
	async abort(sessionId: string): Promise<void> {
		const record = this.runs.get(sessionId);
		if (!record) return;
		record.state = markInterrupted(record.state);
		const stream = record.stream;
		record.dropped = true;
		this.runs.delete(sessionId);
		if (stream) {
			await stream.flush(this.deps.render(record.state)).catch(() => {});
			await stream.close().catch(() => {});
		}
		record.resolveSettled();
	}

	/** 丢弃该会话的卡片状态（解绑/清理），不渲染终态。 */
	drop(sessionId: string): void {
		const record = this.runs.get(sessionId);
		if (!record) return;
		this.runs.delete(sessionId);
		this.discard(record);
	}

	/** 桥停止：关闭所有卡片并清空（关闭为 fire-and-forget）。 */
	closeAll(): void {
		for (const record of this.runs.values()) this.discard(record);
		this.runs.clear();
	}

	/** 标记 run 已作废；若卡片已就绪则即关闭，否则等迟到的 stream 回来时由 begin 的 then 关闭。 */
	private discard(record: RunRecord): void {
		record.dropped = true;
		if (record.stream) void record.stream.close().catch(() => {});
		record.resolveSettled();
	}

	private applyEvent(sessionId: string, record: RunRecord, event: Record<string, unknown>): void {
		const next = reduceFromPiEvent(record.state, event);
		if (next === record.state) return;
		record.state = next;
		if (next.terminal !== "running") { this.terminalize(sessionId, record, next); return; }
		if (record.stream) record.stream.update(this.deps.render(next));
	}

	/**
	 * 终态交付：flush → close，patch 失败时回调 onDeliveryFailed。
	 * run 同步从表中移除（同 session 可立刻开新 run），异步链持有 record 引用。
	 */
	private terminalize(sessionId: string, record: RunRecord, state: RunState): void {
		record.state = state;
		record.dropped = true;
		this.runs.delete(sessionId);
		const stream = record.stream;
		if (!stream) { record.resolveSettled(); return; }

		void (async () => {
			try {
				await stream.flush(this.deps.render(state));
				// patch 失败不抛错，只置 lastPatchFailed；此时同样要降级补发纯文本。
				if (stream.lastPatchFailed) {
					safeLog("warn", `[飞书 SessionRunCards] 终态卡片 patch 失败: ${stream.lastPatchError}`);
					record.onDeliveryFailed?.();
				}
			} catch (e) {
				safeLog("error", "[飞书 SessionRunCards] 终态卡片 flush 异常:", e);
				record.onDeliveryFailed?.();
			} finally {
				// flush 失败也必须 close：释放节流定时器并禁止后续写入（close 幂等）。
				await stream.close().catch((e) =>
					safeLog("error", "[飞书 SessionRunCards] 终态卡片 close 异常:", e));
				record.resolveSettled();
			}
		})();
	}
}
