/**
 * 进程替换编排：**唯一**知道「换掉 pi child 之后该把会话恢复成什么样」的地方。
 *
 * 设计动机（deep module / locality）：
 *   替换 pi 子进程有四条入口——收缩放退出后自动重连、配置版本落后时重连、
 *   developer 角色被上游拒绝后的自愈、以及替换失败后的二次重连。四条路径此前各自
 *   手写同一段收尾：
 *
 *     tab.status = "starting"; emitState();
 *     await replaceProcess();          // 停旧 child + attach 新 child
 *     await restoreSelection(selection); // set_model / set_thinking_level
 *     tab.status = "idle"; delete tab.lastError;
 *     addMessage(system|error, …); emitState();
 *
 *   这段收尾的**顺序**是硬约束，分散复制时最难保持：
 *   1. 先 `starting`：替换期间 UI 必须显示「正在重连」，且此时任何新 prompt 都会看到
 *      非 idle 状态而不被投递给即将退役的 child；
 *   2. 先替换、后恢复：旧 child 还在时恢复选择只会写进一个将被丢弃的进程；
 *   3. 恢复选择也属于替换的一部分：`restoreSelection` reject 即整次替换失败
 *      （进程换了但模型/思考档没跟上，会话状态就是错的），必须落 error 并把 lastError
 *      写进卡片——否则用户只看到闭着的会话，没有任何可排查信息；
 *   4. 无论成败都要重新广播状态：替换窗口的 starting 不能留在 UI 上。
 *      调用方的锁（`configApplyPromise` / `healingDeveloperRole`）由调用方 try/finally
 *      收尾，本模块不碰——各入口的加锁时机不同，那是调用方的领域判断。
 *
 *   把这些搬进一个模块，调用方只需回答三件事：为什么换、换成功说什么、换失败说什么；
 *   顺序与状态清理不再有第二份实现。
 *
 * 与 AgentProcessSlot 的分工：slot 负责「这个 child 是否仍归我所有」（租约与代次），
 * 本模块负责「替换过程中会话应处于什么状态、失败如何收口」。两者都不碰 transcript 内容。
 */

import type { AgentStatus } from "../../shared/types";

/** 恢复会话选择的窄口子：实现方决定发哪些 RPC、失败时如何告警。 */
export type ReplacementSelection = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

/**
 * 替换所需的运行时视图。刻意做成结构化窄接口而非 AgentRuntime：
 * 本模块只需要读写状态与错误、追加一条系统/错误卡片，不关心转录内容。
 */
export type ReplacementTarget = {
	readonly agentId: string;
	/** 当前会话文件；缺失表示会话尚未落盘，无法重连。 */
	readonly sessionPath: string | undefined;
	/** 读写 tab.status（starting → idle/error）。 */
	status: AgentStatus;
	/** 失败时写入的可排查信息。 */
	lastError?: string;
};

export type ReplacementEffects<T extends ReplacementTarget> = {
	/**
	 * 停旧 child 并按同一 session 重连；失败即视为替换失败。
	 *
	 * `sessionPath` 由本模块校验后传入（保证非空）：把「没有会话文件就不能换」这条
	 * 前置条件留在编排里，调用方不必各自再写一遍空值守卫，也就不会出现两份措辞
	 * 不同的报错。
	 */
	replaceProcess(target: T, sessionPath: string): Promise<void>;
	/**
	 * 在新 child 上恢复模型/思考档。**恢复不成功必须 reject**：
	 * 进程换了但选择没跟上，会话就是在用错的模型跑，不能报「已重连」。
	 * 意图断言（set_model / set_thinking_level 返回 success:false）属于恢复失败的一种。
	 */
	restoreSelection(target: T, selection: ReplacementSelection): Promise<void>;
	/** 添加上下文卡片（system 说明成功，error 说明失败）。 */
	addMessage(target: T, role: "system" | "error", text: string): void;
	/** 状态已变，通知 UI。 */
	emitState(): void;
	/** 运行态变化（模型/思考档可能已变），通知运行时订阅者。 */
	emitRuntimeState(agentId: string): void;
	logInfo?(message: string, detail: Record<string, unknown>): void;
	logError?(message: string, detail: Record<string, unknown>): void;
};

