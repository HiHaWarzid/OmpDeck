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

	assert.match(
		hookSource,
		/const activeAgentIdRef = useRef<string \| undefined>\(activeAgentId\);/,
	);
	assert.match(hookSource, /activeAgentIdRef\.current = activeAgentId;/);
	assert.match(source, /const targetAgentId = activeAgentIdRef\.current;/);
	assert.match(source, /const previous = livePromptByAgentRef\.current\[targetAgentId\] \?\? "";/);
	assert.match(source, /\[targetAgentId\]: nextValue/);
});
