/**
 * pi 线格式（wire format）的唯一属主：把跨进程传来的原始帧/响应体读成领域语义。
 *
 * 过去这份知识散在三处：`AgentManager.handlePiEvent` 里 498 行的 if 阶梯（30 种帧名）、
 * `AgentManager.getRuntimeState` 里 126 行逐字段擦洗、`QuickGenProcess` 里对
 * `message_update`/`agent_end` 的第二份解读。结果是「pi 说了什么」这件事实没有名字，
 * 谁都得自己认一遍帧名；顺序约束（活性戳必须先于任何提前 return、
 * command_output 依赖发送时记下的命令名）只能写在注释里，无法被测试。
 *
 * 本模块只做**读**，不做副作用：同一个输入永远得到同一个输出，因此
 *   帧 + now → PiFrame（work 活性标记 + 可选 effect）
 * 就是这一层的完整接口，测试直接打在这里。
 *
 * 两条例外规则说明白：
 * - `decodePiFrame` 返回 `undefined` 表示「连帧都不是」，此时调用方连活性戳都不该刷；
 *   返回 `{ work: false }` 表示「是帧，但不算用户可感知的工作」——两者语义不同，
 *   历史上混在一处曾让 `session_info_update` 顶住「已完成」通知不发。
 * - 副作用留在 AgentManager：它们要碰进程、转录、IPC，属于另一个模块的职责。
 */
import type {
	AgentCacheWarmingState,
	AgentQueuedMessages,
	AgentRuntimeState,
	AgentSubagent,
	AgentUsageLimitState,
} from "../../shared/types";
import { normalizeTodoPhases } from "./agentControl";
import { normalizePiBoolean } from "./settleReducer";

/**
 * 失败响应的类别（跨 pi 版本的事实，故与帧解读同处一个模块）：
 *   - unknown-command：命令名与此 pi 版本不兼容（piRpcCompat 据此换名重试）；
 *   - transport-limit：响应体超过 RPC 传输上限（大会话的 get_messages/get_entries 会命中），
 *     必须走会话文件直读兜底，绝不能把 `data === undefined` 当「会话为空」；
 *   - other：其余真实错误（参数错误、会话忙、provider 报错等），照原样上报。
 */
export type PiFailureKind = "unknown-command" | "transport-limit" | "other";

export function classifyPiFailure(response: { error?: string } | undefined): PiFailureKind {
	const error = response?.error ?? "";
	if (/unknown command/i.test(error)) return "unknown-command";
	if (/transport limit/i.test(error)) return "transport-limit";
	return "other";
}

/** 未校验的线上数据：读一处判一处，不假设任何字段存在。 */
type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Raw)
		: undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readBool(value: unknown): boolean {
	return value === true;
}

function readArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function pickNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

function clampPercent(value: number | undefined): number | undefined {
	if (value == null || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, value));
}

/**
 * 帧算不算「用户可感知的工作」。
 *
 * `session_info_*` 是标题元数据、`available_commands_update` 是命令目录刷新：
 * 它们频繁到达但用户什么都没看到，若刷新活性戳，「已完成」通知的静默窗口
 * 会被无限推迟，通知永远不弹。
 */
const NON_WORK_FRAME_TYPES = new Set([
	"session_info_changed",
	"session_info_update",
	"available_commands_update",
]);

/** 子代理帧（lifecycle/progress）的载荷封装，供投影与 registry 共用。 */
export type PiSubagentFrame = { frame: "lifecycle" | "progress"; payload: Raw };

/**
 * 一帧子代理事件对应的 registry 键，以及它是否代表「同一 id 的新一次运行」。
 *
 * 返回 `undefined` 表示帧里没有可用 id（不能凭空造空记录）。`restarted` 由
 * lifecycle(started) 判定：omp 的 subagentId 在 session 内可复用，新的 started
 * 必须丢弃上一次的统计与终态，否则终态粘滞会把新运行永久钉在 completed。
 */
export function readSubagentFrameIdentity(
	input: PiSubagentFrame,
): { id: string; restarted: boolean } | undefined {
	const progress = asRecord(input.payload.progress);
	const source = progress ?? input.payload;
	const id = readString(source.id) || readString(input.payload.id) || "";
	if (!id) return undefined;
	return { id, restarted: input.frame === "lifecycle" && source.status === "started" };
}

