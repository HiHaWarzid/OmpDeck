import assert from "node:assert/strict";
import { test } from "vitest";

import {
	FollowUpQueue,
	WITHDRAWN_FOLLOW_UP_TTL_MS,
	deferredMatchesText,
	queuedTexts,
	type DeferredFollowUp,
} from "./followUpQueue";

function entry(text: string, extra?: Partial<DeferredFollowUp>): DeferredFollowUp {
	return {
		text,
		queueText: text,
		meta: { streamingBehavior: "followUp" },
		...extra,
	};
}

function snapshot(steering: string[], followUp: string[] = []) {
	return { steering, followUp };
}

test("准入对账：快照里没有它就是已投递，立刻返回气泡", () => {
	const queue = new FollowUpQueue();
	const result = queue.admit(entry("A"), snapshot([]), 1_000);
	assert.deepEqual(result.delivered.map((item) => item.text), ["A"]);
	assert.equal(queue.pending.length, 0);
});

test("准入对账：快照读不到时按乐观投递处理，气泡不能永久丢失", () => {
	const queue = new FollowUpQueue();
	const result = queue.admit(entry("A"), undefined, 1_000);
	assert.equal(result.queued, false);
	assert.equal(result.delivered.length, 1);
});

test("准入对账：仍在队列里就压着气泡，等离队事件", () => {
	const queue = new FollowUpQueue();
	const result = queue.admit(entry("A"), snapshot(["A"]), 1_000);
	assert.equal(result.queued, true);
	assert.equal(result.delivered.length, 0);
	assert.equal(queue.pending.length, 1);
});

test("准入对账：对账窗口内已撤回的消息不落气泡", () => {
	const queue = new FollowUpQueue();
	queue.markWithdrawn("A");
	const result = queue.admit(entry("A"), snapshot([]), 1_000);
	assert.deepEqual(result, { queued: false, delivered: [] });
});

test("准入对账竞态：发送之后到达的队列快照已把它投递时立刻补气泡", () => {
	const queue = new FollowUpQueue();
	queue.noteSnapshot(snapshot([]), 2_000);
	const result = queue.admit(entry("A"), snapshot(["A"]), 1_000);
	assert.equal(result.queued, false);
	assert.deepEqual(result.delivered.map((item) => item.text), ["A"]);
	assert.equal(queue.pending.length, 0);
});

test("离队结算：同文案连发时先投递靠前那条，尾部条目继续压着", () => {
	const queue = new FollowUpQueue();
	const first = entry("继续", { meta: { seq: 1 } });
	const second = entry("继续", { meta: { seq: 2 } });
	queue.admit(first, snapshot(["继续"]), 1_000);
	queue.admit(second, snapshot(["继续"]), 1_001);
	assert.equal(queue.pending.length, 2);

	const delivered = queue.settle(snapshot(["继续"]));
	assert.deepEqual(delivered, [first]);
	assert.deepEqual(queue.pending, [second]);

	assert.deepEqual(queue.settle(snapshot([])), [second]);
	assert.equal(queue.pending.length, 0);
});

test("离队结算：剩余条数决定投递哪几条，倒序保留与真实投递内容对齐", () => {
	const queue = new FollowUpQueue();
	const first = entry("继续", { meta: { seq: 1 } });
	const second = entry("继续", { meta: { seq: 2 } });
	queue.admit(first, snapshot(["继续", "继续"]), 1_000);
	queue.admit(second, snapshot(["继续", "继续"]), 1_001);

	const delivered = queue.settle(snapshot(["继续"]));
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0], first, "先投递先落气泡");
	assert.equal(queue.pending.length, 1);
	assert.equal(queue.pending[0], second);
});

test("离队结算：plan 模式的隐藏标记用 queueText 匹配", () => {
	const queue = new FollowUpQueue();
	const planEntry = entry("继续", { queueText: "继续\n\n[plan]" });
	queue.admit(planEntry, snapshot(["继续\n\n[plan]"]), 1_000);

	assert.deepEqual(queue.settle(snapshot(["继续\n\n[plan]"])), []);
	assert.deepEqual(queue.settle(snapshot([])), [planEntry]);
});

test("离队结算：本进程撤回造成的离队不算投递", () => {
	const queue = new FollowUpQueue();
	queue.admit(entry("A"), snapshot(["A"]), 1_000);
	queue.markWithdrawn("A");

	assert.deepEqual(queue.settle(snapshot([])), []);
	assert.equal(queue.pending.length, 1, "撤回的条目留在账本里等撤回回执处理");
});

test("墓碑过期后同文案的新消息可以正常投递", () => {
	const queue = new FollowUpQueue();
	queue.markWithdrawn("A", 1_000);
	assert.equal(queue.isWithdrawn(entry("A"), 1_000 + WITHDRAWN_FOLLOW_UP_TTL_MS - 1), true);
	assert.equal(queue.isWithdrawn(entry("A"), 1_000 + WITHDRAWN_FOLLOW_UP_TTL_MS), false);
});

test("撤回取回：同文案只取首条，且只匹配 text/queueText", () => {
	const queue = new FollowUpQueue();
	queue.admit(entry("继续"), snapshot(["继续", "继续"]), 1_000);
	queue.admit(entry("继续"), snapshot(["继续", "继续"]), 1_001);

	assert.equal(queue.takeWithdrawn("继续")?.text, "继续");
	assert.equal(queue.pending.length, 1);
	assert.equal(queue.takeWithdrawn("不存在"), undefined);
});

test("中止恢复：名单内的条目丢弃快照，名单外的补气泡", () => {
	const queue = new FollowUpQueue();
	const queued = entry("恢复我");
	const delivered = entry("已投递");
	queue.admit(queued, snapshot(["恢复我", "已投递"]), 1_000);
	queue.admit(delivered, snapshot(["恢复我", "已投递"]), 1_001);

	assert.deepEqual(queue.resolveRestore(["恢复我"], false), [delivered]);
	assert.equal(queue.pending.length, 0);
});

test("中止恢复：truncated 时全部丢弃，宁少一条气泡也不塞未执行的消息", () => {
	const queue = new FollowUpQueue();
	queue.admit(entry("A"), snapshot(["A"]), 1_000);
	assert.deepEqual(queue.resolveRestore(["A"], true), []);
	assert.equal(queue.pending.length, 0);
});

test("进程退出/重连重置：队列、墓碑、快照全部作废", () => {
	const queue = new FollowUpQueue();
	queue.noteSnapshot(snapshot(["A"]));
	queue.markWithdrawn("A");
	queue.admit(entry("B"), snapshot(["B"]), 1_000);

	queue.reset();

	assert.equal(queue.pending.length, 0);
	assert.equal(queue.snapshot, undefined);
	assert.equal(queue.snapshotAt, 0);
	assert.equal(queue.hasWithdrawn("A"), false);
});

test("匹配规则：text 与 queueText 任一命中即同一条", () => {
	const planEntry = entry("继续", { queueText: "继续 [plan]" });
	assert.equal(deferredMatchesText(planEntry, "继续"), true);
	assert.equal(deferredMatchesText(planEntry, "继续 [plan]"), true);
	assert.equal(deferredMatchesText(planEntry, "别的"), false);
	assert.deepEqual(queuedTexts(snapshot(["a"], ["b"])), ["a", "b"]);
});
