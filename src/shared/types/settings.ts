import type { ExternalEditorSettings } from "./editor";
import type { AfkSettings } from "./afk";

export type SendShortcutMode =
	| "enter-send"
	| "ctrl-enter-send"
	| "shift-enter-send";

export type AppThemeMode = "system" | "light" | "dark";
export type LightBackgroundMode = "white" | "warm" | "paper" | "blue" | "green";
export type AppLanguageMode = "system" | "zh-CN" | "en-US" | "pseudo";
export type LinkOpenMode = "external" | "internal";
export type AppFontSizeMode = "compact" | "default" | "medium" | "large" | "xlarge";
export type AppFontBaseMode = "system" | "sans" | "serif" | "custom";
export type AppFontMonoMode = "commit-mono" | "system-mono" | "custom";
/** 主窗口启动尺寸预设：fullscreen 占满屏幕，maximized 最大化，last 恢复上次窗口大小，其余为固定窗口 */
export type StartupWindowMode =
	| "fullscreen"
	| "maximized"
	| "last"
	| "normal-large"
	| "normal-medium"
	| "normal-compact";

export type AppSettings = {
	useNativeTitleBar: boolean;
	showNativeMenu: boolean;
	sendShortcut: SendShortcutMode;
	/** 界面主题，system 跟随系统浅色/暗色偏好 */
	theme: AppThemeMode;
	/** 浅色主题的工作台背景预设；暗色主题下忽略，便于用户快速试不同淡色底。 */
	lightBackground: LightBackgroundMode;
	/** 界面语言，system 跟随系统语言；pseudo 用于长文案布局压力测试 */
	language: AppLanguageMode;
	/** 启动时主窗口尺寸预设，默认 maximized（与历史 ready-to-show 后 maximize 一致） */
	startupWindowMode: StartupWindowMode;
	piEnvironmentChecked: boolean;
	/** 是否启用会话右侧的 Git 源代码管理入口与面板，默认开启以保持升级前行为。 */
	enableGitManagement: boolean;
	/** Git 提交摘要生成提示词模板，{diff} 会被替换为实际 diff 内容 */
	gitCommitMessagePrompt: string;
	/** 关闭窗口时隐藏到系统托盘而不是退出 */
	closeToTray: boolean;
	/**
	 * 单实例模式：再次打开应用时复用已有窗口（托盘隐藏也会唤起）。
	 * 默认 true；关闭后允许同时跑多个 OmpDeck 进程。
	 */
	singleInstance: boolean;
	/** 会话结束时发送系统通知 */
	enableNotifications: boolean;
	/** 是否在会话中显示模型思考过程，默认开启 */
	showThinking: boolean;
	/** 是否开启开发者控制台（DevTools） */
	showDevTools: boolean;
	/**
	 * Electron Chromium 渲染进程沙箱（与 pi Agent 无关）。
	 * false（默认）：关闭沙箱，兼容 Windows 安全软件/旧 GPU 驱动；
	 * true：启用 Chromium 沙箱，需重启 OmpDeck 后生效。
	 */
	electronChromiumSandbox: boolean;
	/** 是否给 pi agent 子进程注入代理环境变量，不影响 desktop 自身网络请求 */
	piProxyEnabled: boolean;
	/** pi agent 使用的代理地址，例如 http://127.0.0.1:7890 */
	piProxyUrl: string;
	/** pi agent 代理绕过列表，对应 NO_PROXY 环境变量 */
	piProxyBypass: string;
	/** 是否给桌面端自身网络请求启用代理，不影响已启动的 pi agent 子进程 */
	desktopProxyEnabled: boolean;
	/** 桌面端自身网络请求使用的代理地址，例如 http://127.0.0.1:7890 */
	desktopProxyUrl: string;
	/** 桌面端代理绕过列表，对应 Electron proxyBypassRules */
	desktopProxyBypass: string;
	/** 用户手动指定的 pi CLI 命令路径，自动检测不到时用于兜底 */
	customPiPath: string;

	/** 是否发送匿名、低频、最小字段的使用统计 */
	telemetryEnabled: boolean;
	/** 是否开启局域网 Web 服务 */
	webServiceEnabled: boolean;
	/** Web 服务监听地址，默认 0.0.0.0 允许局域网访问 */
	webServiceHost: string;
	/** Web 服务监听端口 */
	webServicePort: number;
	/** 本地生成的匿名安装标识，不包含账号、路径或机器名 */
	telemetryInstallId?: string;
	/** 最近一次发送 app_heartbeat 的本地日期，格式 YYYY-MM-DD */
	telemetryLastHeartbeatDate?: string;
	/** 应用安装类型：portable（便携版）或 installed（安装版），启动时自动检测并持久化 */
	installationType?: "portable" | "installed";
	/** RPC 调用超时时间（毫秒），默认 600000（10 分钟），用于长时间运行的命令 */
	rpcTimeout: number;
	/** 视觉桥：给非视觉模型"眼睛"——发送图片消息时经 OpenAI 兼容端点转成文本描述注入上下文 */
	visionBridge: {
		enabled: boolean;
		/** OpenAI 兼容 chat completions 端点，如 https://api.deepseek.com/v1 */
		baseUrl: string;
		apiKey: string;
		model: string;
		/** 转换提示词模板；{image} 会被替换为图片内容占位说明 */
		prompt: string;
		/** 单张图片转换超时（毫秒），默认 120000 */
		timeoutMs: number;
	};
	/** 外部链接打开方式：external 使用系统默认浏览器，internal 使用应用内独立窗口 */
	linkOpenMode: LinkOpenMode;
	/** 内容区最大宽度（px），0 表示不限制（填满 chat-pane）。用于限制消息行宽，左右留白。 */
	contentMaxWidth: number;
	/** 编辑器最大文件大小（MB），超过此大小的文件不加载编辑器。默认 5MB。 */
	maxEditorFileSizeMB: number;
	/** 外部编辑器配置：首次异步检测后保存，用户可在设置中手动覆盖路径。 */
	externalEditors: ExternalEditorSettings;
	/** 是否启用 WSL fallback：在 Windows 自动检测不到 pi 时，尝试从 WSL 启动 pi */
	wslEnabled: boolean;
	/** WSL 发行版名称，如 Debian、Ubuntu */
	wslDistro: string;
	/** WSL 用户名，如 piuser */
	wslUser: string;

	// ── 桌面宠物（全局聚合单宠，默认关闭，不破坏现状） ──
	/** 是否启用桌面宠物悬浮窗，默认 false：关闭后应用与现状完全一致 */
	petEnabled: boolean;
	/** 当前选中的宠物包 id，默认内置水獭 */
	petId: string;
	/** 宠物窗是否始终置顶，默认 true */
	petAlwaysOnTop: boolean;
	/** 宠物缩放比例 0.3-2.0，默认 1.0，控制窗口与 sprite 渲染尺寸 */
	petScale: number;
	/** 是否启用 idle 巡游（无任务时沿屏幕底部左右走动），默认 true；
	 *  巡游为低优先级 UI 行为，running/failed/review/逗弄 时自动让位。 */
	petPatrolEnabled: boolean;
	/** 巡游碰边后 idle 停顿时长（分钟），默认 5，范围 1–30 */
	petPatrolPauseMin: number;

	// ── 模型收藏：ModelPicker 中用 ☆ 标记，收藏的模型在列表中置顶 ──
	/** 收藏的模型 ID 列表 */
	favoriteModels: string[];

	// ── 字体配置：沿用主题机制实时生效，写入 documentElement token ──
	/** 全局字号基准档位；未单独设置各区域时，所有字号 token 均由此推导 */
	fontSize: AppFontSizeMode;
	/** UI 字号覆盖；null 表示跟随 fontSize。控制 sidebar、按钮、列表、弹窗等 */
	uiFontSize: AppFontSizeMode | null;
	/** 会话正文字号覆盖；null 表示跟随 fontSize。控制用户消息与助手回复 */
	chatFontSize: AppFontSizeMode | null;
	/** 输入框字号覆盖；null 表示跟随 fontSize。控制 composer 输入区 */
	inputFontSize: AppFontSizeMode | null;
	/** 全局窗口缩放比例，1 为 100%；通过 webContents.setZoomFactor 生效 */
	zoomFactor: number;
	/** UI 基础字体预设，system 为跨平台系统栈；custom 时使用 fontFamilyBaseCustom */
	fontFamilyBase: AppFontBaseMode;
	/** fontFamilyBase=custom 时的自定义字体族栈，原样写入 CSS font-family */
	fontFamilyBaseCustom: string;
	/** 等宽字体预设，commit-mono 为内置 PiDeckCommitMono；custom 时使用 fontFamilyMonoCustom */
	fontFamilyMono: AppFontMonoMode;
	/** fontFamilyMono=custom 时的自定义字体族栈，原样写入 CSS font-family */
	fontFamilyMonoCustom: string;

	// ── 更新检测 ──
	/** 是否禁用版本更新检测（OmpDeck + Pi CLI），默认 false 表示正常检测；
	 *  开启后自动跳过启动和定时检测，设置页中检测按钮也禁用。 */
	disableUpdateCheck: boolean;

	// ── Agent 启动诊断/加速（开发设置） ──
	/**
	 * 启动 pi RPC 时附加 --offline，跳过 pi 启动期模型目录网络刷新。
	 * 桌面端模型列表来自本地 models.json，默认开启以加快冷启动。
	 */
	piRpcOffline: boolean;
	/**
	 * 启动 pi RPC 时附加 --no-extensions，跳过扩展发现与加载。
	 * 用于排查「坏扩展导致 RPC 起不来」；开启后 todo/plan/ask 等扩展不可用。
	 */
	piRpcNoExtensions: boolean;
	/**
	 * 启动 pi RPC 时附加 --no-skills，跳过 skills 发现与加载。
	 * 用于排查/加速；开启后技能命令与 skill 相关能力不可用。
	 */
	piRpcNoSkills: boolean;

	// ── 侧栏 UI 状态 ──
	/**
	 * 左侧边栏处于展开状态的项目 id 列表（含 builtin-chat）。
	 * 写入 settings.json，避免 dev 模式强杀进程时 localStorage 来不及落盘而丢失。
	 * 缺省时由渲染层按「仅展开 chat」处理。
	 */
	sidebarExpandedProjectIds?: string[];

	// ── 扩展管理 ──
	/**
	 * 用户手动移除（或因三方冲突自动让位）的内置扩展列表（如 pi-deck-todo.ts）。
	 * 下次启动跳过自动部署，并清理用户目录残留文件，避免 pi 仍加载导致工具冲突。
	 */
	removedBuiltInExtensions: string[];

	// ── AFK 挂机编排 ──
	/** AFK 配置（设置页 afk tab 编辑；enabled 持久化，启动自动恢复轮询） */
	afk: AfkSettings;

};