/** 子代理已收口状态：到达后不再被迟到的 progress("running") 覆盖。 */
const SUBAGENT_TERMINAL_STATUSES = new Set([
	"completed",
	"aborted",
	"cancelled",
	"failed",
	"error",
]);

// ──────────────────────────── 助手消息子事件 ────────────────────────────

/**
 * `message_update.assistantMessageEvent` 的语义相位。
 *
 * pi 用七八个字符串表达「这一轮回答走到哪了」，桌面端只需要三类动作：
 * 校准全量文本、追加增量、收终态。把相位判定的字符串比较收在这里，
 * 消掉了 AgentManager 与 QuickGenProcess 各写一份的现状。
 */
export type PiAssistantPhase =
	| "start"
	| "text"
	| "text-delta"
	| "thinking-delta"
	| "thinking-end"
	| "final"
	| "other";

export type PiAssistantEvent = {
	phase: PiAssistantPhase;
	/** 增量文本（text-delta / thinking-delta）。 */
	delta: string;
	/** 全量 partialMessage：message / assistantMessageEvent.message / partial / partialMessage。 */
	message: unknown;
	/** thinking-end 携带的完整思考文本。 */
	content: unknown;
};

/**
 * 解读一条 assistant 子事件。
 *
 * 高频路径（text_delta）只读 delta：`message` 字段每条都带全量 partialMessage，
 * 对累积文本再做一次 O(n) 提取会把流式渲染拖成平方复杂度。调用方据此跳过全量提取。
 */
export function decodeAssistantEvent(outer: Raw): PiAssistantEvent {
	const inner = asRecord(outer.assistantMessageEvent) ?? {};
	const type = readString(inner.type) ?? "";
	const message = outer.message ?? inner.message ?? inner.partial ?? inner.partialMessage;
	const delta = readString(inner.delta) ?? "";

	let phase: PiAssistantPhase = "other";
	if (type === "start" || type === "message_start") phase = "start";
	else if (type === "text_start" || type === "text_end") phase = "text";
	else if (type === "text_delta") phase = "text-delta";
	else if (type === "thinking_delta") phase = "thinking-delta";
	else if (type === "thinking_end") phase = "thinking-end";
	else if (type === "message_end" || type === "done" || type === "error") phase = "final";

	return { phase, delta, message, content: inner.content };
}

// ──────────────────────────── 帧 → 领域效果 ────────────────────────────

/** agent_end 的错误文本查找结果。 */
export type PiAgentEndReport = {
	/** 最终错误文本（各级兜底都查不到时为 undefined）。 */
	errorMessage?: string;
	/** pi 自报有错：stopReason=error 或存在 stopReason=error 的消息。 */
	hadError: boolean;
	willRetry: boolean;
	stopReason?: string;
};

/**
 * agent_end 的错误文本阶梯：顶层 → 错误消息列表 → 顶层 error → 最后一条 assistant 的 error 内容块。
 *
 * 只从**最后一条** assistant 消息里找 `type:"error"` 内容块：扫描全部历史会把
 * 早已成功的旧工具输出误判成当前失败（每次 run 结束都弹一条假错误）。
 */
export function readAgentEndReport(raw: Raw): PiAgentEndReport {
	const messages = readArray(raw.messages);
	const errorMessages = messages.filter((m) => asRecord(m)?.stopReason === "error");
	const topMsg = asRecord(errorMessages[errorMessages.length - 1]);
	const lastAssistant = asRecord(
		messages.filter((m) => asRecord(m)?.role === "assistant").pop(),
	);
	const contentError = asRecord(
		readArray(lastAssistant?.content).find((c) => asRecord(c)?.type === "error"),
	);
	const errorMessage =
		readString(raw.errorMessage) ??
		readString(topMsg?.errorMessage) ??
		readString(raw.error) ??
		readString(contentError?.text) ??
		readString(contentError?.message);
	const stopReason = readString(raw.stopReason);
	return {
		...(errorMessage === undefined ? {} : { errorMessage }),
		hadError: stopReason === "error" || errorMessages.length > 0,
		willRetry: readBool(raw.willRetry),
		...(stopReason === undefined ? {} : { stopReason }),
	};
}

/** 重试卡片文本的三种终态。 */
export type PiRetryStatus = "running" | "success" | "error";

