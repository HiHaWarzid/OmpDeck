import assert from "node:assert/strict";
import { test } from "vitest";

import { AgentProcessSlot, type AgentProcessPort } from "./agentProcessSlot";

/**
 * 租约（属主令牌）语义：exit/error 回调据此判断「这个 child 是否仍归我」。
 * 只要这两条不成立，退役 runtime 就仍会被迟到事件改写。
 */

/** 租约比较只用对象身份，占位 child 即可（不触发任何进程行为）。 */
function fakeChild(name: string): AgentProcessPort {
	return { name } as unknown as AgentProcessPort;
}

test("install 换代后旧租约失权，只剩新租约有效", () => {
	const slot = new AgentProcessSlot(fakeChild("a"));
	const first = slot.lease;
	assert.equal(slot.owns(first), true);

	const second = slot.install(fakeChild("b"));

	assert.equal(slot.owns(first), false);
	assert.equal(slot.owns(second), true);
	assert.equal(second.generation, first.generation + 1);
	assert.equal(slot.process, second.process);
});

test("retire 后一切租约失权，并交回当前 child 供确认退出", () => {
	const child = fakeChild("a");
	const slot = new AgentProcessSlot(child);
	const lease = slot.lease;

	assert.equal(slot.retire(), child);
	assert.equal(slot.owns(lease), false);
	assert.equal(slot.owns(slot.lease), false);
});

test("retire 幂等：重复调用交回同一 child 且不抛错", () => {
	const child = fakeChild("a");
	const slot = new AgentProcessSlot(child);

	assert.equal(slot.retire(), child);
	assert.equal(slot.retire(), child);
});

test("retire 后 install 重新启用：新租约有效，旧租约仍失权", () => {
	const slot = new AgentProcessSlot(fakeChild("a"));
	const retiredLease = slot.lease;
	slot.retire();

	const rearmed = slot.install(fakeChild("b"));

	// 重装即重新启用；否则新 child 的 exit/error 会被静默丢弃，agent 卡死且无错误痕迹。
	assert.equal(slot.owns(rearmed), true);
	assert.equal(slot.owns(retiredLease), false);
	assert.equal(slot.process, rearmed.process);
	assert.equal(rearmed.generation, retiredLease.generation + 1);
});
