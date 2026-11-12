import { randomUUID } from "node:crypto";

import type {
	AgentUiAskAnswer,
	AgentUiAskOption,
	AgentUiAskQuestion,
	AgentUiRequest,
	ChatMessage,
} from "../../shared/types";
import type { AgentTranscriptState } from "./agentTranscript";
import { tryParseBatchAskEnvelope } from "./askQuestionCard";

/** 项目信任选择：本次放行 / 记住 / 拒绝。 */
export type ProjectTrustChoice = "trust-remember" | "trust-session" | "deny";

export type InteractionRuntime = {
	tab: { id: string };
	transcript: AgentTranscriptState;
	/** 未结算的交互请求（abort/取消/超时都要按这张表清理）。 */
	pendingUIRequests: Map<string, { method: string; title: string }>;
	loginFlowProviderId?: string;
	slot: { process: { client: { sendRaw(payload: Record<string, unknown>): void } } };
	run: { abortedDuringAsk?: boolean };
};

export type AgentInteractionsHost = {
	/** 取运行时；agent 已消失时返回 undefined（应答类操作静默丢弃）。 */
	runtime(agentId: string): InteractionRuntime | undefined;
	publishUiRequest(request: AgentUiRequest): void;
	publishTrustRequest(request: { requestId: string; cwd: string; projectName: string }): void;
	/** 在时间线插入一张待回答卡片。 */
	addCard(agentId: string, title: string, uiRequest: AgentUiRequest): void;
	/** 从下标处标记消息脏（删卡后调用）。 */
	markDirty(agentId: string, fromIndex: number): void;
	markMessageDirty(agentId: string, message: ChatMessage): void;
	scheduleEmit(agentId: string): void;
	/** 桌面窗口/手机长连接是否在线：没有消费者时不能把启动流程挂到超时上。 */
	hasUiResponders(): boolean;
	log?: {
		info(scope: string, message: string, detail?: Record<string, unknown>): void;
	};
};

/** 项目信任弹窗的等待上限：无人应答按拒绝处理（安全优先）。 */
export const TRUST_REQUEST_TIMEOUT_MS = 60_000;

type PendingTrust = {
	resolve(choice: ProjectTrustChoice): void;
	cwd: string;
	projectName: string;
	createdAt: number;
};

/**
 * 交互请求代理：pi 扩展的 ctx.ui.* 请求 ↔ 宿主 UI 的应答。
 *
 * 原先这些规则散在 AgentManager 五处（分发 / 应答 / 取消 / 超时 / 信任），
 * 同一个「按 requestId 找卡片」的 find+splice 写了三遍，改一处极易漏另两处。
 * 现在所有结算路径（应答、abort、pi 主动 cancel、超时）都走 `settleCard`。
 *
 * 只负责判定与协议形状；卡片插入/标脏通过 host 回调，因此可以脱离窗口与 RPC 测。
 */
export class AgentInteractions {
	private readonly pendingTrust = new Map<string, PendingTrust>();

	constructor(private readonly host: AgentInteractionsHost) {}