/**
 * 自动重试卡片的文案规则。
 *
 * 抽成纯函数是因为规则比看上去多：只有已知 maxAttempts 才写 `attempt/maxAttempts`；
 * 延迟按秒**向上**取整（0.4s 写成「0 秒后重试」会像 bug）；成功态只说总次数。
 */
export function retryStatusText(input: {
	status: PiRetryStatus;
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	reason: string;
}): string {
	const { status, attempt, maxAttempts, delayMs, reason } = input;
	const delayText = delayMs > 0 ? `，${Math.ceil(delayMs / 1000)} 秒后重试` : "";
	const countText = maxAttempts > 0 ? `${attempt}/${maxAttempts}` : String(attempt || 1);
	if (status === "running") return `正在自动重试 ${countText}${delayText}\n原因：${reason}`;
	if (status === "success") return `自动重试成功，共重试 ${attempt} 次`;
	return `自动重试失败，已重试 ${countText} 次\n原因：${reason}`;
}

/**
 * 自动重试帧携带的字段。全部可选：agent_end(willRetry) 只带错误消息，
 * 缺字段时由调用方回退到重试卡片上已写入的 meta。
 */
export type RetryStatusFields = {
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	reason?: string;
};

/** 一帧原始事件投影出的领域效果（帧名互斥，故效果也互斥）。 */
export type PiEffect =
	| { kind: "title"; name: string }
	| { kind: "subagents"; frame: "lifecycle" | "progress"; payload: Raw }
	| { kind: "command-catalog"; commands: unknown }
	| { kind: "command-output"; text: string }
	| { kind: "model-changed" }
	| { kind: "config-warnings-changed" }
	| {
			kind: "cache-warming";
			state: AgentCacheWarmingState;
			/** 预热非 hit 结束时 omp 给出的停止原因，仅供日志诊断。 */
			warmingStopReason?: string;
	  }
	| { kind: "run-start" }
	| { kind: "assistant-start"; message: unknown }
	| { kind: "assistant-event"; event: PiAssistantEvent }
	| ({ kind: "retry-start" } & RetryStatusFields)
	| ({ kind: "retry-end"; success: boolean } & RetryStatusFields)
	| { kind: "compaction-start"; reason: string }
	| {
			kind: "compaction-end";
			reason: string;
			result: boolean;
			aborted: boolean;
			willRetry: boolean;
			/** omp 为良性原因跳过压缩（无模型/无候选模型/中途换会话）：不是失败。 */
			skipped: boolean;
			errorMessage?: string;
	  }
	| { kind: "agent-end"; report: PiAgentEndReport }
	| { kind: "queue-update"; snapshot: AgentQueuedMessages }
	| { kind: "todo-cleared" }
	| { kind: "settled" }
	| { kind: "message-end"; message: unknown }
	| { kind: "tool-start"; event: Raw }
	| { kind: "tool-update"; event: Raw }
	| { kind: "tool-end"; event: Raw }
	| { kind: "ui-request"; request: Raw }
	| { kind: "extension-error"; message: string };

/** 解码结果：活性标记 + 需要产生的领域效果（可能什么都没有）。 */
export type PiFrame = {
	/** 是否算用户可感知的工作（见 NON_WORK_FRAME_TYPES）。 */
	work: boolean;
	effect?: PiEffect;
};

function readRetryFields(raw: Raw, prefer: "start" | "end"): RetryStatusFields {
	const attempt = pickNumber(raw.attempt);
	const maxAttempts = pickNumber(raw.maxAttempts);
	const delayMs = pickNumber(raw.delayMs);
	// 文本帧只带部分字段（例如 agent_end.willRetry 只有错误消息）：
	// 缺字段时保持 undefined，让调用方回退到已有卡片上的 meta，而不是写死 0/未知。
	//
	// 错误文本按 omp 线格式各取所属字段：auto_retry_start 只带 errorMessage，
	// auto_retry_end 只带 finalError。两帧同时携带时沿用各自的权威字段顺序
	// （起帧信 errorMessage、终帧信 finalError），避免统一顺序后改了终帧文案来源。
	const errorMessage = readString(raw.errorMessage);
	const finalError = readString(raw.finalError);
	const reason = prefer === "start" ? (errorMessage ?? finalError) : (finalError ?? errorMessage);
	return {
		...(attempt === undefined ? {} : { attempt }),
		...(maxAttempts === undefined ? {} : { maxAttempts }),
		...(delayMs === undefined ? {} : { delayMs }),
		...(reason === undefined ? {} : { reason }),
	};
}

