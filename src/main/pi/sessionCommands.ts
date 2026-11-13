/**
 * 会话命令 module —— 客户端可发起的会话变更的唯一入口。
 *
 * 背景：AgentManager 是语义核心，但它前面原来没有 module，每个门各自重放一遍
 * 「校验 → 副作用 → 调用」：
 *   - 桌面 IPC 的 stop 会先关终端会话（`terminalManager.closeAgent`），
 *   - 手机 HTTP 的 /stop 只调 `AgentManager.stop`，终端 pty 留在后台；
 *   - 日志也各写一份，HTTP/AFK 一路几乎没有审计记录。
 * 于是"停止一个会话到底该做哪些副作用"由各 adapter 的巧合决定，而不是由 module 保证。
 *
 * 本模块把「客户端能对会话做的变更」收成一个 interface：create / send / abort /
 * abortAndRestoreQueue / stop / restart / 队列撤回与提升。implementation 拥有：
 *   - 终端与 agent 生命周期的配对（stop/restart 必须先关终端）；
 *   - 文本归一（trim）与 accepted:false 语义结果的日志透传（校验本身归 AgentManager）；
 *   - 会话变更的统一审计日志（桌面 IPC / 手机 HTTP 两路同形）。
 *
 * 不在此处收口的部分：读路径（list/getMessages/runtimeState/历史分页）与
 * 运行控制（模型/思考档/服务档/自动压缩/todo）——后者已由 `AgentControl`
 * 以自己的 `apply(change)` interface 收口，两个 module 各自拥有一个维度。
 * AFK 编排器也不经过本模块：它在领域内部按 GLOSSARY 的约定把 AgentManager
 * 当作"被调用的 spawn 工具"，创建的 agent 没有桌面终端可回收，路由过来只多一跳。
 *
 * 依赖方向：只依赖 AgentManager 的公开变更方法（Pick 出来的结构类型），
 * 不依赖 Electron / 窗口 / IPC 通道，因此可在测试里用假 agent 与假终端直接驱动。
 */
import type {
	AbortAndRestoreQueueResult,
	AgentTab,
	CreateAgentInput,
	PromoteQueuedMessageResult,
	RemoveQueuedMessageResult,
	SendPromptInput,
	SendPromptResult,
} from "../../shared/types";
import type { AgentManager } from "./AgentManager";

/** 终端会话的最小接缝：只用于"agent 结束前先回收它的 pty"，不暴露终端模块其余能力。 */
export type SessionTerminal = {
	closeAgent(agentId: string): void;
};

export type SessionCommandLog = {
	info(scope: string, message: string, detail?: Record<string, unknown>): void | Promise<void>;
	error(scope: string, message: string, detail?: Record<string, unknown>): void | Promise<void>;
};

/** 只取 AgentManager 的变更面：读路径与事件出口不进入本 module 的依赖。 */
export type SessionCommandAgents = Pick<
	AgentManager,
	| "create"
	| "sendPrompt"
	| "abort"
	| "abortAndRestoreQueue"
	| "stop"
	| "restart"
	| "removeQueuedMessage"
	| "promoteQueuedMessage"
>;

export type SessionCommandDeps = {
	agents: SessionCommandAgents;
	terminal: SessionTerminal;
	log?: SessionCommandLog;
};

export class SessionCommands {
	constructor(private readonly deps: SessionCommandDeps) {}

	async create(input: CreateAgentInput): Promise<AgentTab> {
		try {
			const tab = await this.deps.agents.create(input);
			void this.deps.log?.info("agent", "Agent created", {
				agentId: tab.id,
				projectId: input.projectId,
				title: tab.title,
				sessionPath: tab.sessionPath,
			});
			return tab;
		} catch (error) {
			// 创建失败可能来自信任询问、项目查找或 pi 启动；统一在这里留结构化现场，
			// 桌面/手机两个客户端门不再各自补日志。platform/arch 保留给跨平台闪退类反馈对照。
			void this.deps.log?.error("agent", "Agent create failed", {
				projectId: input.projectId,
				sessionPath: input.sessionPath,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				platform: process.platform,
				arch: process.arch,
			});
			throw error;
		}
	}

	/**
	 * 发送一条 prompt。
	 *
	 * 纯委托 + 审计：空消息（无图片）是**语义拒收**，判定留在 `AgentManager`
	 * （校验唯一所有者，且它要先 `requireRuntime`——未知 agent 的报错优先级不能被
	 * 这里的预检抢走）。HTTP 门据此把 accepted:false 透传成 200 + result，
	 * 手机端按 accepted 分支提示。
	 */
	async send(input: SendPromptInput): Promise<SendPromptResult> {
		const message = input.message.trim();
		const result = await this.deps.agents.sendPrompt({ ...input, message });
		void this.deps.log?.info("agent", "Prompt sent", {
			agentId: input.agentId,
			messageLength: message.length,
			imageCount: input.images?.length ?? 0,
			streamingBehavior: input.streamingBehavior,
			// 被拒时 delivery 只在部分分支存在，日志取可选值即可。
			delivery: result.accepted ? undefined : result.delivery,
		});
		return result;
	}

	async abort(agentId: string): Promise<void> {
		await this.deps.agents.abort(agentId);
		void this.deps.log?.info("agent", "Agent aborted", { agentId });
	}

	async abortAndRestoreQueue(agentId: string): Promise<AbortAndRestoreQueueResult> {
		const result = await this.deps.agents.abortAndRestoreQueue(agentId);
		void this.deps.log?.info("agent", "Agent aborted and queue restored", {
			agentId,
			steering: result.steering.length,
			followUp: result.followUp.length,
		});
		return result;
	}

	/**
	 * 停止会话 = 回收它的终端 pty + 停止 pi 进程。
	 * 顺序固定：先关终端，避免 pty 在 agent 退出后继续持有工作目录与输出回调。
	 * 客户端门（桌面 IPC / 手机 HTTP）必须走这里，不允许只调 AgentManager.stop
	 * ——那正是手机端漏关终端的原因。AFK 的清理不走这里：它自己创建的 agent
	 * 没有桌面终端，且停任务属于编排器内部状态机。
	 */
	async stop(agentId: string): Promise<void> {
		this.deps.terminal.closeAgent(agentId);
		await this.deps.agents.stop(agentId);
		void this.deps.log?.info("agent", "Agent stopped", { agentId });
	}

	/** 重启会话同样先关终端：旧 pty 绑定的是旧进程的 cwd 与回放缓冲。 */
	async restart(agentId: string): Promise<AgentTab> {
		this.deps.terminal.closeAgent(agentId);
		const tab = await this.deps.agents.restart(agentId);
		void this.deps.log?.info("agent", "Agent restarted", { agentId });
		return tab;
	}

	async removeQueuedMessage(
		agentId: string,
		message: string,
		queue: "steering" | "followUp",
	): Promise<RemoveQueuedMessageResult> {
		const result = await this.deps.agents.removeQueuedMessage(agentId, message, queue);
		void this.deps.log?.info("agent", "Queued message removed", {
			agentId,
			queue,
			removed: result.removed,
		});
		return result;
	}

	async promoteQueuedMessage(agentId: string, message: string): Promise<PromoteQueuedMessageResult> {
		const result = await this.deps.agents.promoteQueuedMessage(agentId, message);
		void this.deps.log?.info("agent", "Queued message promoted", {
			agentId,
			promoted: result.promoted,
		});
		return result;
	}
}
