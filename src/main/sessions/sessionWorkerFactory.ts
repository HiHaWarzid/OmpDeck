/// <reference types="electron-vite/node" />
import createParseWorker from "./sessionParseWorker?nodeWorker";

/**
 * 生产环境的解析 worker 工厂。
 *
 * 单独成模块，避免 vitest/纯 Node 测试导入 `?nodeWorker`（那是 electron-vite
 * 构建期虚拟模块）。SessionScanner 通过注入使用，测试不传即走主线程路径。
 */
export function createSessionParseWorker() {
  return createParseWorker({ name: "session-summary-parse" });
}
