import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const turnRowSource = readFileSync(
  "src/renderer/src/components/app/AppParts.tsx",
  "utf8",
);
// 时间线渲染循环已从 App.tsx 拆到 MessageListContent（App.tsx 只传 agentRunning={isAgentBusy}）
const messageListSource = readFileSync(
  "src/renderer/src/components/app/MessageListContent.tsx",
  "utf8",
);

test("renders the execution process before the final assistant answer", () => {
  assert.ok(
    turnRowSource.indexOf("{/* 执行过程概要") < turnRowSource.indexOf("{/* 最终回答"),
    "the execution summary must precede the final answer in TurnRow",
  );
});

test("only the latest agent run receives the global running state", () => {
  const timelineRender = messageListSource.slice(
    messageListSource.indexOf("{renderedRuns.map"),
    messageListSource.indexOf("// 独立消息条目"),
  );
  // MessageListContent 把 App 传入的 agentRunning 只下发给最后一个 run 行
  assert.match(
    timelineRender,
    /agentRunning=\{agentRunning && index === renderedRuns\.length - 1\}/,
  );
  assert.doesNotMatch(timelineRender, /agentRunning=\{agentRunning\}/);
});
