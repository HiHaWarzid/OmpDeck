import assert from "node:assert/strict";
import { test, vi } from "vitest";

// electron 在 vitest（node 环境）下不可用；RpcLogger 构造只调用 app.getPath。
vi.mock("electron", () => ({
	app: { getPath: () => "C:/mock-user-data" },
}));

import { RpcLogger, type RpcLogEntry } from "./RpcLogger";

function makeEntry(overrides: Partial<RpcLogEntry> & { agentId: string }): RpcLogEntry {
	return {
		id: "e1",
		direction: "recv",
		summary: "← get_state ✓",
		data: undefined,
		time: Date.now(),
		...overrides,
	};
}

// 通过 (logger as any) 访问 private truncateData，仅验证写入前脱敏行为。
function truncate(entry: RpcLogEntry): RpcLogEntry {
	const logger = new RpcLogger() as unknown as { truncateData(e: RpcLogEntry): RpcLogEntry };
	return logger.truncateData(entry);
}

test("truncateData 小 data 原样保留", () => {
	const entry = makeEntry({ agentId: "a1", data: { type: "response", command: "get_state", success: true } });
	assert.deepEqual(truncate(entry), entry);
});

test("truncateData send bash 命令截断到 200 字符", () => {
	const entry = makeEntry({
		agentId: "a1",
		direction: "send",
		data: { type: "bash", command: "x".repeat(500) },
	});
	const result = truncate(entry) as { data: { command?: string } };
	assert.ok(result.data.command!.length <= 200);
	assert.equal(result.data.command!.length, 200);
});

test("truncateData 大 data（如大会话 get_messages 响应）替换为摘要", () => {
	const big = { type: "response", command: "get_messages", messages: new Array(1000).fill({ id: "m", text: "x".repeat(200) }) };
	const entry = makeEntry({ agentId: "a1", data: big });
	const result = truncate(entry) as {
		data: { _truncated?: boolean; type?: string; keys?: string[]; size?: number };
	};
	assert.equal(result.data._truncated, true);
	assert.equal(result.data.type, "response");
	assert.ok(result.data.keys!.includes("messages"));
	assert.ok(result.data.size! > 2048);
	// 摘要本身必须小于阈值，不能把大 data 原样写盘
	assert.ok(JSON.stringify(result).length < 2048);
});
