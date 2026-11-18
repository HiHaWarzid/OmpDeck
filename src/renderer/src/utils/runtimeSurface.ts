/**
 * 渲染层宿主的**纯判定**：同一份规则既给 `runtimeApi`（选择并安装 api），
 * 也给 `browserApi`（决定是否注册 SW、是否给 <html> 打 runtime 标记）。
 *
 * 分成纯函数是因为 `browserApi` 在**模块求值期**就要知道宿主，而 `runtimeApi`
 * 要到求值末尾才安装 api。两者各写一份判定，就会出现「SW 按旧规则注册、
 * api 按新规则选择」的错位。
 */
export type RuntimeSurface = "electron" | "lan-web" | "preview" | "missing-preload";

export type RuntimeProbe = {
	/** preload 是否已注入 `window.piDesktop`。 */
	hasPreload: boolean;
	/** `navigator.userAgent`；Electron 会带 `Electron/` 标记。 */
	userAgent: string;
	/** `location.protocol`。`http(s)` 说明 bundle 是经网络下发的。 */
	protocol: string;
};

export function detectRuntimeSurface(probe: RuntimeProbe): RuntimeSurface {
	if (probe.hasPreload) return "electron";
	// Electron 里 preload 缺失是安装损坏，不能当成 Web 宿主继续跑。
	if (probe.userAgent.includes("Electron/")) return "missing-preload";
	return probe.protocol.startsWith("http") ? "lan-web" : "preview";
}
