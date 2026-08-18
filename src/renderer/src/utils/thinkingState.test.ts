import assert from "node:assert/strict";
import { test } from "vitest";
import { reduceThinkingUpdate, type ThinkingState } from "./thinkingState";

/**
 * 测试 onThinking 归约（W5：流式思考派生收敛）：
 * - 相同文本返回原引用，调用方可跳过 setState 避免 20Hz 整树重渲染；
 * - 首次非空记录 startedAt，后续非空保持首次时间；
 * - 清空时保留 thinking 空值并移除 startedAt。
 */

const empty: ThinkingState = { thinkingByAgent: {}, startedAtByAgent: {} };

test("相同文本返回原引用（相等守卫，跳过重渲染）", () => {
	const current: ThinkingState = { thinkingByAgent: { a1: "same" }, startedAtByAgent: { a1: 10 } };
	const next = reduceThinkingUpdate(current, "a1", "same", 20);
	assert.equal(next, current);
});

test("新文本更新 thinking（引用变化触发重渲染），startedAt 首次记录", () => {
	const next = reduceThinkingUpdate(empty, "a1", "hello", 500);
	assert.notEqual(next, empty);
	assert.equal(next.thinkingByAgent["a1"], "hello");
	assert.equal(next.startedAtByAgent["a1"], 500);
});

test("已有 startedAt 时后续非空文本保持首次时间", () => {
	const first = reduceThinkingUpdate(empty, "a1", "hello", 500);
	const second = reduceThinkingUpdate(first, "a1", "hello world", 900);
	assert.equal(second.startedAtByAgent["a1"], 500);
	assert.equal(second.thinkingByAgent["a1"], "hello world");
});

test("同文本且 startedAt 已有时完全无变化", () => {
	const current = reduceThinkingUpdate(empty, "a1", "hello", 500);
	const next = reduceThinkingUpdate(current, "a1", "hello", 600);
	assert.equal(next, current);
});

test("清空文本：thinking 置空并移除 startedAt", () => {
	const current = reduceThinkingUpdate(empty, "a1", "hello", 500);
	const next = reduceThinkingUpdate(current, "a1", "", 700);
	assert.equal(next.thinkingByAgent["a1"], "");
	assert.equal(next.startedAtByAgent["a1"], undefined);
});

test("缺失的 agent 收到空文本：仅记录空 thinking，无 startedAt", () => {
	const next = reduceThinkingUpdate(empty, "a1", "", 100);
	assert.equal(next.thinkingByAgent["a1"], "");
	assert.equal(next.startedAtByAgent["a1"], undefined);
});

test("多 agent 状态互不影响", () => {
	const a = reduceThinkingUpdate(empty, "a1", "alpha", 100);
	const b = reduceThinkingUpdate(a, "b1", "beta", 200);
	assert.equal(b.thinkingByAgent["a1"], "alpha");
	assert.equal(b.startedAtByAgent["a1"], 100);
	assert.equal(b.thinkingByAgent["b1"], "beta");
	assert.equal(b.startedAtByAgent["b1"], 200);
});