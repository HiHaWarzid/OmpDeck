/**
 * 为 Promise 添加超时保护：超时后 reject 并清理定时器。
 * 用于会话扫描、Agent 创建等可能长时间无响应的 IPC 调用，避免 UI 永久等待。
 */
export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}
