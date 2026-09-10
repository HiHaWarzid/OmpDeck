import assert from "node:assert/strict";
import test from "node:test";

import {
  QUEUED_PROMPT_LIMIT,
  QUEUED_PROMPT_VISIBLE,
  enqueuePrompt,
  getQueuedPromptView,
} from "../src/renderer/src/utils/queuedPromptQueue.ts";

/**
 * 队列视图契约（纯行为，不读 App 源码）：
 * 视图最多展示 QUEUED_PROMPT_VISIBLE 行，余量报 hiddenCount；
 * 入队按 QUEUED_PROMPT_LIMIT 封顶，超量丢弃。
 */

function prompt(id) {
  return { id, message: id, displayText: id, behavior: "followUp", agentMode: "normal", timestamp: 1 };
}

test("view shows at most VISIBLE rows and reports the rest as hidden", () => {
  const queue = ["a", "b", "c", "d", "e"].map(prompt);
  const view = getQueuedPromptView(queue, QUEUED_PROMPT_VISIBLE);
  assert.deepEqual(view.visible.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(view.hiddenCount, 2);
  assert.deepEqual(getQueuedPromptView([], QUEUED_PROMPT_VISIBLE), { visible: [], hiddenCount: 0 });
});

test("enqueue caps per-agent queue at LIMIT", () => {
  let queues = {};
  for (let i = 0; i < QUEUED_PROMPT_LIMIT; i += 1) {
    queues = enqueuePrompt(queues, "a", prompt(`p${i}`));
  }
  assert.equal(queues.a.length, QUEUED_PROMPT_LIMIT);
  const blocked = enqueuePrompt(queues, "a", prompt("overflow"));
  assert.equal(blocked.a.length, QUEUED_PROMPT_LIMIT);
  assert.equal(blocked.a.some((item) => item.id === "overflow"), false);
});
