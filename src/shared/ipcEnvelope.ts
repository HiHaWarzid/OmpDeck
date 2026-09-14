/**
 * invoke 通道的失败契约 —— 主进程注册循环（registerIpcHandlers）与 preload（buildApi）
 * 之间唯一的跨边界形状。
 *
 * 此前 handler 抛出的原始错误直接过界，Electron 会把它包成
 * `Error invoking remote method '<channel>': Error: <原始信息>`，命令层已经算好的失败分类
 * （CommandRunner.CommandError.kind：超时 / git 未安装 / git 报告失败）在边界被丢弃，
 * 渲染层只能靠正则反解这层包装。现在失败以「返回值」而非「抛出」的形式过界：
 *   - 成功 → { ok: true, value }，value 即 handler 的原始返回值（形状不变）
 *   - 失败 → { ok: false, kind, message }，message 是干净信息（不含 Electron 包装）
 * 因为过界的是普通对象，Electron 没有可包装的异常，包装文本从此不可能出现。
 *
 * 注意：preload 解包失败时抛出的 IpcInvokeError 是 Error 子类，而 contextBridge 只复制
 * Error 的 message/stack（自有属性按设计被剥掉），所以渲染层能拿到干净的 message，
 * 但跨 contextBridge 的生产环境下读不到 kind —— 需要按分类分支的判断请留在主进程侧
 * （如 GitService 的失败分类），渲染层只用 message。
 */
export type IpcFailureKind = "command" | "timeout" | "not-found" | "unknown";

export interface IpcInvokeSuccess {
	readonly ok: true;
	readonly value: unknown;
}

export interface IpcInvokeFailure {
	readonly ok: false;
	readonly kind: IpcFailureKind;
	readonly message: string;
}

export type IpcInvokeEnvelope = IpcInvokeSuccess | IpcInvokeFailure;

/**
 * 渲染层收到的 invoke 失败：保留 Error 语义（照旧 try/catch、读 message），
 * 并把命令层分类挂在自有属性 kind 上（vitest 环回、非 contextBridge 传输下可读）。
 */
export class IpcInvokeError extends Error {
	readonly kind: IpcFailureKind;

	constructor(kind: IpcFailureKind, message: string) {
		super(message);
		this.name = "IpcInvokeError";
		this.kind = kind;
	}
}

/**
 * 解包 invoke 结果：成功取 value，失败抛 IpcInvokeError。
 * 形状由注册循环保证（每个 invoke handler 都被包装），故这里按类型断言消费：
 * 再做一层运行时形状守卫只会在契约破损时把失败悄悄降级成「成功值为 {ok:false,...}」。
 */
export function unwrapIpcInvokeEnvelope(envelope: IpcInvokeEnvelope): unknown {
	if (envelope.ok) return envelope.value;
	throw new IpcInvokeError(envelope.kind, envelope.message);
}
