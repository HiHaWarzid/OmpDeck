import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/index.ts", "utf8");

test("main window has load and timeout fallbacks for showing the hidden window", () => {
	// 当前实现：showMainWindowOnce 接受触发来源字符串；ready-to-show 正常路径、
	// did-finish-load 后 800ms 宽限、以及 3s 绝对兜底三路汇合，保证隐藏窗口必定出现。
	assert.match(source, /function showMainWindowOnce\(source: string\)/);
	assert.match(source, /mainWindow\.once\("ready-to-show", \(\) => \{[\s\S]*?showMainWindowOnce\("ready-to-show"\);/);
	assert.match(source, /mainWindow\.webContents\.once\("did-finish-load", \(\) => \{[\s\S]*?setTimeout\(\(\) => showMainWindowOnce\("did-finish-load\+800ms"\), 800\);/);
	assert.match(source, /setTimeout\(\(\) => showMainWindowOnce\("timeout-3s"\), 3000\)/);
});

test("main window records renderer load diagnostics", () => {
	assert.match(source, /mainWindow\.webContents\.on\("did-start-loading"/);
	assert.match(source, /Main window load started/);
	assert.match(source, /mainWindow\.webContents\.on\("did-finish-load"/);
	assert.match(source, /Main window load finished/);
	assert.match(source, /mainWindow\.webContents\.on\(\s*"did-fail-load"/);
	assert.match(source, /Main window load failed/);
	assert.match(source, /mainWindow\.webContents\.on\("render-process-gone"/);
	assert.match(source, /details\.reason === "clean-exit"/);
	assert.match(source, /Main window renderer process gone/);
	assert.match(source, /mainWindow\.webContents\.on\("dom-ready"/);
	assert.match(source, /Boolean\(window\.piDesktop\)/);
	assert.match(source, /Main window preload API availability/);
	assert.match(source, /mainWindow\.webContents\.on\(\s*"console-message"/);
	assert.match(source, /event\.level/);
	assert.match(source, /Main window renderer console error/);
});

test("linux display workaround opens the main window without hidden pre-map", () => {
	assert.match(source, /const showMainWindowImmediately = shouldShowMainWindowImmediately\(\)/);
	assert.match(source, /show: showMainWindowImmediately/);
	// 启动尺寸统一走 applyStartupWindowMode：隐藏态先 maximize 减少首帧跳动，
	// XWayland 兼容层下 showMainWindowImmediately=true 则跳过预映射直接 show。
	assert.match(source, /applyStartupWindowMode\(\s*mainWindow,\s*startupWindowMode,\s*showMainWindowImmediately,?\s*\)/s);
	assert.match(source, /if \(showMainWindowImmediately\) \{\s*showMainWindowOnce\("immediate"\);\s*\}/s);
});
