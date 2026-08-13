import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync("src/renderer/src/styles.css", "utf8");

const basePaneRule = css.match(
  /(?:^|\n)\.chat-list-pane \{([\s\S]*?)\n\}/,
)?.[1];
const v3ExpandedRule = css.match(
  /\.wechat-shell:not\(\.list-collapsed\) \.chat-list-pane\.v3-braun \{([\s\S]*?)\n\}/,
)?.[1];
const collapsedPaneRule = css.match(
  /\.list-collapsed \.chat-list-pane \{([\s\S]*?)\n\}/,
)?.[1];

test("v3 sidebar has no right divider in expanded or collapsed states", () => {
  // hover/focus 展开态已移除（.list-collapsed:not(.list-hover-suppressed) 选择器不再存在），
  // 侧栏只有展开与折叠两种状态，均不得有右侧分隔线。
  assert.ok(basePaneRule, "base chat-list-pane rule must exist");
  assert.match(basePaneRule, /border-right:\s*0;/);
  assert.ok(v3ExpandedRule, "v3 expanded sidebar rule must exist");
  assert.doesNotMatch(v3ExpandedRule, /border-right:/);
  assert.ok(collapsedPaneRule, "collapsed sidebar pane rule must exist");
  // 折叠态边缘条显式清零右分隔线
  assert.match(collapsedPaneRule, /border-right:\s*0;/);
});
