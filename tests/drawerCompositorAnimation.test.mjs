import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const styles = readFileSync("src/renderer/src/styles.css", "utf8");

function cssRule(selector) {
  return styles.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1];
}

test("drawer uses only the short grid transition for open and close", () => {
  const shell = cssRule("\\.wechat-shell");
  const drawer = cssRule("\\.detail-drawer");
  const closedDrawer = cssRule(
    '\\.detail-drawer:not\\(\\[data-open="true"\\]\\)',
  );

  assert.ok(shell, "shell styles must exist");
  assert.match(shell, /transition:\s*grid-template-columns 120ms/);
  assert.match(
    styles,
    /body\.is-resizing \.wechat-shell \{\s*transition:\s*none;/,
  );

  assert.ok(drawer, "drawer styles must exist");
  assert.doesNotMatch(drawer, /(?:transform|will-change)\s*:/);
  assert.doesNotMatch(drawer, /transition\s*:\s*transform/);

  assert.ok(closedDrawer, "closed drawer styles must exist");
  assert.match(closedDrawer, /pointer-events:\s*none/);
  assert.doesNotMatch(closedDrawer, /transform\s*:/);
});

test("drawer keeps its content mounted through the layout transition", () => {
  assert.match(app, /const DRAWER_ANIMATION_MS = 120;/);
  assert.match(
    app,
    /const drawerContentPanel = drawer && !drawerCollapsed \? drawer : renderedDrawer;/,
  );
  assert.match(app, /drawer && !drawerCollapsed \? drawerWidth : 0/);
  // 抽屉宽度改为可拖拽的 drawerWidth 状态（默认 320，localStorage 持久化跨重启记忆）。
  // W5：loadPanelWidth 成对 helper 收敛为 usePersistedState（parse 负责读时 clamp 180-560）。
  assert.match(
    app,
    /usePersistedState<number>\(\s*DRAWER_WIDTH_STORAGE_KEY,\s*320,\s*\{[\s\S]*?Math\.min\(560, Math\.max\(180, Math\.round\(raw\)\)\)/,
  );
});

test("file rows use the integer control line-height token", () => {
  const fileRow = cssRule("\\.file-node-row");

  assert.ok(fileRow, "file row styles must exist");
  // 行高与 26px 固定行高对齐为整数，不再用 var(--line-height-control)（该 token 仍存在，
  // 但文件行按固定像素行高渲染）。
  assert.match(fileRow, /height:\s*26px;/);
  assert.match(fileRow, /line-height:\s*26px;/);
  assert.doesNotMatch(fileRow, /line-height:\s*1\.28/);
});
