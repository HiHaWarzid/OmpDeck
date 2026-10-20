import assert from "node:assert/strict";
import { test } from "vitest";
import { reconcileAgentState, sameAgentTabList } from "./agentStateReconciliation";
import type { AgentTab } from "../../../shared/types";
import type { PendingAgentTab } from "../agentListDisplay";

/**
 * 测试 onState 推送的纯派生（W5：session-path → active-agent 派生链）：
 * - pending 被真实 agent 替换：剩余列表裁剪、替换映射生成；
 * - active agent 重映射：存活不变 / 被替换指向新 id / 占位未替换时保持 / 已关闭清空；
 * - draftIds（含剩余 pending）与 activeProjectIds 供 per-agent 状态迁移裁剪。
 *
 * 注意 isReplacementForPendingAgent 的匹配前提：同 projectId + 同 cwd 才可能替换
 * （防误选其他路径的同名 Agent），测试夹具需保持 cwd 一致。
 */

function realAgent(
  id: string,
  projectId = "p1",
  sessionPath = `s-${id}`,
  cwd = "/work",
): AgentTab {
  return {
    id,
    projectId,
    sessionPath,
    title: id,
    status: "idle",
    createdAt: 1000,
    cwd,
  } as AgentTab;
}

function pendingAgent(id: string, projectId = "p1", sessionPath?: string): PendingAgentTab {
  return {
    id,
    projectId,
    cwd: "/work",
    title: id,
    status: "starting",
    sessionPath,
    createdAt: 1000,
  } as PendingAgentTab;
}

test("pending 被真实 agent 替换：裁剪剩余列表并生成替换映射", () => {
  const pending = [pendingAgent("pending-1", "p1", "s-1"), pendingAgent("pending-2", "p2", "s-2")];
  const nextAgents = [realAgent("real-1", "p1", "s-1")];
  const result = reconcileAgentState(pending, nextAgents, undefined);
  assert.deepEqual(result.remainingPendingAgents.map((p) => p.id), ["pending-2"]);
  assert.deepEqual(Object.fromEntries(result.pendingReplacementById), {
    "pending-1": "real-1",
  });
});

test("无替换（cwd 不同，非同项目路径）时剩余列表保持原样、替换映射为空", () => {
  const pending = [pendingAgent("pending-1", "p1", "s-1")];
  const result = reconcileAgentState(
    pending,
    [realAgent("real-1", "p1", "s-other", "/other")],
    undefined,
  );
  assert.equal(result.remainingPendingAgents.length, 1);
  assert.equal(result.pendingReplacementById.size, 0);
});

test("active agent 存活时保持不变", () => {
  const result = reconcileAgentState([], [realAgent("a1")], "a1");
  assert.equal(result.nextActiveAgentId, "a1");
});

test("active agent 被替换时指向替换者", () => {
  const pending = [pendingAgent("pending-1", "p1", "s-1")];
  const result = reconcileAgentState(pending, [realAgent("real-1", "p1", "s-1")], "pending-1");
  assert.equal(result.nextActiveAgentId, "real-1");
});

test("active agent 为占位且尚未被替换时保持占位", () => {
  const pending = [pendingAgent("pending-1", "p1", "s-1")];
  const result = reconcileAgentState(
    pending,
    [realAgent("real-other", "p1", "s-other", "/other")],
    "pending-1",
  );
  assert.equal(result.nextActiveAgentId, "pending-1");
});

test("active agent 已关闭（非占位且不在新列表）时清空", () => {
  const result = reconcileAgentState(
    [pendingAgent("pending-1")],
    [realAgent("a1")],
    "closed-agent",
  );
  assert.equal(result.nextActiveAgentId, undefined);
});

test("无 active agent 时保持 undefined", () => {
  const result = reconcileAgentState([pendingAgent("pending-1")], [realAgent("a1")], undefined);
  assert.equal(result.nextActiveAgentId, undefined);
});

test("draftIds 包含全部真实 agent 与剩余 pending", () => {
  const pending = [pendingAgent("pending-1", "p1", "s-1"), pendingAgent("pending-2", "p2")];
  const result = reconcileAgentState(
    pending,
    [realAgent("real-1", "p1", "s-1"), realAgent("a2")],
    undefined,
  );
  assert.deepEqual([...result.draftIds].sort(), ["a2", "pending-2", "real-1"]);
});

test("activeProjectIds 仅含真实 agent 的 project", () => {
  const pending = [pendingAgent("pending-1", "p1", "s-1")];
  const result = reconcileAgentState(
    pending,
    [realAgent("real-1", "p1", "s-1"), realAgent("a2", "p3")],
    undefined,
  );
  assert.deepEqual([...result.activeProjectIds].sort(), ["p1", "p3"]);
});

/**
 * sameAgentTabList 是 setAgents 的内容守卫：工具的每 50ms 全量推送若内容未变必须
 * 判定为「无变化」，否则新数组会击穿 App 的派生链、让侧栏每 50ms 重渲染一次。
 * 反向要求同样重要：任一可见字段变化都必须判定为「有变化」，否则 UI 会吞掉状态更新。
 */
test("sameAgentTabList：内容全等时无变化", () => {
  const previous = [realAgent("a1"), realAgent("a2", "p2")];
  const next = previous.map((agent) => ({ ...agent }));
  assert.equal(sameAgentTabList(previous, next), true);
});

test("sameAgentTabList：状态 / 标题 / 压缩次数变化都判定为有变化", () => {
  const previous = [realAgent("a1")];
  assert.equal(sameAgentTabList(previous, [{ ...previous[0], status: "running" }]), false);
  assert.equal(sameAgentTabList(previous, [{ ...previous[0], title: "改名" }]), false);
  assert.equal(sameAgentTabList(previous, [{ ...previous[0], compactionCount: 1 }]), false);
  assert.equal(sameAgentTabList(previous, [{ ...previous[0], lastError: "boom" }]), false);
});

test("sameAgentTabList：增删条目与可选字段出现/消失都判定为有变化", () => {
  const previous = [realAgent("a1")];
  assert.equal(sameAgentTabList(previous, [...previous, realAgent("a2")]), false);
  assert.equal(sameAgentTabList(previous, []), false);
  // sessionId 之前不存在、现在有值：键集合变化也必须触发更新
  assert.equal(sameAgentTabList(previous, [{ ...previous[0], sessionId: "sess-1" } as AgentTab]), false);
});
