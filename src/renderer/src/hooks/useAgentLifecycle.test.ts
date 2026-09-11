import assert from "node:assert/strict";
import { test } from "vitest";
import { migrateAgentRecord } from "./useAgentLifecycle";

/**
 * migrateAgentRecord 的引用稳定性契约。
 *
 * 该函数在每个 agents:state 推送（≤50ms 一次）里对 promptByAgent /
 * attachedImagesByAgent 等 per-agent record 调用。返回新对象会让所有依赖
 * 这些 record 的记忆化组件失效——这正是本批次要消除的每帧无谓重渲染。
 */

test("returns the original reference when no key is renamed or pruned", () => {
	const current = { a1: "draft", a2: "other" };
	const same = migrateAgentRecord(current, new Map(), new Set(["a1", "a2"]));
	assert.equal(same, current);
});

test("allocates a new record when a key is renamed", () => {
	const current = { pending1: "draft" };
	const next = migrateAgentRecord(
		current,
		new Map([["pending1", "real1"]]),
		new Set(["real1"]),
	);
	assert.notEqual(next, current);
	assert.deepEqual(next, { real1: "draft" });
});

test("allocates a new record when a key is pruned", () => {
	const current = { a1: "draft", a2: "other" };
	const next = migrateAgentRecord(current, new Map(), new Set(["a1"]));
	assert.notEqual(next, current);
	assert.deepEqual(next, { a1: "draft" });
});

test("empty input stays empty and stable", () => {
	const current: Record<string, string> = {};
	assert.equal(migrateAgentRecord(current, new Map(), new Set()), current);
});
