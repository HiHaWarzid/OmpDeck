import type { ChatMessage } from "../../shared/types";

/**
 * 会话改写配方（SessionRewrite）—— 编辑 / 删除 / 重发三条路径共用的不变式：
 *
 *   withSessionLock → ensureAgentIdle → sessionPath 守卫 → 读改写 JSONL
 *     → reload（switch_session）→ 失败则在同一把锁内用备份恢复 → 原错误照抛
 *
 * 为什么收成一个模块：这条配方此前在三处各写一遍（只有日志文案不同），于是
 * 「重载失败必须回滚」这条碰用户数据的规则由三份代码各自维护，且没有任何测试触达。
 * 收拢后新增第四种改写操作只需实现 mutate，回滚与重载语义自动继承。
 *
 * 依赖全部注入（runtime / 锁 / 空闲闸 / reload / 刷新转写），因此可在无 Electron、
 * 无 pi 进程的环境下用假端口测出「重载抛错 ⇒ 备份已恢复 ⇒ 原错误照抛」。
 */

/** 与 SessionJsonlLogger 同形的日志端口（避免硬依赖 AppLogger）。 */
export interface SessionRewriteLogger {
	warn(scope: string, message: string, detail?: unknown): void;
	info(scope: string, message: string, detail?: unknown): void;
	error(scope: string, message: string, detail?: unknown): void;
}

/** 改写只关心运行时的会话路径与内存消息列表。 */
export interface SessionRewriteRuntime {
	/** pi 协议路径；为空表示会话尚未落盘（会拒绝改写）。 */
	sessionPath?: string;
	messages: ChatMessage[];
}

/** SessionRewrite 需要的 JSONL 能力（由 SessionJsonl 提供，测试可传假实现）。 */
export interface SessionRewriteJsonl {
	/** read → mutate → backup → write 原子封装；mutate 抛出时不写盘。 */
	modifyLines<T>(sessionPath: string, mutator: (lines: string[]) => T): Promise<T>;
	/** 用最近一次备份覆盖会话文件；返回是否找到备份。 */
	restoreFromBackup(sessionPath: string): Promise<boolean>;
}

export interface SessionRewriteDeps {
	runtime: (agentId: string) => SessionRewriteRuntime;
	jsonl: SessionRewriteJsonl;
	/** 同一 agent 的会话文件写入互斥锁。 */
	withLock: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
	/** 忙时拒绝改写：switch_session 在流式/压缩中行为不确定。 */
	ensureIdle: (agentId: string) => Promise<void>;
	/** 用 switch_session 让 pi 重新读取会话文件（SessionJsonl.withReloadMarker 在内）。 */
	reload: (agentId: string) => Promise<void>;
	/** reload 成功或回滚后从 pi 拉取最新消息，保持内存与文件一致。 */
	refreshTranscript: (agentId: string) => Promise<unknown>;
	log?: SessionRewriteLogger;
}

/** 改写前的上下文：只读内存消息与路径。 */
export interface SessionRewriteContext {
	sessionPath: string;
	messages: ChatMessage[];
}

/** 改写回调的上下文：额外持有待修改的 JSONL 行（原地修改）。 */
export interface SessionRewriteMutationContext extends SessionRewriteContext {
	lines: string[];
}

export interface SessionRewriteRequest<T, P> {
	/** 日志前缀，同时也是「哪条改写操作」的唯一标识（如 "Edit message"）。 */
	operation: string;
	/** 附在日志里的定位信息（messageId 等）。 */
	detail?: Readonly<Record<string, unknown>>;
	/**
	 * 在读取 JSONL 之前执行，用于保持既有错误优先级：
	 * 重发要先校验内存消息存在且是 user，再读文件；编辑/删除的定位则刻意留在
	 * mutate 内部（先读文件做空文件校验，再查内存消息）。
	 */
	prepare?: (ctx: SessionRewriteContext) => P;
	mutate: (ctx: SessionRewriteMutationContext, prepared: P) => T;
}

export class SessionRewrite {
	constructor(private readonly deps: SessionRewriteDeps) {}

	/**
	 * 单入口：`prepare` 的存在与否决定「哪些校验发生在读文件之前」。
	 * P 默认 never 而不是 void：`(ctx) => X` 可赋给 `(ctx) => void`，用 void 会让
	 * 带 prepare 的调用静默落进无 prepare 的重载，prepare 的返回值退化成 void。
	 */
	async apply<T, P = never>(
		agentId: string,
		request: SessionRewriteRequest<T, P>,
	): Promise<T> {
		const startTime = Date.now();
		const { jsonl, log } = this.deps;
		const detail = request.detail ?? {};

		return await this.deps.withLock(agentId, async () => {
			await this.deps.ensureIdle(agentId);

			const runtime = this.deps.runtime(agentId);
			const sessionPath = runtime.sessionPath;
			if (!sessionPath) throw new Error("Session not persisted");

			const prepared = request.prepare?.({ sessionPath, messages: runtime.messages }) as P;

			// mutate 抛出（定位失败/角色校验失败）时 modifyLines 不备份也不写盘，
			// 因此下面的回滚块只会处理「文件已改，但 pi 重载失败」这一种不一致。
			const result = await jsonl.modifyLines(sessionPath, (lines) =>
				request.mutate({ sessionPath, messages: runtime.messages, lines }, prepared),
			);

			try {
				await this.deps.reload(agentId);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				log?.error("agent", `${request.operation}: reload failed, restoring backup`, {
					agentId,
					...detail,
					error: errMsg,
					elapsedMs: Date.now() - startTime,
				});
				await this.rollback(agentId, sessionPath, request.operation, detail);
				throw error;
			}

			return result;
		});
	}

	/**
	 * 回滚：用备份覆盖会话文件，并让内存转录跟上恢复后的文件。
	 *
	 * 两者都失败（找不到备份 / 刷新失败）时只记日志、不抛错——原始 reload 错误
	 * 才是调用方需要的信号，回滚失败把它换掉会让用户看不到真正原因。
	 */
	private async rollback(
		agentId: string,
		sessionPath: string,
		operation: string,
		detail: Readonly<Record<string, unknown>>,
	): Promise<void> {
		try {
			const restored = await this.deps.jsonl.restoreFromBackup(sessionPath);
			if (restored) await this.deps.refreshTranscript(agentId).catch(() => {});
		} catch (restoreError) {
			this.deps.log?.error("agent", `${operation}: failed to restore backup`, {
				agentId,
				...detail,
				error: restoreError instanceof Error ? restoreError.message : String(restoreError),
			});
		}
	}
}