/**
 * 把一帧原始事件解码成领域效果。
 *
 * 返回 `undefined` 只表示「传入的不是对象」——调用方此时连活性戳都不应刷新
 * （原来这条顺序写在注释里，现在由返回类型表达）。
 *
 * @param now 只用于需要时间戳的投影（cache warming updatedAt），显式传入以保持可测。
 */
export function decodePiFrame(event: unknown, now: number): PiFrame | undefined {
	const raw = asRecord(event);
	if (!raw) return undefined;
	const type = readString(raw.type) ?? "";
	const work = !NON_WORK_FRAME_TYPES.has(type);

	if (type === "session_info_changed" || type === "session_info_update") {
		const name = (readString(raw.name) ?? "").replace(/\s+/g, " ").trim();
		// 空 name 不产生效果：抹掉已有标题比保留旧标题更糟。
		return name ? { work, effect: { kind: "title", name } } : { work };
	}

	if (type === "subagent_lifecycle" || type === "subagent_progress") {
		const payload = asRecord(raw.payload);
		if (!payload) return { work };
		return {
			work,
			effect: {
				kind: "subagents",
				frame: type === "subagent_lifecycle" ? "lifecycle" : "progress",
				payload,
			},
		};
	}

	if (type === "available_commands_update") {
		return { work, effect: { kind: "command-catalog", commands: raw.commands } };
	}

	if (type === "command_output") {
		return { work, effect: { kind: "command-output", text: readString(raw.text) ?? "" } };
	}

	if (type === "model_changed") return { work, effect: { kind: "model-changed" } };

	if (type === "config_warnings_changed") {
		return { work, effect: { kind: "config-warnings-changed" } };
	}

	if (type === "cache_warming_start" || type === "cache_warming_end") {
		const isEnd = type === "cache_warming_end";
		const rawOutcome = raw.outcome;
		const outcome: AgentCacheWarmingState["outcome"] =
			isEnd &&
			(rawOutcome === "hit" ||
				rawOutcome === "miss" ||
				rawOutcome === "error" ||
				rawOutcome === "aborted")
				? rawOutcome
				: undefined;
		const provider = readString(raw.provider);
		const model = readString(raw.model);
		const warmingStopReason = readString(raw.warmingStopReason);
		return {
			work,
			effect: {
				kind: "cache-warming",
				state: {
					phase: isEnd ? "done" : "warming",
					...(outcome ? { outcome } : {}),
					...(provider ? { provider } : {}),
					...(model ? { model } : {}),
					updatedAt: now,
				},
				...(warmingStopReason ? { warmingStopReason } : {}),
			},
		};
	}

	if (type === "agent_start") return { work, effect: { kind: "run-start" } };

	if (type === "message_start") {
		return asRecord(raw.message)?.role === "assistant"
			? { work, effect: { kind: "assistant-start", message: raw.message } }
			: { work };
	}

	if (type === "auto_retry_start") {
		return { work, effect: { kind: "retry-start", ...readRetryFields(raw, "start") } };
	}

	if (type === "auto_retry_end") {
		return {
			work,
			effect: { kind: "retry-end", success: readBool(raw.success), ...readRetryFields(raw, "end") },
		};
	}

	if (type === "compaction_start" || type === "auto_compaction_start") {
		return {
			work,
			effect: { kind: "compaction-start", reason: readString(raw.reason) ?? "" },
		};
	}

	if (type === "compaction_end" || type === "auto_compaction_end") {
		const errorMessage = readString(raw.errorMessage);
		return {
			work,
			effect: {
				kind: "compaction-end",
				reason: readString(raw.reason) ?? "",
				// omp 的 `result` 是 `CompactionResult | undefined`（对象），旧 pi 是布尔。
				// 不能走 readBool（`=== true`）：对象会被压成 false，成功压缩全部记成 failed。
				// 判定沿用迁移前的真值语义——有结果即成功，缺省/undefined 才是失败。
				result: raw.result != null && raw.result !== false,
				aborted: readBool(raw.aborted),
				willRetry: readBool(raw.willRetry),
				skipped: readBool(raw.skipped),
				...(errorMessage === undefined ? {} : { errorMessage }),
			},
		};
	}

	if (type === "agent_end") {
		return { work, effect: { kind: "agent-end", report: readAgentEndReport(raw) } };
	}

	if (type === "queue_update") {
		return { work, effect: { kind: "queue-update", snapshot: normalizePiQueue(raw) } };
	}

	if (type === "todo_auto_clear") return { work, effect: { kind: "todo-cleared" } };

	if (type === "agent_settled" || type === "session_settled") {
		// 旧 pi 只发 agent_settled，新 pi 在自己 settle 判据满足时发 session_settled：
		// 同一个最终稳定点，共用一条收口路径（只认前者会让新 pi 永远靠兜底轮询）。
		return { work, effect: { kind: "settled" } };
	}

	if (type === "message_update") {
		return asRecord(raw.assistantMessageEvent)
			? { work, effect: { kind: "assistant-event", event: decodeAssistantEvent(raw) } }
			: { work };
	}

	if (type === "message_end") {
		return asRecord(raw.message)?.role === "assistant"
			? { work, effect: { kind: "message-end", message: raw.message } }
			: { work };
	}

	if (type === "tool_execution_start") return { work, effect: { kind: "tool-start", event: raw } };
	if (type === "tool_execution_end") return { work, effect: { kind: "tool-end", event: raw } };
	if (type === "tool_execution_update") {
		return { work, effect: { kind: "tool-update", event: raw } };
	}

	if (type === "extension_ui_request") {
		return { work, effect: { kind: "ui-request", request: raw } };
	}

	if (type === "extension_error") {
		return {
			work,
			effect: {
				kind: "extension-error",
				message: readString(raw.error) ?? "Extension error",
			},
		};
	}

	return { work };
}

