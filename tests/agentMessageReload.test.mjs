import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const manager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const historyMessages = readFileSync("src/main/pi/historyMessages.ts", "utf8");

test("selecting an agent pulls its messages when the cache is empty (restart gap)", () => {
  // agent 重启/恢复后历史由主进程后台加载，期间渲染层缓存为空：
  // 所有“切换已有 agent”的路径都必须先确保消息已加载，
  // 否则聊天区空白，要发一条消息（触发增量自愈）历史才出现。
  assert.match(
    app,
    /function ensureAgentMessagesLoaded\(agentId: string\) \{[\s\S]*?if \(messagesByAgent\[agentId\]\) return;/,
  );
  assert.match(
    app,
    /void api\.agents\s*\n\s*\.getMessages\(agentId\)[\s\S]*?setMessagesByAgent\(\(current\) => \(\{ \.\.\.current, \[agentId\]: messages \}\)/,
  );
  // 侧栏 agent 行 / 子会话行 / 会话恢复（existingAgent）/ 宠物跳转 四条路径都接入。
  assert.match(
    app,
    /setActiveAgentId\(agent\.id\);\s*ensureAgentMessagesLoaded\(agent\.id\)/,
  );
  assert.match(
    app,
    /setActiveAgentId\(existingAgent\.id\);\s*ensureAgentMessagesLoaded\(existingAgent\.id\)/,
  );
  assert.match(
    app,
    /setActiveAgentId\(subagentAgent\.id\);\s*ensureAgentMessagesLoaded\(subagentAgent\.id\)/,
  );
  assert.match(
    app,
    /setActiveAgentId\(agent\.id\);\s*ensureAgentMessagesLoaded\(agent\.id\);\s*\n\s*\}\);\s*\n\s*return off;/,
  );
});

test("agent run start refreshes runtime state so the model chip stays current", () => {
  // 一轮新回答开始（agent_start / message_start）时立即推送完整运行态，
  // 左下角模型信息条及时显示 omp 实际选用的模型，而不是等到工具边沿。
  assert.match(
    manager,
    /if \(typed\.type === "agent_start"\) \{[\s\S]*?this\.emitState\(\);\s*\/\/ 一轮新回答开始[\s\S]*?void this\.emitRuntimeState\(agentId\);/,
  );
  assert.match(
    manager,
    /if \(typed\.type === "message_start" && typed\.message\?\.role === "assistant"\) \{[\s\S]*?void this\.emitRuntimeState\(agentId\);/,
  );
});

test("runtime state parses both omp and pi field shapes", () => {
  // get_state 的 model 可能是对象或字符串；thinkingLevel/contextUsage 字段命名兼容。
  assert.match(manager, /typeof state\?\.model === "string"/);
  assert.match(manager, /state\?\.thinkingLevel \?\? state\?\.thinking_level/);
  assert.match(manager, /stats\?\.contextUsage \?\? stats\?\.context_usage/);
});

test("sending a prompt proactively refreshes the runtime state", () => {
  // 渲染层发送成功后主动拉最新运行态，不依赖主进程事件时序。
  assert.match(app, /void refreshRuntimeState\(agentId\);/);
});

test("history load placeholder keeps the chat visible during background load", () => {
  // 大会话 get_messages 可能耗时十几秒：加载期间必须推送一条 historyLoading 占位
  // 消息给用户反馈，失败时占位转错误提示，成功基线剔除占位。
  assert.match(
    manager,
    /addMessage\(runtime, "system", "正在加载历史会话…", \{ historyLoading: true \}\)/,
  );
  assert.match(
    manager,
    /message\.meta\?\.historyLoading === true/,
  );
  assert.match(
    manager,
    /loadingMessage\.role = "error";\s*loadingMessage\.text = "历史会话加载失败/,
  );
  // 合并逻辑显式剔除占位，避免加载完成后残留“加载中”卡片。
  assert.match(
    historyMessages,
    /message\.meta\?\.historyLoading !== true/,
  );
});
