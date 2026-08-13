import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync("src/renderer/src/styles.css", "utf8");

test("collapsed sidebar reveal does not override the v3 conversation list layout", () => {
  assert.doesNotMatch(
    css,
    /\.conversation-list \{\n  display: block;/,
  );
  assert.match(
    css,
    /\.chat-list-pane\.v3-braun \.sidebar-body \.conversation-list \{[\s\S]*?display: flex;/,
  );
  // 折叠态 hover/focus 展开机制（.list-collapsed:not(.list-hover-suppressed)）已移除：
  // 折叠时整个 sidebar-body 显式隐藏，不再有展开覆盖会话列表布局的规则。
  assert.match(
    css,
    /\.list-collapsed \.chat-list-pane\.v3-braun \.sidebar-body \{\s*display: none !important;/,
  );
});
