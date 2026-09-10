import assert from "node:assert/strict";
import test from "node:test";

import { resolveFullPullResult } from "../src/renderer/src/utils/messageDeltaResolver.ts";

/**
 * 全量拉取的 seq 守卫（纯语义，不读 App 源码）：
 * 拉取期间有新 delta 到达（currentSeq 前进）→ 旧基线丢弃，避免覆盖新消息；
 * 序号相等才接受并整体替换。
 * App.ensureAgentMessagesLoaded 实现此语义（src/renderer/src/App.tsx）。
 */

test("stale full pull is dropped when a delta arrived during fetch", () => {
  assert.equal(resolveFullPullResult(1, 2, []), null);
});

test("fresh full pull replaces the baseline", () => {
  const messages = [{ id: "a" }, { id: "b" }];
  const res = resolveFullPullResult(3, 3, messages);
  assert.deepEqual(res.messages, messages);
});
