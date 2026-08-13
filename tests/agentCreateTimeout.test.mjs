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
	assert.match(source, /pendingAgentsRef\.current = pendingAgentsRef\.current\.filter/);
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
			"pendingAgentsRef.current = [...pendingAgentsRef.current, pendingTab]",
		) < createAgentSource.indexOf("setActiveAgentId(pendingTab.id)"),
	);
});
