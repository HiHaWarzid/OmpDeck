/// <reference types="electron-vite/node" />
import createArchiveWorker from "./sessionArchiveWorker?nodeWorker";

/**
 * 归档解析 worker 工厂。
 *
 * 与摘要 worker 分开成模块，避免 vitest/纯 Node 测试导入 `?nodeWorker` 虚拟模块；
 * AgentManager 通过注入使用，未注入时 parseArchives 走主线程。
 */
export function createSessionArchiveWorker() {
	return createArchiveWorker({ name: "session-archive-parse" });
}
