import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
// 设置 patch 的 "theme" 分支已拆到独立 app 处理器模块（src/main/ipc/appHandlers.ts）。
const appHandlersSource = readFileSync(new URL("../src/main/ipc/appHandlers.ts", import.meta.url), "utf8");

test("main process syncs native titlebar appearance with app theme", () => {
  assert.match(source, /function applyNativeThemeSource\(settings: AppSettings\)/);
  assert.match(source, /nativeTheme\.themeSource\s*=\s*settings\.theme === "system" \? "system" : settings\.theme;/);
  assert.match(source, /applyNativeThemeSource\(settingsStore\.get\(\)\);[\s\S]*new BrowserWindow/);
  assert.match(appHandlersSource, /if \("theme" in patch\) \{[\s\S]*applyNativeThemeSource\(settings\);/);
});
