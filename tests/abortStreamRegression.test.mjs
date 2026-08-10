import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归护栏：手动停止后不应再把“系统状态”写进时间线，
 * 且 abort 后的残留 thinking/text 事件必须走 generation 闸门硬拦截。
 * 这类问题修过又回归过多次，用源码契约测试锁定关键路径。
 */
test("abort feedback is toast-only and seals stream generation", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const streamGate = readFileSync("src/main/pi/streamGate.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");

	// 1) 停止反馈不得再 addMessage 系统卡片
	assert.doesNotMatch(
		agentManager,
		/addMessage\(runtime,\s*"system",\s*"已请求停止当前响应"/,
	);
	assert.match(agentManager, /ipcChannels\.agentsNotice/);
	assert.match(ipc, /agentsNotice:\s*"agents:notice"/);

	// 2) abort 必须封印 stream generation，并走 settled 协同解封
	// 现在所有 stream gate 调用接收 runtime（不再按 agentId 索引 Map）
	assert.match(agentManager, /this\.sealAgentStream\(runtime\)/);
	assert.match(agentManager, /this\.openAgentStream\(runtime\)/);
	assert.match(agentManager, /this\.noteAgentAbortSettled\(runtime\)/);
	assert.match(agentManager, /isAgentStreamSealed\(runtime\)/);
	assert.match(streamGate, /sealedGeneration/);
	assert.match(streamGate, /currentGeneration/);
	assert.match(streamGate, /waitingForAbortSettled/);
	assert.match(streamGate, /pendingOpenAfterSettled/);

	// 3) message_update / tool 事件不得再依赖“有 activeAssistantMessageId 就放行”的例外
	// AgentRuntime 化后：recentlyAborted 是 runtime 字段，activeAssistantMessageId 也是 runtime 字段
	assert.doesNotMatch(
		agentManager,
		/runtime\.recentlyAborted\s*&&\s*!runtime\.activeAssistantMessageId/,
	);
	assert.doesNotMatch(
		agentManager,
		/runtime\.recentlyAborted\s*&&\s*!runtime\.activeToolCalls/,
	);

	// 4) agent_settled 必须 noteAbortSettled，但不得直接 openAgentStream
	const settledBlock = agentManager.match(
		/if \(typed\.type === "agent_settled"\) \{[\s\S]*?\n\t\t\}/,
	)?.[0] ?? "";
	assert.match(settledBlock, /noteAgentAbortSettled\(runtime\)/);
	assert.match(settledBlock, /runtime\.recentlyAborted\s*=\s*false/);
	assert.doesNotMatch(settledBlock, /openAgentStream/);

	// 5) 前端 abort 立即清本地 thinking，并订阅 notice toast
	assert.match(app, /setStreamingThinking\(/);
	assert.match(app, /api\.agents\.onNotice/);
	assert.match(app, /showNotice\(/);
});
