import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

// electron 在 vitest（node 环境）下不可用；RpcLogger 构造只调用 app.getPath。
const holder = vi.hoisted(() => ({ userData: "C:/mock-user-data" }));
vi.mock("electron", () => ({
	app: { getPath: () => holder.userData },
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

/** 建一个临时 userData，让 logger 的 dir 落在 tmp/logs/rpc 下（真实文件系统，无 mock fs）。 */
async function withTempLogger(): Promise<{ logger: RpcLogger; dir: string }> {
	const root = await mkdtemp(join(tmpdir(), "rpc-logger-"));
	holder.userData = root;
	const dir = join(root, "logs", "rpc");
	await mkdir(dir, { recursive: true });
	return { logger: new RpcLogger(), dir };
}

/** 与 RpcLogger 的 formatDate 同规则，用于断言「当日文件不被压缩」。 */
function todayString(): string {
	const today = new Date();
	return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

/** n 天前的日期串。测试必须落在 30 天保留期内，否则会被 cleanOldFiles 直接删掉。 */
function daysAgoString(days: number): string {
	const date = new Date(Date.now() - days * 86_400_000);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 等写入链跑完并等后台收尾（压缩/清理）落地。 */
async function drainWrites(logger: RpcLogger): Promise<void> {
	const probe = logger as unknown as {
		writeQueue: Promise<void>;
		sweepPromise?: Promise<void>;
	};
	await probe.writeQueue;
	await probe.sweepPromise;
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

test("首次写入前把历史遗留的未压缩 jsonl 补压缩，当日文件保持原样", async () => {
	const { logger, dir } = await withTempLogger();
	const threeDaysAgo = daysAgoString(3);
	const yesterday = daysAgoString(1);
	await writeFile(join(dir, `rpc-a1-${threeDaysAgo}.jsonl`), '{"id":"old"}\n', "utf8");
	await writeFile(join(dir, `rpc-a1-${yesterday}.jsonl`), '{"id":"older"}\n', "utf8");
	await writeFile(join(dir, `rpc-a2-${yesterday}.jsonl.gz`), "already-gzipped", "utf8");

	logger.push(makeEntry({ agentId: "a1" }));
	await drainWrites(logger);

	const files = await readdir(dir);
	// 遗留的非当日文件被压缩
	assert.ok(files.includes(`rpc-a1-${threeDaysAgo}.jsonl.gz`));
	assert.ok(!files.includes(`rpc-a1-${threeDaysAgo}.jsonl`));
	assert.ok(files.includes(`rpc-a1-${yesterday}.jsonl.gz`));
	assert.ok(!files.includes(`rpc-a1-${yesterday}.jsonl`));
	// 当日文件正常追加，不得被压缩
	assert.ok(files.includes(`rpc-a1-${todayString()}.jsonl`));
	assert.ok(!files.includes(`rpc-a1-${todayString()}.jsonl.gz`));
});

test("getFromFile 只读文件尾部、按日期取最近 days 个文件并倒序返回", async () => {
	const { logger, dir } = await withTempLogger();
	// 三天前的文件：days=1 必须排除，days=7 时排在今天的条目之后
	await writeFile(
		join(dir, `rpc-a1-${daysAgoString(3)}.jsonl`),
		`${JSON.stringify(makeEntry({ agentId: "a1", id: "old", time: 1 }))}\n`,
		"utf8",
	);
	// 今天：首行是超过尾部上限的巨型行（尾部读取会把它切断，必须丢弃半行而非报错/整体空）
	const small = Array.from({ length: 5 }, (_, i) =>
		JSON.stringify(makeEntry({ agentId: "a1", id: `m${i}`, time: 100 + i })),
	);
	await writeFile(
		join(dir, `rpc-a1-${todayString()}.jsonl`),
		`${JSON.stringify({ id: "huge", padding: "x".repeat(5 * 1024 * 1024) })}\n${small.join("\n")}\n`,
		"utf8",
	);

	const recent = await logger.getFromFile({ agentId: "a1", days: 1, limit: 10 });
	assert.deepEqual(
		recent.map((entry) => entry.id),
		["m4", "m3", "m2", "m1", "m0"],
	);
	const limited = await logger.getFromFile({ agentId: "a1", days: 1, limit: 2 });
	assert.deepEqual(
		limited.map((entry) => entry.id),
		["m4", "m3"],
	);
	const withOld = await logger.getFromFile({ agentId: "a1", days: 7, limit: 10 });
	assert.deepEqual(
		withOld.map((entry) => entry.id),
		["m4", "m3", "m2", "m1", "m0", "old"],
	);
});
