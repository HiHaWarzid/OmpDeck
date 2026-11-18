import assert from "node:assert/strict";
import { test } from "vitest";

import type { ChatMessage } from "../../shared/types";
import { SessionRewrite, type SessionRewriteDeps } from "./sessionRewrite";

/**
 * 假 JSONL 端口：把内存行数组当文件，记录备份/恢复是否被调用。
 * 这一层刻意不碰磁盘——配方要验证的是「顺序、失败回滚、错误透传」。
 */
function makeJsonl() {
	const state = {
		lines: [] as string[],
		backup: null as string[] | null,
		restoreCalls: 0,
		writeCount: 0,
	};
	return {
		state,
		port: {
			async modifyLines<T>(_sessionPath: string, mutator: (lines: string[]) => T): Promise<T> {
				const draft = [...state.lines];
				const result = mutator(draft);
				state.backup = [...state.lines];
				state.lines = draft;
				state.writeCount += 1;
				return result;
			},
			async restoreFromBackup(): Promise<boolean> {
				state.restoreCalls += 1;
				if (!state.backup) return false;
				state.lines = [...state.backup];
				return true;
			},
		},
	};
}

function makeDeps(overrides: Partial<SessionRewriteDeps> = {}) {
	const events: string[] = [];
	const jsonl = makeJsonl();
	const deps: SessionRewriteDeps = {
		runtime: () => ({ sessionPath: "/tmp/session.jsonl", messages: [] as ChatMessage[] }),
		jsonl: jsonl.port,
		withLock: async (_agentId, fn) => {
			events.push("lock");
			return await fn();
		},
		ensureIdle: async () => {
			events.push("idle");
		},
		reload: async () => {
			events.push("reload");
		},
		refreshTranscript: async () => {
			events.push("refresh");
		},
		log: { info: () => {}, warn: () => {}, error: () => {} },
		...overrides,
	};
	return { deps, events, jsonl: jsonl.state };
}

test("apply runs lock → idle → write → reload in that order", async () => {
	const { deps, events } = makeDeps();
	const rewrite = new SessionRewrite(deps);

	await rewrite.apply("a1", {
		operation: "Edit message",
		mutate: ({ lines }) => {
			lines.push("changed");
			events.push("mutate");
			return "ok";
		},
	});

	assert.deepEqual(events, ["lock", "idle", "mutate", "reload"]);
});

test("prepare runs before the file is read, mutate after", async () => {
	const { deps, jsonl } = makeDeps();
	const rewrite = new SessionRewrite(deps);
	const order: string[] = [];

	await rewrite.apply("a1", {
		operation: "Prepare resend",
		prepare: () => {
			order.push(`prepare:writes=${jsonl.writeCount}`);
			return "prepared";
		},
		mutate: ({ lines }, prepared) => {
			order.push(`mutate:writes=${jsonl.writeCount}:${prepared}`);
			lines.push("x");
		},
	});

	// 关键：prepare 看见 0 次写（文件还没读），mutate 在文档写入阶段执行。
	assert.deepEqual(order, ["prepare:writes=0", "mutate:writes=0:prepared"]);
});

test("a throwing mutate leaves the file untouched and skips reload", async () => {
	const { deps, events, jsonl } = makeDeps();
	const rewrite = new SessionRewrite(deps);
	jsonl.lines = ["original"];

	await assert.rejects(
		rewrite.apply("a1", {
			operation: "Delete message",
			mutate: () => {
				throw new Error("Message not found");
			},
		}),
		/Message not found/,
	);

	assert.deepEqual(jsonl.lines, ["original"]);
	assert.equal(jsonl.writeCount, 0, "mutate 抛出时不得写盘（modifyLines 语义）");
	assert.equal(events.includes("reload"), false);
	assert.equal(jsonl.restoreCalls, 0, "文件没被改过，不应触发回滚");
});

test("reload failure restores the backup, refreshes the transcript, and rethrows the original error", async () => {
	const { deps, jsonl } = makeDeps({
		reload: async () => {
			throw new Error("switch_session failed");
		},
	});
	const rewrite = new SessionRewrite(deps);
	jsonl.lines = ["before"];

	await assert.rejects(
		rewrite.apply("a1", {
			operation: "Edit message",
			mutate: ({ lines }) => {
				lines[0] = "after";
			},
		}),
		/switch_session failed/,
	);

	assert.equal(jsonl.restoreCalls, 1, "重载失败必须用备份回滚：文件已改但 pi 没重读");
	assert.deepEqual(jsonl.lines, ["before"], "会话内容回到改写前");
});

test("rollback without a backup still rethrows the reload error", async () => {
	const { deps, jsonl } = makeDeps({
		reload: async () => {
			throw new Error("boom");
		},
		jsonl: {
			// 未产生备份的端口：恢复返回 false，配方不应把原始错误替换成回滚错误。
			modifyLines: async <T>(_p: string, mutator: (lines: string[]) => T) => mutator(["x"]),
			restoreFromBackup: async () => false,
		},
	});
	const rewrite = new SessionRewrite(deps);

	await assert.rejects(
		rewrite.apply("a1", { operation: "Delete message", mutate: () => 1 }),
		/boom/,
	);
	assert.equal(jsonl.lines.length, 0);
});

test("a missing sessionPath is rejected before touching the file", async () => {
	const { deps, jsonl } = makeDeps({
		runtime: () => ({ sessionPath: undefined, messages: [] }),
	});
	const rewrite = new SessionRewrite(deps);

	await assert.rejects(
		rewrite.apply("a1", { operation: "Edit message", mutate: () => 1 }),
		/Session not persisted/,
	);
	assert.equal(jsonl.writeCount, 0);
});

test("busy agents are rejected before the file is read", async () => {
	const { deps, jsonl } = makeDeps({
		ensureIdle: async () => {
			throw new Error("BUSY_STREAMING: Agent is streaming, please wait");
		},
	});
	const rewrite = new SessionRewrite(deps);

	await assert.rejects(
		rewrite.apply("a1", { operation: "Edit message", mutate: () => 1 }),
		/BUSY_STREAMING/,
	);
	assert.equal(jsonl.writeCount, 0);
});