	/**
	 * 分发一条 `extension_ui_request`。
	 * 对话类请求写卡片等用户回答；fire-and-forget 请求只转发，不占时间线。
	 */
	open(agentId: string, typed: Record<string, unknown>): void {
		const method = String(typed.method ?? "");
		const requestId = String(typed.id ?? "");
		const runtime = this.host.runtime(agentId);
		if (!runtime) return;

		// pi 在 abort/超时后发 method:"cancel" + targetId 关闭已结算的对话框。
		// 必须按 targetId 清理，否则桌面端会留下一个永远不会被回答的问答条。
		if (method === "cancel") {
			const targetId = String(typed.targetId ?? "");
			if (!targetId) return;
			runtime.pendingUIRequests.delete(targetId);
			this.settleCard(agentId, runtime, targetId, "cancelled");
			return;
		}

		// pi RPC 协议将 setWidget / dialog 字段放在顶层，不嵌套 params
		if (method === "notify") {
			this.host.publishUiRequest({
				agentId,
				requestId,
				method,
				title: "",
				message: String(typed.message ?? ""),
				notifyType: typed.notifyType as AgentUiRequest["notifyType"],
			});
			return;
		}

		if (method === "set_editor_text") {
			this.host.publishUiRequest({
				agentId,
				requestId,
				method,
				title: "",
				text: String(typed.text ?? ""),
			});
			return;
		}

		if (method === "setWidget") {
			// Plan Mode 等扩展会频繁刷新 widget；只走 IPC 状态，不落入会话消息，避免 JSONL 被进度噪声污染。
			this.host.publishUiRequest({
				agentId,
				requestId,
				method,
				title: "",
				widgetKey: String(typed.widgetKey ?? requestId),
				widgetLines: Array.isArray(typed.widgetLines) ? (typed.widgetLines as AgentUiRequest["widgetLines"]) : undefined,
				widgetPlacement: typed.widgetPlacement as AgentUiRequest["widgetPlacement"],
			});
			return;
		}

		// omp 原生 OAuth：浏览器地址必须交给宿主打开；桌面端由登录浮层展示/打开。
		if (method === "open_url") {
			this.host.publishUiRequest({
				agentId,
				requestId,
				method,
				title: "",
				url: typeof typed.url === "string" ? typed.url : undefined,
				launchUrl: typeof typed.launchUrl === "string" ? typed.launchUrl : undefined,
				instructions: typeof typed.instructions === "string" ? typed.instructions : undefined,
				loginFlow: runtime.loginFlowProviderId !== undefined,
				loginProviderId: runtime.loginFlowProviderId,
			});
			return;
		}

		// 其他非对话 UI 方法暂不占用桌面 UI 空间。
		if (["setStatus", "setTitle"].includes(method)) return;

		// omp 原生 ask（ctx.ui.askDialog）：questions 是结构化数组，不是扩展 envelope。
		// 它只能通过 ask 协议回答（answers 数组），不能降级成 select/input。
		if (method === "ask") {
			const questions = normalizeAskQuestions(typed.questions);
			if (questions.length === 0) {
				// 没有可回答的问题就立即取消，避免 pi 侧一直等待。
				this.respond(agentId, requestId, { cancelled: true });
				return;
			}
			const title = questions.length === 1 ? questions[0].question : `提问（${questions.length} 题）`;
			runtime.pendingUIRequests.set(requestId, { method, title });
			// 原生 ask 由渲染层的常驻内联问答条承载，不插入时间线 system 卡片，
			// 避免与工具调用卡片重复展示同一个问题。
			this.host.publishUiRequest({
				agentId,
				requestId,
				method: "ask",
				title,
				askQuestions: questions,
				timeout: typeof typed.timeout === "number" ? typed.timeout : undefined,
			});
			// 超时/abort 由 pi 主动发 method:"cancel" 关闭，桌面端不再自建超时，
			// 避免两端计时竞争导致问答条提前消失。
			return;
		}

		if (!["select", "confirm", "input", "editor"].includes(method)) return;

		// select 无选项时对任何流程都无法作答：先自动取消，避免登录浮层渲染空选择器。
		if (method === "select" && (!Array.isArray(typed.options) || typed.options.length === 0)) {
			this.respond(agentId, requestId, { cancelled: true });
			return;
		}

		// 登录流程的粘贴回调/确认不进入时间线，由登录浮层承接；否则会留下
		// 一张永远无人回答的 askQuestion 卡片。
		if (runtime.loginFlowProviderId) {
			const loginTitle = String(typed.title ?? typed.question ?? "");
			runtime.pendingUIRequests.set(requestId, { method, title: loginTitle });
			this.host.publishUiRequest({
				agentId,
				requestId,
				method,
				title: loginTitle,
				options: typed.options as string[] | undefined,
				placeholder: typed.placeholder as string | undefined,
				prefill: typed.prefill as string | undefined,
				allowOther: typed.allowOther === true,
				timeout: typeof typed.timeout === "number" ? typed.timeout : undefined,
				loginFlow: true,
				loginProviderId: runtime.loginFlowProviderId,
			});
			return;
		}

		// 批量 ask envelope：扩展把 questions JSON 塞进 input 的 title；
		// 桌面端识别后渲染 Tab 问卷，而不是把整段 JSON 当普通输入题。
		const rawTitle = String(typed.title ?? typed.question ?? "");
		const batchEnvelope = tryParseBatchAskEnvelope(rawTitle);
		const request: AgentUiRequest = batchEnvelope
			? {
					agentId,
					requestId,
					method: "batch_ask",
					title: `问卷（${batchEnvelope.questions.length} 题）`,
					batchQuestions: batchEnvelope.questions as AgentUiRequest["batchQuestions"],
					batchReview: batchEnvelope.review === true,
				}
			: {
					agentId,
					requestId,
					method,
					title: rawTitle,
					options: typed.options as string[] | undefined,
					placeholder: typed.placeholder as string | undefined,
					prefill: typed.prefill as string | undefined,
					allowOther: typed.allowOther === true,
				};

		// 记录 pending UI 请求，用于 abort 时自动 cancel
		runtime.pendingUIRequests.set(requestId, { method, title: request.title });
		this.host.addCard(agentId, request.title, request);
		this.host.publishUiRequest(request);
		this.scheduleTimeout(agentId, requestId, typed.timeout);
	}

