import assert from "node:assert/strict";
import test from "node:test";

import { resolveNativeThemeSource } from "../src/main/nativeThemeSource.ts";

/**
 * 意图真实：`nativeTheme.themeSource` 只接受 "system" | "light" | "dark"，
 * 用户设置的 "system" 必须透传，其它值直接转发——错误的映射会让标题栏在
 * 暗色模式下仍然是浅色。纯函数，无 Electron 依赖，无需启动主进程。
 */

test("resolveNativeThemeSource maps settings theme to nativeTheme.themeSource values", () => {
	assert.strictEqual(resolveNativeThemeSource("system"), "system");
	assert.strictEqual(resolveNativeThemeSource("dark"), "dark");
	assert.strictEqual(resolveNativeThemeSource("light"), "light");
});