// ──────────────────────────── 子代理 registry 投影 ────────────────────────────

/**
 * 合并 subagent_lifecycle / subagent_progress 帧到一条 subagent 记录。
 *
 * 帧结构（omp rpc-types）：
 * - lifecycle: { payload: { id, agent, status, parentToolCallId, sessionFile, index, description? } }
 * - progress:  { payload: { index, agent, ...身份字段, progress: { id, status, task, assignment,
 *                lastIntent, recentTools, recentOutput, toolCount, requests, tokens, cost,
 *                durationMs, resolvedModel, ... }, sessionFile } }
 *
 * lifecycle 只保证身份与终态，progress 才有运行摘要；两者按字段向后合并，
 * 避免后到的 lifecycle(completed) 把 progress 的统计清空。返回 undefined 表示这一帧
 * 没有可用的 id，调用方据此跳过（不能凭空造一条空记录）。
 */
export function mergeSubagentFrame(
	previous: AgentSubagent | undefined,
	input: { frame: "lifecycle" | "progress"; payload: Raw },
): AgentSubagent | undefined {
	const { frame, payload } = input;
	const progress = asRecord(payload.progress);
	const source = progress ?? payload;
	const id = readString(source.id) || readString(payload.id) || "";
	if (!id) return undefined;

	// omp 的 subagentId 在 session 内可能复用（同名 agent 再次派生）：新的
	// lifecycle(started) 视为全新一次运行，丢弃上一次的统计与终态，否则终态粘滞
	// 会把新运行永久钉在 completed。
	const base = frame === "lifecycle" && source.status === "started" ? undefined : previous;

	const pickText = (value: unknown) => {
		const text = readString(value);
		return text && text.trim() ? text : undefined;
	};
	const pickNum = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;

	// omp 的 lifecycle 用 "started" 表示开跑，终态用 completed/aborted/failed；
	// 对外统一 running，UI 只需判一个运行态值。
	const rawStatus = readString(source.status) || base?.status || "running";
	const normalizedStatus = rawStatus === "started" ? "running" : rawStatus;
	// 终态之间允许互相覆盖（lifecycle 的 failed/aborted 比 progress 的 completed 权威），
	// 只禁止终态回退到 running 等非终态——否则面板会永远转圈。
	const status =
		base &&
		SUBAGENT_TERMINAL_STATUSES.has(base.status) &&
		!SUBAGENT_TERMINAL_STATUSES.has(normalizedStatus)
			? base.status
			: normalizedStatus;

	const recentTools = Array.isArray(source.recentTools)
		? source.recentTools
				.filter((item): item is Raw => Boolean(asRecord(item)))
				.map((item) => ({
					tool: readString(item.tool) ?? "tool",
					args: pickText(item.args),
					isError: item.isError === true,
				}))
		: base?.recentTools;

	return {
		...(base ?? {}),
		id,
		status,
		agent: pickText(source.agent) ?? pickText(payload.agent) ?? base?.agent,
		description:
			pickText(payload.description) ?? pickText(source.description) ?? base?.description,
		index: pickNum(source.index) ?? base?.index,
		sessionFile:
			pickText(source.sessionFile) ?? pickText(payload.sessionFile) ?? base?.sessionFile,
		task: pickText(source.task) ?? base?.task,
		assignment: pickText(source.assignment) ?? base?.assignment,
		lastIntent: pickText(source.lastIntent) ?? base?.lastIntent,
		recentTools,
		toolCount: pickNum(source.toolCount) ?? base?.toolCount,
		tokens: pickNum(source.tokens) ?? base?.tokens,
		durationMs: pickNum(source.durationMs) ?? base?.durationMs,
		resolvedModel: pickText(source.resolvedModel) ?? base?.resolvedModel,
	};
}

