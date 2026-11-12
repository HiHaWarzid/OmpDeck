import type {
	AgentRuntimeState,
	AgentTodoItem,
	AgentTodoPhase,
	AgentTodoStatus,
	AvailableModel,
} from "../../shared/types";
import type { RpcResponse } from "./PiRpcClient";

/** omp todo 任务的可接受状态；用于把 RPC unknown 收窄为 AgentTodoStatus。 */
export const AGENT_TODO_STATUSES: Record<AgentTodoStatus, true> = {
	pending: true,
	in_progress: true,
	completed: true,
	abandoned: true,
	blocked: true,
};

/**
 * 控制模块只用到运行时的三件事：发 RPC、记住用户选过的模型、回读状态。
 * 不导入 AgentRuntime，避免模块与 AgentManager 互相依赖。
 */
export type ControlRuntime = {
	slot: { process: { client: { request(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse> } } };
	/** 用户最近一次显式选择的模型；developer-role 自愈与断线恢复要靠它定位 provider。 */
	lastModelSelection?: { provider: string; modelId: string; thinkingLevel?: string };
};

export type AgentControlHost = {
	/** 取运行时；agent 不存在时抛错（与 AgentManager.requireRuntime 语义一致）。 */
	runtime(agentId: string): ControlRuntime;
	/** 回读运行状态：所有写操作都以 omp 的 get_state 为准，不返回乐观值。 */
	readState(agentId: string): Promise<AgentRuntimeState>;
	/** refresh 成功后重新拉取会话消息（模型配置变化可能改变上下文窗口）。 */
	reloadTranscript(agentId: string): Promise<void>;
	/** tab 状态变了，通知渲染层重新取一次。 */
	emitState(): void;
	log?: {
		info(scope: string, message: string, detail?: Record<string, unknown>): void;
	};
};

/**
 * 一次控制变更。用判别联合而不是 11 个同级方法：调用方只学一个入口，
 * 「哪些档位可改、每个档位要什么参数」由类型表达。
 */
export type ControlChange =
	/** 指定模型（记录为用户显式选择，供自愈定位 provider）。 */
	| { kind: "model"; provider: string; modelId: string }
	/** 在可用模型间轮换。 */
	| { kind: "model-cycle" }
	/** 指定思考档位。 */
	| { kind: "thinking"; level: string }
	/** 在可用思考档位间轮换。 */
	| { kind: "thinking-cycle" }
	/** 服务档：fast = 优先通道，slow = 深思通道。 */
	| { kind: "service-tier"; tier: "fast" | "slow"; enabled: boolean }
	/** 会话自动压缩开关（只影响后续溢出，不立即压缩）。 */
	| { kind: "auto-compaction"; enabled: boolean }
	/** 下发会话 todo（宿主 UI 的勾选/推进走这里，不是只读展示）。 */
	| { kind: "todos"; phases: AgentTodoPhase[] };

/**
 * 运行控制：模型 / 思考档 / 服务档 / 自动压缩 / todo 的唯一入口。
 *
 * 原先这 11 个方法各自重复「取运行时 → 发请求 → 读状态」，业务差异只藏在
 * 超时毫秒数和是否检查 `success:false` 里，既测不了也拦不住。现在：
 * - 写操作统一走 `apply`，返回 get_state 回读值；
 * - 能力查询统一走 `models` / `thinkingLevels`；
 * - `refresh` 单独保留，因为它是一条带降级策略的探测，不是一次开关。
 */
export class AgentControl {
	constructor(private readonly host: AgentControlHost) {}

	async apply(agentId: string, change: ControlChange): Promise<AgentRuntimeState> {
		const runtime = this.host.runtime(agentId);
		const client = runtime.slot.process.client;
		switch (change.kind) {
			case "model":
				await client.request({ type: "set_model", provider: change.provider, modelId: change.modelId }, 60_000);
				// 记录用户显式选择：若之后进程在 developer-role 失败中退出，自愈仍能定位 provider。
				runtime.lastModelSelection = { provider: change.provider, modelId: change.modelId };
				break;
			case "model-cycle":
				await client.request({ type: "cycle_model" }, 60_000);
				break;
			case "thinking":
				await client.request({ type: "set_thinking_level", level: change.level }, 60_000);
				break;
			case "thinking-cycle":
				await client.request({ type: "cycle_thinking_level" }, 60_000);
				break;
			case "service-tier":
				// PiRpcClient 只在超时/断连时 reject，omp 的业务错误以 success:false 返回；
				// 不检查会把「模型无优先通道」静默当成成功。
				await this.requireSuccess(
					client.request(
						{ type: change.tier === "fast" ? "set_fast_mode" : "set_slow_mode", enabled: change.enabled },
						30_000,
					),
					`set_${change.tier}_mode`,
				);
				break;
			case "auto-compaction":
				await this.requireSuccess(
					client.request({ type: "set_auto_compaction", enabled: change.enabled }, 30_000),
					"set_auto_compaction",
				);
				break;
			case "todos":
				if (!Array.isArray(change.phases)) throw new Error("set_todos: phases must be an array");
				await this.requireSuccess(
					client.request(
						{ type: "set_todos", phases: normalizeTodoPhases(change.phases) },
						30_000,
					),
					"set_todos",
				);
				break;
		}
		return this.host.readState(agentId);
	}

	/** 可对话模型列表（目录里的 embedding/vision 条目不能 set_model，直接滤掉）。 */
	async models(agentId: string): Promise<AvailableModel[]> {
		const runtime = this.host.runtime(agentId);
		const response = await runtime.slot.process.client.request({ type: "get_available_models" }, 60_000);
		const models = ((response.data as { models?: unknown } | undefined)?.models ?? []) as AvailableModel[];
		// 旧版没有 kind 字段，按可对话处理。
		return Array.isArray(models) ? models.filter((model) => !model.kind || model.kind === "chat") : [];
	}

	/**
	 * 当前模型的可用思考档位。老版本没有该命令时返回空数组，
	 * 渲染层回退到内置档位表，因此这里不能抛错。
	 */
	async thinkingLevels(agentId: string): Promise<string[]> {
		const runtime = this.host.runtime(agentId);
		const response = await runtime.slot.process.client.request({ type: "get_available_thinking_levels" }, 15_000);
		const levels = (response.data as { levels?: unknown } | undefined)?.levels;
		if (!Array.isArray(levels)) return [];
		return levels.filter((level): level is string => typeof level === "string" && !!level);
	}

	/**
	 * 刷新模型配置：让运行中的 agent 重新加载 models.json，无需完全重启。
	 *
	 * 只做轻量级 reload_config 探测。进程重启方案被否：运行中重启会打断正在进行的
	 * 对话/工具执行，还涉及 exit 事件竞态；pi 支持 reload_config 后本方法自动生效
	 * （见 https://github.com/earendil-works/pi/issues/6890）。
	 */
	async refresh(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.host.runtime(agentId);
		const startTime = Date.now();
		this.host.log?.info("agent", "Model refresh requested", { agentId });
		try {
			const response = await runtime.slot.process.client.request({ type: "reload_config" }, 8_000);
			if (response.success) {
				await this.host.reloadTranscript(agentId).catch(() => undefined);
				this.host.log?.info("agent", "Model refresh succeeded via reload_config RPC", {
					agentId,
					elapsedMs: Date.now() - startTime,
				});
				this.host.emitState();
				return this.host.readState(agentId);
			}
		} catch {
			// 当前 pi 版本没有 reload_config：落到下面的跳过路径。
		}
		this.host.log?.info("agent", "Model refresh: reload_config not supported by current pi version, skipping", {
			agentId,
			elapsedMs: Date.now() - startTime,
		});
		this.host.emitState();
		return this.host.readState(agentId);
	}

	private async requireSuccess(pending: Promise<RpcResponse>, command: string): Promise<RpcResponse> {
		const response = await pending;
		if (!response.success) throw new Error(response.error?.trim() || `${command} failed`);
		return response;
	}
}

/**
 * get_state.todoPhases / set_todos 入参共用的五态归一化。
 * omp 的 TodoItem 还带 blocker/details/notes；这里完整保留，避免用户点击
 * 切换状态后再次下发时把 blocked 任务的等待原因丢掉。
 */
export function normalizeTodoPhases(value: unknown): AgentTodoPhase[] {
	if (!Array.isArray(value)) return [];
	const phases: AgentTodoPhase[] = [];
	for (const rawPhase of value) {
		if (!rawPhase || typeof rawPhase !== "object") continue;
		const phase = rawPhase as Record<string, unknown>;
		if (typeof phase.name !== "string") continue;
		const tasks: AgentTodoItem[] = [];
		if (Array.isArray(phase.tasks)) {
			for (const rawTask of phase.tasks) {
				if (!rawTask || typeof rawTask !== "object") continue;
				const task = rawTask as Record<string, unknown>;
				if (typeof task.content !== "string" || !task.content) continue;
				if (typeof task.status !== "string") continue;
				if (AGENT_TODO_STATUSES[task.status as AgentTodoStatus] !== true) continue;
				const notes = Array.isArray(task.notes)
					? task.notes.filter((note): note is string => typeof note === "string")
					: undefined;
				tasks.push({
					content: task.content,
					status: task.status as AgentTodoStatus,
					...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}),
					...(typeof task.details === "string" ? { details: task.details } : {}),
					...(notes && notes.length > 0 ? { notes } : {}),
				});
			}
		}
		phases.push({ name: phase.name, tasks });
	}
	return phases;
}
