import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AgentTab } from "../../shared/types";
import { OpenSessionSnapshot } from "./OpenSessionSnapshot";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "open-session-snapshot-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function tab(overrides: Partial<AgentTab>): AgentTab {
	return {
		id: "agent-1",
		projectId: "project-1",
		cwd: "D:/repo",
		title: "session",
		status: "idle",
		createdAt: 1,
		...overrides,
	};
}

function readSnapshot(): { cleanExit: boolean; sessions: Array<{ sessionPath: string }> } {
	return JSON.parse(readFileSync(join(dir, "open-sessions.json"), "utf8"));
}

test("正常退出不产生恢复数据", () => {
	const first = new OpenSessionSnapshot(dir);
	first.readCrashedRun();
	first.beginRun();
	first.recordAgents([tab({ sessionPath: "D:/a.jsonl" })]);
	first.markCleanExit();

	const restarted = new OpenSessionSnapshot(dir);
	assert.equal(restarted.readCrashedRun(), null);
	assert.equal(readSnapshot().cleanExit, true);
});

test("强杀后（未 markCleanExit）下次启动交付一次，并清空文件里的待恢复列表", () => {
	vi.useFakeTimers();
	try {
		const first = new OpenSessionSnapshot(dir);
		first.readCrashedRun();
		first.beginRun();
		first.recordAgents([tab({ sessionPath: "D:/a.jsonl" })]);
		// 不调用 markCleanExit：模拟 TerminateProcess / Ctrl-C，只让防抖写入跑完。
		vi.advanceTimersByTime(1000);
	} finally {
		vi.useRealTimers();
	}

	const second = new OpenSessionSnapshot(dir);
	const crashed = second.readCrashedRun();
	assert.ok(crashed, "非正常退出必须交付会话快照");
	assert.deepEqual(
		crashed.sessions.map((session) => session.sessionPath),
		["D:/a.jsonl"],
	);
	second.beginRun();
	assert.equal(second.takeCrashedRun()?.sessions.length, 1);
	assert.equal(second.takeCrashedRun(), null, "快照只能交付一次");
	assert.deepEqual(readSnapshot().sessions, [], "交付后应清掉待恢复列表，避免重复复活");
});

test("交付前收到空的已打开列表，不能把待恢复会话从文件里抹掉", () => {
	writeFileSync(
		join(dir, "open-sessions.json"),
		JSON.stringify({
			version: 1,
			pid: 1,
			startedAt: 2,
			cleanExit: false,
			sessions: [{ projectId: "p", sessionPath: "D:/crashed.jsonl" }],
		}),
		"utf8",
	);
	vi.useFakeTimers();
	try {
		const snapshot = new OpenSessionSnapshot(dir);
		assert.ok(snapshot.readCrashedRun());
		snapshot.beginRun();
		// agent 列表首个推送通常是空的；此时渲染层还没调用 takeCrashedRun。
		snapshot.recordAgents([]);
		vi.advanceTimersByTime(1000);
		assert.deepEqual(
			readSnapshot().sessions.map((session) => session.sessionPath),
			["D:/crashed.jsonl"],
			"未交付的会话必须留在文件里，否则这次再崩溃就永久丢了",
		);
		assert.equal(snapshot.takeCrashedRun()?.sessions.length, 1);
		vi.advanceTimersByTime(1000);
		assert.deepEqual(readSnapshot().sessions, [], "交付后恢复列表应被清空");
	} finally {
		vi.useRealTimers();
	}
});

test("匿名会话与已关闭标签不进快照", () => {
	const snapshot = new OpenSessionSnapshot(dir);
	snapshot.readCrashedRun();
	snapshot.beginRun();
	snapshot.markCleanExit();
	writeFileSync(
		join(dir, "open-sessions.json"),
		JSON.stringify({
			version: 1,
			pid: 1,
			startedAt: 2,
			cleanExit: false,
			sessions: [
				{ projectId: "p", sessionPath: "D:/keep.jsonl" },
				{ projectId: "p", sessionPath: "D:/keep.jsonl" },
				{ projectId: "p" },
				{ sessionPath: "D:/no-project.jsonl" },
				"junk",
			],
		}),
		"utf8",
	);
	const restarted = new OpenSessionSnapshot(dir);
	const crashed = restarted.readCrashedRun();
	assert.ok(crashed);
	assert.deepEqual(
		crashed.sessions.map((session) => session.sessionPath),
		["D:/keep.jsonl"],
		"损坏条目与重复会话必须被丢弃",
	);
});

test("损坏的 JSON 视为没有恢复数据，且不影响本次运行落盘", () => {
	writeFileSync(join(dir, "open-sessions.json"), "{not json", "utf8");
	const snapshot = new OpenSessionSnapshot(dir);
	assert.equal(snapshot.readCrashedRun(), null);
	snapshot.beginRun();
	assert.equal(readSnapshot().cleanExit, false);
});

test("匿名会话（noSession）不会被记录", async () => {
	const snapshot = new OpenSessionSnapshot(dir);
	snapshot.readCrashedRun();
	snapshot.beginRun();
	snapshot.recordAgents([tab({ sessionPath: undefined, noSession: true })]);
	snapshot.recordAgents([tab({ sessionPath: undefined })]);
	snapshot.recordAgents([tab({ sessionPath: "D:/closed.jsonl", status: "closed" })]);
	snapshot.markCleanExit();
	// markCleanExit 清空列表，这里只验证「没有可恢复项时不会误报崩溃恢复」。
	assert.equal(new OpenSessionSnapshot(dir).readCrashedRun(), null);
});
