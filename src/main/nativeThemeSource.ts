/**
 * 原生标题栏主题解析——纯函数，无 Electron 依赖，可独立测试。
 *
 * Electron 的 `nativeTheme.themeSource` 接受 "system" | "dark" | "light"。
 * 用户设置中的 "system" 应映射为 "system"，其他值（"dark" / "light"）直接透传。
 */

import type { AppSettings } from "../shared/types";

export function resolveNativeThemeSource(theme: AppSettings["theme"]): "system" | "light" | "dark" {
	return (theme === "system" ? "system" : theme) as "system" | "light" | "dark";
}
