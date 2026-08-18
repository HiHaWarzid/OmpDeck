import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/App.tsx", "utf8");

test("agent creation uses a bounded timeout instead of leaving pending agents forever", () => {
	assert.match(source, /const AGENT_CREATE_TIMEOUT_MS = 60_000;/);
	assert.match(source, /withTimeout<AgentTab>\(/);
	assert.match(source, /api\.agents\.create\(\{ projectId, sessionPath, title, noSession \}\)/);
	assert.match(source, /AGENT_CREATE_TIMEOUT_MS/);
	assert.match(source, /t\("app\.agentCreateTimeout"\)/);
	// W5：pending 占位的增删统一收敛到 useAgentSessions.updatePendingAgents（ref/state 双写），
	// 成功与失败路径都用 filter 移除占位，保证 pending 生命周期有界。
	// 正则容忍换行与尾部逗号（源码 4590-4624 为 `current.filter(...,\n);` 风格）。
	assert.match(
		source,
		/updatePendingAgents\(\(current\) =>\s*current\.filter\(\(agent\) => agent\.id !== pendingTab\.id\)[\s\S]{0,40}?\);/,
	);
	assert.match(source, /showToast\(e instanceof Error \? e\.message : String\(e\), 5000\)/);
});

test("fresh agent creation registers the pending tab before selecting it", () => {
	// Session Viewer 已移除（ed0e123），原「先退出旧会话查看器再选中」契约不再适用。
	// 等价存活契约：pending 占位必须先注册进 pendingAgentsRef，再 setActiveAgentId，
	// 保证 UI 不会选中一个尚不存在的 agent（显示层从 displayAgents + pendingAgents 取 activeAgent）。
	const createAgentSource = source.slice(
		source.indexOf("async function createAgent("),
		source.indexOf("\n  function getProjectFilter"),
	);
	assert.ok(
		createAgentSource.indexOf(
			"updatePendingAgents((current) => [...current, pendingTab])",
		) < createAgentSource.indexOf("setActiveAgentId(pendingTab.id)"),
	);
});