	/**
	 * 应答一次交互请求：把 `extension_ui_response` 写回 pi，并结算卡片。
	 *
	 * 注意：普通 select 取消必须走 value:null（abort/渲染层 respondCancel 均如此），
	 * 不要对 select 误发 cancelled:true，否则 pi 返回 undefined，旧 ask 扩展会选第一项。
	 */
	respond(
		agentId: string,
		requestId: string,
		response: { value?: string | boolean | null; cancelled?: boolean; confirmed?: boolean; answers?: AgentUiAskAnswer[] },
	): void {
		const runtime = this.host.runtime(agentId);
		if (!runtime) return;

		const payload: Record<string, unknown> = {
			type: "extension_ui_response",
			id: requestId,
		};
		// value 允许显式 null（取消 select）；undefined 表示字段未提供则不写入。
		if ("value" in response) payload.value = response.value;
		// pi 的 ctx.ui.confirm() 检查 confirmed 字段
		if ("confirmed" in response) payload.confirmed = response.confirmed;
		// omp 原生 ask：answers 必须按请求顺序携带全部问题，pi 会校验 id/数量。
		if ("answers" in response) payload.answers = response.answers;
		if (response.cancelled) payload.cancelled = true;
		runtime.slot.process.client.sendRaw(payload);

		runtime.pendingUIRequests.delete(requestId);
		this.settleCard(agentId, runtime, requestId, response.cancelled ? "cancelled" : "answered", response);

		// 通知渲染进程 UI 请求已完成
		this.host.publishUiRequest({ agentId, requestId, method: "", title: "", completed: true, ...response });
	}

	/**
	 * abort 时解除 pi 的阻塞并立即收掉卡片：旧 select 发 value:null（不带 cancelled），
	 * 原生 ask 必须 cancelled:true（其解析器只认这个，value:null 会触发 ToolAbortError）。
	 * 本地账本与卡片不等 pi 的 cancel 回包就清理，因为 abort 路径不一定回 cancel。
	 * 返回被解除的请求数，供调用方标记「abortedDuringAsk」。
	 */
	cancelForAbort(agentId: string): number {
		const runtime = this.host.runtime(agentId);
		if (!runtime || runtime.pendingUIRequests.size === 0) return 0;
		const pending = [...runtime.pendingUIRequests];
		for (const [requestId, info] of pending) {
			runtime.slot.process.client.sendRaw({
				type: "extension_ui_response",
				id: requestId,
				...(info.method === "ask" ? { cancelled: true } : { value: null }),
			});
		}
		runtime.pendingUIRequests.clear();
		for (const [requestId] of pending) {
			// 让渲染层立刻收起内联问答条；不能等 pi 回 cancelled（abort 路径不一定回）。
			this.settleCard(agentId, runtime, requestId, "cancelled");
		}
		return pending.length;
	}

	hasPending(agentId: string): boolean {
		return (this.host.runtime(agentId)?.pendingUIRequests.size ?? 0) > 0;
	}

	/**
	 * 请求项目信任确认，等待用户选择。
	 * 无消费者在线（headless、窗口已关闭）或超时未响应时默认拒绝（安全优先）。
	 */
	requestTrust(cwd: string, projectName: string): Promise<ProjectTrustChoice> {
		// 没有消费者就没有人能回答：直接拒绝，不把启动流程挂在 60 秒超时上。
		if (!this.host.hasUiResponders()) {
			return Promise.resolve<ProjectTrustChoice>("deny");
		}
		const requestId = randomUUID();
		const { promise, resolve } = Promise.withResolvers<ProjectTrustChoice>();
		const timer = setTimeout(() => {
			if (this.pendingTrust.delete(requestId)) {
				resolve("deny");
			}
		}, TRUST_REQUEST_TIMEOUT_MS);
		timer.unref?.();
		this.pendingTrust.set(requestId, {
			resolve: (choice) => {
				clearTimeout(timer);
				resolve(choice);
			},
			cwd,
			projectName,
			createdAt: Date.now(),
		});
		this.host.publishTrustRequest({ requestId, cwd, projectName });
		return promise;
	}

	/** 渲染进程/手机端回传用户选择，唤醒等待中的 agent 创建流程。 */
	respondTrust(requestId: string, choice: ProjectTrustChoice): void {
		const pending = this.pendingTrust.get(requestId);
		if (!pending) return;
		this.pendingTrust.delete(requestId);
		pending.resolve(choice);
	}