export type ReplacementCopy = {
	/** 成功后的提示文本。 */
	success: string;
	/** 失败提示；收到的是不含包装的错误信息。 */
	failure(errorMessage: string): string;
	/**
	 * 失败时落哪个状态。默认 `error`（进程仍可重启、会话文件还在，值得让用户重试）；
	 * 进程已经退出的自动重连必须传 `closed`——此时没有活着的 child 可交互，
	 * 停在 error 会让 UI 以为还能发消息。
	 */
	statusOnFailure?: Extract<AgentStatus, "error" | "closed">;
	/** 日志用的事件名（成功/失败共用前缀，便于过滤）。 */
	logScope: string;
};

export type ReplacementOutcome = { ok: true } | { ok: false; errorMessage: string };

/**
 * 执行一次完整的进程替换。
 *
 * 调用方保证：只在会话空闲（idle/error）时调用，且已通过 sessionPath 判定可重连。
 * 本函数不再重复校验这些前置条件——那是调用方对「此刻能否换」的领域判断
 * （不同入口的允许状态不同），放在这里会让四条路径的差异重新挤进同一处。
 */
export async function runProcessReplacement<T extends ReplacementTarget>(
	target: T,
	selection: ReplacementSelection,
	effects: ReplacementEffects<T>,
	copy: ReplacementCopy,
): Promise<ReplacementOutcome> {
	// 先进入 starting：替换窗口内 UI 显示重连中，且新 prompt 不会投给即将退役的 child。
	// 同时清掉上一次进程留下的 lastError：重连进行中还挂着旧错误，UI 会同时显示
	// 「正在重连」和早已过时的崩溃原因；失败分支会写入本次的真实原因。
	target.status = "starting";
	target.lastError = undefined;
	effects.emitState();
	try {
		// 无会话文件的替换会把 `""` 交给 PiProcess.start：那不会报错，而是静默新建会话并
		// 覆盖 tab.sessionPath，原对话从该 tab 上消失。这是替换本身的前置条件，放在这里
		// 收口，调用方不必各自再写一遍同样的空值守卫。
		const sessionPath = target.sessionPath;
		if (!sessionPath) throw new Error("会话尚未落盘，无法重连");
		await effects.replaceProcess(target, sessionPath);
		// 恢复选择必须在替换之后：旧 child 上的 set_model 会被随后的替换丢弃。
		await effects.restoreSelection(target, selection);
		target.status = "idle";
		// 用赋值而非 delete：目标可能是 view，只有 getter/setter，没有可删属性。
		target.lastError = undefined;
		effects.addMessage(target, "system", copy.success);
		effects.logInfo?.(`${copy.logScope} succeeded`, { agentId: target.agentId });
		return { ok: true };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// 失败必须落非 idle 状态且写 lastError：否则用户面对的是一个没有线索的会话。
		target.status = copy.statusOnFailure ?? "error";
		target.lastError = errorMessage;
		effects.addMessage(target, "error", copy.failure(errorMessage));
		effects.logError?.(`${copy.logScope} failed`, {
			agentId: target.agentId,
			error: errorMessage,
		});
		return { ok: false, errorMessage };
	} finally {
		// 无论成败都要广播终态：替换期间的 starting 不能被留在 UI 上。
		effects.emitState();
		effects.emitRuntimeState(target.agentId);
	}
}

/** 进程退出后的单次自动重连判据：干净退出（code 0）、有会话文件、本生命周期未重连过。 */
export function shouldAutoReattach(input: {
	sessionPath: string | undefined;
	exitCode: number | null;
	alreadyAttempted: boolean;
}): boolean {
	return !input.alreadyAttempted && Boolean(input.sessionPath) && input.exitCode === 0;
}