// ──────────────────────────── get_state / stats 擦洗 ────────────────────────────

/** `get_state.queuedMessages` / `queue_update` 容错：缺失或非数组都收敛为空队列。 */
export function normalizePiQueue(value: unknown): AgentQueuedMessages {
	const readList = (list: unknown): string[] =>
		readArray(list).filter((item): item is string => typeof item === "string" && item.length > 0);
	const record = asRecord(value) ?? {};
	return { steering: readList(record.steering), followUp: readList(record.followUp) };
}

/** `get_state.usageLimit` 容错：字段缺失/类型非法时视为无限制状态，不猜 stage。 */
export function normalizeUsageLimit(value: unknown): AgentUsageLimitState | undefined {
	const source = asRecord(value);
	if (!source) return undefined;
	const resetsAtSec = pickNumber(source.resetsAtSec);
	if (source.stage === "low_priority") {
		const allowanceLeftPercent = pickNumber(source.allowanceLeftPercent);
		return {
			stage: "low_priority",
			...(resetsAtSec != null ? { resetsAtSec } : {}),
			...(allowanceLeftPercent != null ? { allowanceLeftPercent } : {}),
		};
	}
	if (source.stage === "wrap_up") {
		return {
			stage: "wrap_up",
			extraUsage: source.extraUsage === true,
			...(resetsAtSec != null ? { resetsAtSec } : {}),
		};
	}
	return undefined;
}

/** 本模块负责的 AgentRuntimeState 字段：全部来自 pi 快照，不含本地运行态。 */
export type PiRuntimeSnapshot = Required<
	Pick<
		AgentRuntimeState,
		| "isStreaming"
		| "isCompacting"
		| "fastModeEnabled"
		| "fastModeActive"
		| "slowModeSupported"
		| "slowModeEnabled"
		| "queuedMessages"
		| "todoPhases"
		| "autoCompactionEnabled"
	>
> &
	Pick<
		AgentRuntimeState,
		| "modelName"
		| "provider"
		| "modelId"
		| "thinkingLevel"
		| "contextTokens"
		| "contextWindow"
		| "contextPercent"
		| "inputTokens"
		| "outputTokens"
		| "cacheRead"
		| "cacheWrite"
		| "cacheTotal"
		| "cacheHitPercent"
		| "cost"
		| "slowModeScope"
		| "tokensPerSecond"
		| "usageLimit"
	>;

export type PiSnapshotInput = {
	/** `get_state` 的 data。 */
	state: unknown;
	/** `get_session_stats` 的 data。 */
	stats: unknown;
	/** session 文件算出的缓存命中率（RPC 不给该字段）。 */
	sessionCacheHitPercent?: number;
	/** 本地已收口（idle/error/closed）：不再上报 pi 侧的陈旧 isStreaming/isCompacting。 */
	runClosed: boolean;
	/** 本地压缩标志（compaction_end 前 pi 仍会报 isStreaming，需并入 isCompacting）。 */
	rpcCompacting: boolean;
	compacting: boolean;
};