	/** 手机端状态轮询用：列出仍在等待确认的信任请求（不含 resolve 函数）。 */
	listTrust(): Array<{ requestId: string; cwd: string; projectName: string; createdAt: number }> {
		return [...this.pendingTrust].map(([requestId, pending]) => ({
			requestId,
			cwd: pending.cwd,
			projectName: pending.projectName,
			createdAt: pending.createdAt,
		}));
	}

	private scheduleTimeout(agentId: string, requestId: string, timeout: unknown): void {
		if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return;
		const timer = setTimeout(() => {
			const runtime = this.host.runtime(agentId);
			if (!runtime || !runtime.pendingUIRequests.has(requestId)) return;
			runtime.pendingUIRequests.delete(requestId);
			this.settleCard(agentId, runtime, requestId, "cancelled");
		}, Math.floor(timeout));
		timer.unref?.();
	}

	/**
	 * 结算一张 askQuestion 卡片：cancelled 直接删（不留时间线痕迹），answered 标记状态。
	 * pi 主动 cancel、本地超时、用户应答、abort 都经过这里，避免三份 find+splice 漂移。
	 */
	private settleCard(
		agentId: string,
		runtime: InteractionRuntime,
		requestId: string,
		outcome: "answered" | "cancelled",
		response?: Record<string, unknown>,
	): void {
		const messages = runtime.transcript.messages;
		const idx = messages.findIndex((message) => cardRequestId(message) === requestId);
		if (idx === -1) {
			// 原生 ask 不建卡片：只有回答/取消事件要发给渲染层。
			if (outcome === "cancelled") {
				this.host.publishUiRequest({
					agentId,
					requestId,
					method: "",
					title: "",
					completed: true,
					cancelled: true,
				});
			}
			return;
		}
		if (outcome === "cancelled") {
			messages.splice(idx, 1);
			this.host.markDirty(agentId, idx);
			this.host.scheduleEmit(agentId);
			this.host.publishUiRequest({ agentId, requestId, method: "", title: "", completed: true, cancelled: true });
			return;
		}
		const meta = messages[idx].meta as Record<string, unknown>;
		meta.status = "answered";
		meta.response = response;
		this.host.markMessageDirty(agentId, messages[idx]);
		this.host.scheduleEmit(agentId);
	}
}

/** 卡片消息携带的 requestId（仅 system + askQuestion 卡片）。 */
function cardRequestId(message: ChatMessage): string | undefined {
	if (message.role !== "system" || message.meta?.type !== "askQuestion") return undefined;
	const uiRequest = (message.meta as Record<string, unknown>).uiRequest;
	if (!uiRequest || typeof uiRequest !== "object") return undefined;
	const requestId = (uiRequest as Record<string, unknown>).requestId;
	return typeof requestId === "string" ? requestId : undefined;
}

/**
 * 清洗 omp ask 的 questions 载荷。pi 端已做类型校验，但 RPC 输入是 unknown：
 * 这里只放宽展示/回答必需字段，丢弃无 question 或非法 option 的条目，
 * 保证 answer 数组与 id 顺序不会因为脏字段错位。
 */
export function normalizeAskQuestions(raw: unknown): AgentUiAskQuestion[] {
	if (!Array.isArray(raw)) return [];
	const questions: AgentUiAskQuestion[] = [];
	for (const [index, item] of raw.entries()) {
		if (!item || typeof item !== "object") continue;
		const source = item as Record<string, unknown>;
		const question = typeof source.question === "string" ? source.question : "";
		if (!question) continue;
		const options: AgentUiAskOption[] = [];
		if (Array.isArray(source.options)) {
			for (const option of source.options) {
				if (typeof option === "string") {
					options.push({ label: option });
					continue;
				}
				if (!option || typeof option !== "object") continue;
				const opt = option as Record<string, unknown>;
				if (typeof opt.label !== "string") continue;
				options.push({
					label: opt.label,
					description: typeof opt.description === "string" ? opt.description : undefined,
					preview: typeof opt.preview === "string" ? opt.preview : undefined,
				});
			}
		}
		const recommended =
			typeof source.recommended === "number" &&
			Number.isInteger(source.recommended) &&
			source.recommended >= 0 &&
			source.recommended < options.length
				? source.recommended
				: undefined;
		questions.push({
			id: typeof source.id === "string" && source.id ? source.id : `q${index + 1}`,
			question,
			header: typeof source.header === "string" ? source.header : undefined,
			options,
			multi: source.multi === true,
			recommended,
		});
	}
	// 任何一道题被丢弃都会让 answers 数量与 pi 的 questions 错位（pi 会拒绝整包），
	// 因此宁可整体取消，也不提交半份问卷。
	return questions.length === raw.length ? questions : [];
}
