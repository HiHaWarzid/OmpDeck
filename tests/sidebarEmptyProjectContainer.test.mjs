import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

test("empty expanded projects do not render a session-card container", () => {
  // 会话列表容器只在有可见/隐藏子项时渲染；加载中/失败时的状态卡是独立分支
  // （sidebar-session-status），空且非加载的项目不会出现 session-card 容器。
  assert.match(
    appSource,
    /!isCollapsed &&\s*\(\s*projectDisplay\.visibleChildren\.length > 0 \|\|\s*projectDisplay\.hiddenChildCount > 0\s*\) &&/,
  );
});