/**
 * 把 pi 的两份快照擦洗成本模块的稳定词汇。
 *
 * 三类容错都在这儿，因为它们都是「pi 版本差异」而不是业务规则：
 * - 字段改名（tokens.input / inputTokens / prompt / usage.input 并存）；
 * - 取值装在嵌套对象里（cache.read 与 cacheRead）；
 * - 布尔可能是字符串（"false" 是 truthy，直接用会把空闲判成运行中，三点指示器卡死）。
 *
 * `runClosed` 存在的理由：status 是本地对「本轮还有没有工作」的最终裁定，pi 侧标志
 * 在 run 结束后可能仍是陈旧真值（录制故障：agent_end 后标志未清）。
 */
export function normalizeRuntimeSnapshot(input: PiSnapshotInput): PiRuntimeSnapshot {
	const state = asRecord(input.state);
	const stats = asRecord(input.stats);
	// omp 的 get_state.model 是对象（{id,name,provider,...}），旧 pi 可能是字符串模型名。
	const model =
		typeof state?.model === "string" ? { name: state.model } : asRecord(state?.model);
	const contextUsage = asRecord(stats?.contextUsage ?? stats?.context_usage);
	const tokens = asRecord(stats?.tokens);
	const usage = asRecord(stats?.usage);
	const cache = asRecord(tokens?.cache);

	const inputTokens = pickNumber(
		tokens?.input,
		tokens?.inputTokens,
		tokens?.prompt,
		tokens?.promptTokens,
		stats?.inputTokens,
		usage?.input,
	);
	const outputTokens = pickNumber(
		tokens?.output,
		tokens?.outputTokens,
		tokens?.completion,
		tokens?.completionTokens,
		stats?.outputTokens,
		usage?.output,
	);
	const cacheRead = pickNumber(tokens?.cacheRead, cache?.read, stats?.cacheRead, usage?.cacheRead);
	const cacheWrite = pickNumber(
		tokens?.cacheWrite,
		cache?.write,
		stats?.cacheWrite,
		usage?.cacheWrite,
	);
	// cacheHitRate 是 0~1 的比例，cacheHitPercent 才是百分数：两套字段并存时必须换算，
	// 否则同一个命中率会有 0.9 与 90 两种展示。
	const ratePercent = (value: unknown) => {
		const rate = pickNumber(value);
		return rate == null ? undefined : rate * 100;
	};
	const directCacheHitPercent = pickNumber(
		tokens?.cacheHitPercent,
		ratePercent(tokens?.cacheHitRate),
		stats?.cacheHitPercent,
		ratePercent(stats?.cacheHitRate),
	);
	const cacheHitPercent = clampPercent(directCacheHitPercent ?? input.sessionCacheHitPercent);

	return {
		modelName: readString(model?.name) ?? readString(model?.id),
		provider: readString(model?.provider),
		modelId: readString(model?.id),
		thinkingLevel: readString(state?.thinkingLevel) ?? readString(state?.thinking_level),
		isStreaming: !input.runClosed && normalizePiBoolean(state?.isStreaming),
		isCompacting:
			!input.runClosed &&
			(normalizePiBoolean(state?.isCompacting) || input.rpcCompacting || input.compacting),
		contextTokens: nullableNumber(contextUsage?.tokens),
		contextWindow: nullableNumber(contextUsage?.contextWindow ?? model?.contextWindow),
		contextPercent: nullableNumber(contextUsage?.percent),
		inputTokens,
		outputTokens,
		cacheRead,
		cacheWrite,
		cacheTotal:
			cacheRead != null || cacheWrite != null ? (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined,
		cacheHitPercent,
		cost: pickNumber(stats?.cost),
		fastModeEnabled: normalizePiBoolean(state?.fastModeEnabled),
		fastModeActive: normalizePiBoolean(state?.fastModeActive),
		slowModeSupported: normalizePiBoolean(state?.slowModeSupported),
		slowModeEnabled: normalizePiBoolean(state?.slowModeEnabled),
		slowModeScope: readString(state?.slowModeScope),
		queuedMessages: normalizePiQueue(state?.queuedMessages),
		todoPhases: normalizeTodoPhases(state?.todoPhases),
		tokensPerSecond: pickNumber(state?.tokensPerSecond),
		autoCompactionEnabled: normalizePiBoolean(state?.autoCompactionEnabled),
		usageLimit: normalizeUsageLimit(state?.usageLimit),
	};
}

/** `contextTokens/contextWindow/contextPercent` 允许 null（上下文尚未建立时 omp 回 null）。 */
function nullableNumber(value: unknown): number | null | undefined {
	if (value === null) return null;
	return pickNumber(value);
}
