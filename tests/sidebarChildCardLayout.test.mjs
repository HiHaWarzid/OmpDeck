import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync("src/renderer/src/styles.css", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

test("sidebar child cards share the workspace card's horizontal bounds", () => {
  const workspaceCard = styles.match(
    /\.chat-list-pane\.v3-braun \.sidebar-body \.session-card \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(workspaceCard, "sidebar workspace card styles must exist");
  assert.match(workspaceCard, /padding:\s*2px 0;/);
});

test("sidebar workspace wrapper does not frame child cards", () => {
  const workspaceCard = styles.match(
    /\.chat-list-pane\.v3-braun \.sidebar-body \.session-card \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(workspaceCard, "sidebar workspace card styles must exist");
  assert.match(workspaceCard, /background:\s*transparent;/);
  assert.match(workspaceCard, /border:\s*0;/);
  assert.match(workspaceCard, /border-radius:\s*0;/);
  assert.match(workspaceCard, /overflow:\s*visible;/);
});

test("sidebar workspace wrapper stays transparent on hover", () => {
  const workspaceCardHover = styles.match(
    /\.chat-list-pane\.v3-braun \.sidebar-body \.session-card:hover \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(workspaceCardHover, "sidebar workspace hover styles must exist");
  assert.match(workspaceCardHover, /background:\s*transparent;/);
});

test("sidebar child cards use fixed workspace row dimensions", () => {
  const childRows = styles.match(
    /\.chat-list-pane\.v3-braun \.sidebar-body \.agent-row,\n\.chat-list-pane\.v3-braun \.sidebar-body \.session-row \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(childRows, "sidebar child card styles must exist");
  assert.match(childRows, /width:\s*100%;/);
  // 固定 32px 控制高度改为 min-height，标题较长时行可自然增高
  assert.match(childRows, /height:\s*auto;/);
  assert.match(childRows, /min-height:\s*var\(--control-height-md\);/);
  // 左侧 padding 略收（标题更靠左，右侧留给状态圆点）
  assert.match(
    childRows,
    /padding:\s*var\(--space-1\) var\(--space-2\) var\(--space-1\) var\(--space-1\);/,
  );
});

test("sidebar child titles use an ellipsis when clipped", () => {
  const childTitles = styles.match(
    /\.chat-list-pane\.v3-braun \.sidebar-body \.agent-row \.conversation-title strong,([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(childTitles, "sidebar child title styles must exist");
  assert.match(childTitles, /text-overflow:\s*ellipsis;/);
});

test("sidebar agent statuses use compact color-coded card badges", () => {
  // 状态样式改为 16x16 圆点容器 + 8px 内圆点：状态色写在 dot 的 background，
  // 不再渲染带文字/边框的小徽章。
  const indicator = styles.match(/(?:^|\n)\.agent-status-indicator \{([\s\S]*?)\n\}/)?.[1];

  assert.ok(indicator, "sidebar status indicator styles must exist");
  assert.match(indicator, /width:\s*16px;/);
  assert.match(indicator, /height:\s*16px;/);
  assert.match(indicator, /padding:\s*0;/);

  const dot = styles.match(/(?:^|\n)\.agent-status-dot \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(dot, "sidebar status dot styles must exist");
  assert.match(dot, /width:\s*8px;/);
  assert.match(dot, /height:\s*8px;/);
  assert.match(dot, /border-radius:\s*50%;/);

  for (const [status, distinct] of [
    ["idle", /background:\s*color-mix\(in srgb, var\(--color-brand-blue\) 65%, transparent\);/],
    ["running", /background:\s*#eab308;/],
    ["starting", /border:\s*1\.5px solid var\(--color-text-tertiary\);/],
    ["error", /background:\s*var\(--color-danger\);/],
  ]) {
    const state = styles.match(
      new RegExp(`\\.agent-status-indicator\\.status-${status} \\.agent-status-dot \\{([\\s\\S]*?)\\n\\}`),
    )?.[1];

    assert.ok(state, `${status} status styles must exist`);
    assert.match(state, distinct);
  }
});

test("sidebar status labels do not render circle glyphs", () => {
  assert.doesNotMatch(appSource, /agent\.status === 'running' && '●'/);
  assert.doesNotMatch(appSource, /agent\.status === 'idle' && '○'/);
  assert.doesNotMatch(appSource, /agent\.status === 'starting' && '◐'/);
});
