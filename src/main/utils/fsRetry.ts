/**
 * fs 原子写共享工具：rename 瞬态锁重试。
 *
 * Windows 上文件被其他进程（杀软实时监控/勒索防护、云同步、索引服务）持有句柄时，
 * rename 会抛 EPERM/EBUSY，且通常是瞬时锁（几十毫秒级）。本模块提供统一的
 * 退避重试，供各 store 的「写 tmp → rename 原子替换」使用，避免把瞬态锁误判为致命错误。
 */

import { rename } from "node:fs/promises";

/** 重试延迟序列（ms）：首次立即重试，随后 20/75/200ms 退避，总窗口约 300ms。 */
export const RENAME_RETRY_DELAYS = [0, 20, 75, 200];

/** 判断错误是否为 rename 的瞬态锁冲突（EPERM/EBUSY），可安全重试。 */
export function isTransientRenameError(error: unknown): boolean {
	if (error && typeof error === "object" && "code" in error) {
		const code = error.code;
		return code === "EPERM" || code === "EBUSY";
	}
	return false;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * 对 rename 的瞬态锁冲突做退避重试；重试耗尽后抛出最后一次错误。
 * 非 EPERM/EBUSY 错误（如 ENOENT 源缺失）立即抛出，不做无谓重试。
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
	let lastError: unknown;
	for (const wait of RENAME_RETRY_DELAYS) {
		if (wait) await delay(wait);
		try {
			await rename(from, to);
			return;
		} catch (error) {
			lastError = error;
			if (!isTransientRenameError(error)) throw error;
		}
	}
	throw lastError;
}
