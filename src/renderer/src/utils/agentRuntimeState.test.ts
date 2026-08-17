import assert from "node:assert/strict";
import { test } from "vitest";
import { mergeAgentRuntimeState, resolveIncomingRuntimeState } from "./agentRuntimeState";
import type { AgentRuntimeState } from "../../../shared/types";

/**
 * 测试 onRuntimeState 解码逻辑（M3 时代踩坑修复的微妙时序逻辑）：
 * - seq 守卫：完整快照带单调序号，晚到的旧快照直接丢弃；
 * - merge 语义：迟到快照不能倒灌旧的工具执行状态；
 * - tool 边沿：isExecutingTool true→false 且 toolStateSequence 不倒退时，
 *   App 才投递积压的 steer prompt（避免 React 批量渲染漏掉投递窗口）。
 */

test("旧快照（runtimeStateSeq 更小）返回 null 丢弃", () => {
  const previous: AgentRuntimeState = { runtimeStateSeq: 10, isStreaming: true };
  const incoming: AgentRuntimeState = { runtimeStateSeq: 9, isStreaming: false };
  assert.equal(resolveIncomingRuntimeState(previous, incoming), null);
});

test("同/新序号返回合并后 state，且旧 isExecutingTool 被新 false 合并", () => {
  const previous: AgentRuntimeState = {
    runtimeStateSeq: 10,
    isExecutingTool: true,
    executingToolName: "bash",
    toolStateSequence: 3,
    modelName: "old-model",
  };
  const incoming: AgentRuntimeState = {
    runtimeStateSeq: 10,
    isExecutingTool: false,
    toolStateSequence: 4,
    modelName: "new-model",
  };
  const resolved = resolveIncomingRuntimeState(previous, incoming);
  assert.ok(resolved);
  assert.equal(resolved.state.isExecutingTool, false);
  assert.equal(resolved.state.modelName, "new-model");
  assert.equal(resolved.state.runtimeStateSeq, 10);
});

test("tool 边沿：previous true → incoming false 且序号递增时 isToolCompletionEdge=true", () => {
  const previous: AgentRuntimeState = {
    isExecutingTool: true,
    executingToolName: "read",
    toolStateSequence: 5,
    runtimeStateSeq: 1,
  };
  const incoming: AgentRuntimeState = {
    isExecutingTool: false,
    toolStateSequence: 6,
    runtimeStateSeq: 2,
  };
  const resolved = resolveIncomingRuntimeState(previous, incoming);
  assert.ok(resolved);
  assert.equal(resolved.isToolCompletionEdge, true);
  assert.equal(resolved.state.isExecutingTool, false);
});

test("tool 边沿序列倒退：incoming.toolStateSequence 更小时 isToolCompletionEdge=false", () => {
  const previous: AgentRuntimeState = {
    isExecutingTool: true,
    executingToolName: "bash",
    toolStateSequence: 5,
    runtimeStateSeq: 1,
  };
  // 序号 6 > 5 通过 seq 守卫，但 toolStateSequence 倒退 → 不判定为完成边沿
  const incoming: AgentRuntimeState = {
    isExecutingTool: false,
    toolStateSequence: 3,
    runtimeStateSeq: 6,
  };
  const resolved = resolveIncomingRuntimeState(previous, incoming);
  assert.ok(resolved);
  assert.equal(resolved.isToolCompletionEdge, false);
  // merge 语义：迟到工具快照不倒灌，isExecutingTool 保留 previous 的 true
  assert.equal(resolved.state.isExecutingTool, true);
  assert.equal(resolved.state.toolStateSequence, 5);
});

test("无 seq 字段的轻量 patch：不丢弃，toolStateSequence 均未定义时仍判为完成边沿", () => {
  const previous: AgentRuntimeState = { isExecutingTool: true, executingToolName: "write" };
  const incoming: AgentRuntimeState = { isExecutingTool: false };
  const resolved = resolveIncomingRuntimeState(previous, incoming);
  assert.ok(resolved);
  assert.equal(resolved.state.isExecutingTool, false);
  assert.equal(resolved.isToolCompletionEdge, true);
});

test("状态合并：incoming 不带 tool 字段时保留 current 的 model/token 等非 tool 字段", () => {
  const previous: AgentRuntimeState = {
    modelName: "gpt-4o",
    inputTokens: 100,
    outputTokens: 50,
    isExecutingTool: true,
    toolStateSequence: 7,
    runtimeStateSeq: 20,
  };
  const incoming: AgentRuntimeState = { runtimeStateSeq: 21, inputTokens: 150 };
  const resolved = resolveIncomingRuntimeState(previous, incoming);
  assert.ok(resolved);
  assert.equal(resolved.state.modelName, "gpt-4o");
  assert.equal(resolved.state.inputTokens, 150);
  assert.equal(resolved.state.outputTokens, 50);
  // 轻量 patch 未提及工具状态 → 保留当前执行中标志
  assert.equal(resolved.state.isExecutingTool, true);
  assert.equal(resolved.state.toolStateSequence, 7);
  assert.equal(resolved.isToolCompletionEdge, false);
});

test("mergeAgentRuntimeState 语义：工具序号倒退时丢弃 incoming 工具标志", () => {
  const current: AgentRuntimeState = {
    isExecutingTool: true,
    executingToolName: "bash",
    toolStateSequence: 9,
    modelName: "keep-me",
  };
  const incoming: AgentRuntimeState = {
    isExecutingTool: false,
    toolStateSequence: 2,
    modelName: "stale-model",
  };
  const merged = mergeAgentRuntimeState(current, incoming);
  assert.equal(merged.isExecutingTool, true);
  assert.equal(merged.executingToolName, "bash");
  assert.equal(merged.modelName, "stale-model");
});
