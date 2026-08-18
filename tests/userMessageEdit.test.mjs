import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("user message edit handler does not keep the initial empty active agent", () => {
	const source = readFileSync("src/renderer/src/App.tsx", "utf8");
	// activeAgentIdRef 声明与同步已从 App.tsx 内联搬进 useAgentSessions hook（App.tsx 解构使用）
	const hookSource = readFileSync(
		"src/renderer/src/hooks/useAgentSessions.ts",
		"utf8",
	);
	// W5：live prompt 的 ref/state 双写收敛到 useAgentLifecycle（getLivePrompt/setLivePrompt）——
	// “编辑前从 live ref 读 previous、写入 nextValue” 的安全模式现位于 setLivePrompt 内部，
	// 保证编辑/发送路径总是以该 agent 自己的最新草稿为基准（而非渲染作用域的陈旧值）。
	const lifecycleSource = readFileSync(
		"src/renderer/src/hooks/useAgentLifecycle.ts",
		"utf8",
	);

	assert.match(
		hookSource,
		/const activeAgentIdRef = useRef<string \| undefined>\(activeAgentId\);/,
	);
	assert.match(hookSource, /activeAgentIdRef\.current = activeAgentId;/);
	assert.match(source, /const targetAgentId = activeAgentIdRef\.current;/);
	assert.match(
		lifecycleSource,
		/const previous = livePromptByAgentRef\.current\[agentId\] \?\? "";/,
	);
	assert.match(lifecycleSource, /const nextValue = typeof value === "function" \? value\(previous\) : value;/);
});
