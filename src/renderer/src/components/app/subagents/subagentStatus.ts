/**
 * 子代理状态判定（主进程原样透传 omp registry 状态字符串）。
 *
 * lifecycle 首帧是 "started"，progress/lifecycle 用 running；两者都算运行中。
 * 单独成模块，避免面板与 transcript 弹框互相 import 形成循环依赖。
 */
import type { AgentSubagent } from "../../../../../shared/types";

export function isSubagentRunning(subagent: AgentSubagent): boolean {
	return subagent.status === "running" || subagent.status === "started";
}
