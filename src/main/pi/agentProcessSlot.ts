import { PiProcess } from "./PiProcess";

/**
 * AgentManager 需要的 pi child 能力子集（窄接口）。
 * 生产路径是真实 PiProcess；测试经 AgentProcessFactory 注入假 child，
 * 从而覆盖 create/stop/restart/exit/reattach 整条进程生命周期。
 */
export type AgentProcessPort = Pick<
	PiProcess,
	"start" | "stop" | "isRunning" | "getDiagnostics" | "on" | "client"
>;

/**
 * 创建 pi child 的工厂端口。参数与 PiProcess 构造签名同形，
 * 默认实现即真实进程——测试注入替身时无需改生产分支。
 */
export type AgentProcessFactory = (
	...args: ConstructorParameters<typeof PiProcess>
) => AgentProcessPort;

export const createRealAgentProcess: AgentProcessFactory = (...args) => new PiProcess(...args);

/**
 * 子进程租约：每次把 child 装上 slot 时生成，对象身份即代号。
 * exit/error 回调只持有租约（不可写），事后用 slot.owns(lease) 求证归属。
 */
export type ProcessLease = {
	/** 代号：同一 slot 上每次装配 +1，日志可据此区分「第几代 child」。 */
	readonly generation: number;
	readonly process: AgentProcessPort;
};

/**
 * 单个 agent 的 pi 子进程属主。
 *
 * 「这个 child 是否仍归我所有」是结构事实，而不是散落在各处的可变布尔：
 * slot 退役（stop/restart 把 runtime 从 agents 摘除）或换代（reattach 换进程）后，
 * 旧租约立即失权，其迟到 exit/error 一律 no-op——否则会往已退役的 transcript
 * 写错误卡、把 status 拉回 starting，或触发一次注定失败的重连。
 */
export class AgentProcessSlot {
	private currentLease: ProcessLease;
	private nextGeneration = 1;
	private retired = false;

	constructor(process: AgentProcessPort) {
		this.currentLease = { generation: this.nextGeneration++, process };
	}

	/** 当前 child。退役后仍返回最后一代，供 stop/stopAll 收口。 */
	get process(): AgentProcessPort {
		return this.currentLease.process;
	}

	/** 当前租约：装配生命周期监听器时捕获它。 */
	get lease(): ProcessLease {
		return this.currentLease;
	}

	/** 装配新 child（reattach 换进程）；旧租约立即失权，不再接受它的任何事件。 */
	install(process: AgentProcessPort): ProcessLease {
		// 重新装配即重新启用：retire() 的永久失效只针对它退役的那一代。
		// 若此处不清 retired，重装后的 slot 会永远 owns()=false，新 child 的生命周期事件
		// 被静默丢弃——agent 看起来卡死却没有任何错误痕迹。
		this.retired = false;
		this.currentLease = { generation: this.nextGeneration++, process };
		return this.currentLease;
	}

	/** 该租约是否仍是当前 child——exit/error 回调的唯一守卫。 */
	owns(lease: ProcessLease): boolean {
		return !this.retired && this.currentLease === lease;
	}

	/** 退役并交回当前 child（调用方负责确认它退出）；此后任何租约都不再有效。 */
	retire(): AgentProcessPort {
		this.retired = true;
		return this.currentLease.process;
	}
}
