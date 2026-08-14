import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { PiDesktopApi } from "./api";

/**
 * IPC 通道表 —— 整个 IPC 接缝的唯一事实源。
 *
 * 结构：按 window.piDesktop 的命名空间嵌套（一个 api 成员一条目），每个条目声明：
 *   - channel：通道名（preload 与主进程之间唯一握手标识）
 *   - kind：invoke（请求/响应）｜subscribe（主进程推送）｜send（单向通知，ipcMain.on）｜
 *           sendSync（同步读取，ipcMain.on + returnValue）｜local（无 IPC 的实现，由 preload 覆盖层提供）
 *   - pack：preload 侧参数打包（把成员函数参数折叠成 invoke 实参列表；默认原样展开）
 *
 * 消费方：
 *   - preload 的 buildApi() 遍历本表生成 window.piDesktop 的包装函数；
 *   - 主进程 handler 模块按命名空间返回 IpcHandlerMap，注册循环从本表取通道名；
 *   - ipcChannels（文件尾）由本表派生，保持历史 `ipcChannels.xxx` 调用点零感知。
 *
 * 规则：新增/修改一个通道只改这一处；不要在本表之外写裸通道字符串
 * （tests/ipc-raw-channel-ban.test.mjs 会检查）。
 */
export type IpcOpKind = "invoke" | "subscribe" | "send" | "sendSync" | "local";

export interface IpcOpEntry {
	readonly channel?: string;
	readonly kind: IpcOpKind;
	/**
	 * preload 侧参数打包：把成员函数参数打包成 invoke 的实参列表（默认原样展开）。
	 * 仅 preload 消费；带 pack 的成员主进程 handler 签名退化为宽松类型（见 IpcHandlerMap）。
	 */
	readonly pack?: (...args: unknown[]) => readonly unknown[];
}

export type IpcTable = {
	readonly [Ns in keyof PiDesktopApi]: {
		readonly [M in keyof PiDesktopApi[Ns]]: IpcOpEntry;
	};
};

/** 按 api 成员嵌套的通道表。local 条目无 channel 或 channel 仅为通道注册（实现走 preload 覆盖层）。 */
export const ipcTable = {
	editors: {
		list: { channel: "editors:list", kind: "invoke" },
		redetect: { channel: "editors:redetect", kind: "invoke" },
		update: { channel: "editors:update", kind: "invoke" },
		chooseExecutable: { channel: "editors:choose-executable", kind: "invoke" },
		openProject: { channel: "editors:open-project", kind: "invoke" },
	},
	projects: {
		list: { channel: "projects:list", kind: "invoke" },
		add: { channel: "projects:add", kind: "invoke" },
		remove: { channel: "projects:remove", kind: "invoke" },
		reorder: { channel: "projects:reorder", kind: "invoke" },
		onChanged: { channel: "projects:changed", kind: "subscribe" },
		listRoot: { channel: "projects:list-root", kind: "invoke" },
		listWorktreeChildren: { channel: "projects:list-worktree-children", kind: "invoke" },
		toggleWorktreeEnabled: { channel: "projects:toggle-worktree-enabled", kind: "invoke" },
		// 选择聊天记录目录（系统文件选择器，默认当前聊天目录）
		chooseChatPath: { channel: "projects:choose-chat-path", kind: "invoke" },
		// 设置聊天记录目录并持久化
		setChatPath: { channel: "projects:set-chat-path", kind: "invoke" },
		listModels: { channel: "projects:list-models", kind: "invoke" },
	},
	projectResources: {
		list: { channel: "project-resources:list", kind: "invoke" },
		createSkill: { channel: "project-resources:create-skill", kind: "invoke" },
		deleteSkill: { channel: "project-resources:delete-skill", kind: "invoke" },
		toggleSkill: { channel: "project-resources:toggle-skill", kind: "invoke" },
		deleteExtension: { channel: "project-resources:delete-extension", kind: "invoke" },
		toggleExtension: { channel: "project-resources:toggle-extension", kind: "invoke" },
		renameSkill: { channel: "project-resources:rename-skill", kind: "invoke" },
	},
	files: {
		list: { channel: "files:list", kind: "invoke" },
		open: { channel: "files:open", kind: "invoke" },
		showInFolder: { channel: "files:show-in-folder", kind: "invoke" },
		readContent: { channel: "files:read-content", kind: "invoke" },
		readBase64: { channel: "files:read-base64", kind: "invoke" },
		writeContent: { channel: "files:write-content", kind: "invoke" },
		delete: { channel: "files:delete", kind: "invoke" },
		rename: { channel: "files:rename", kind: "invoke" },
		create: { channel: "files:create", kind: "invoke" },
		/** 复制来源路径到目标目录（支持文件和目录递归） */
		copy: { channel: "files:copy", kind: "invoke" },
		/** 移动来源路径到目标目录（同设备 rename，跨设备 cp+rm） */
		move: { channel: "files:move", kind: "invoke" },
		// Electron 32+ 已移除 File.path；webUtils 解析只在 preload 进程可用，实现走覆盖层
		getPathForFile: { kind: "local" },
		// 同步读取剪贴板文件路径（sendSync），try/catch 回落逻辑在覆盖层
		getClipboardPaths: { channel: "clipboard:read-file-paths", kind: "local" },
	},
	sessions: {
		list: { channel: "sessions:list", kind: "invoke" },
		rename: { channel: "sessions:rename", kind: "invoke" },
		copy: { channel: "sessions:copy", kind: "invoke" },
		exportHtml: { channel: "sessions:export-html", kind: "invoke" },
		delete: { channel: "sessions:delete", kind: "invoke" },
		readMessages: { channel: "sessions:read-messages", kind: "invoke" },
		readUserPrompts: { channel: "sessions:read-user-prompts", kind: "invoke" },
		readSessionMeta: { channel: "sessions:read-meta", kind: "invoke" },
		readChatMessages: { channel: "sessions:read-chat-messages", kind: "invoke" },
		readMessageFullText: { channel: "sessions:read-message-full-text", kind: "invoke" },
	},
	codexSessions: {
		scan: { channel: "codex-sessions:scan", kind: "invoke" },
		import: { channel: "codex-sessions:import", kind: "invoke" },
	},
	claudeSessions: {
		scan: { channel: "claude-sessions:scan", kind: "invoke" },
		import: { channel: "claude-sessions:import", kind: "invoke" },
	},
	openCodeSessions: {
		scan: { channel: "opencode-sessions:scan", kind: "invoke" },
		import: { channel: "opencode-sessions:import", kind: "invoke" },
	},
	git: {
		branches: { channel: "git:branches", kind: "invoke" },
		checkout: { channel: "git:checkout", kind: "invoke" },
		createBranch: { channel: "git:create-branch", kind: "invoke" },
		originalContent: { channel: "git:original-content", kind: "invoke" },
		worktreeList: { channel: "git:worktree-list", kind: "invoke" },
		worktreeCreate: { channel: "git:worktree-create", kind: "invoke" },
		worktreeRemove: { channel: "git:worktree-remove", kind: "invoke" },
		commitLog: { channel: "git:commit-log", kind: "invoke" },
		refs: { channel: "git:refs", kind: "invoke" },
		branchCompare: { channel: "git:branch-compare", kind: "invoke" },
		commitDetail: { channel: "git:commit-detail", kind: "invoke" },
		commitFileDiff: { channel: "git:commit-file-diff", kind: "invoke" },
		diffFileBetween: { channel: "git:diff-file-between", kind: "invoke" },
		status: { channel: "git:status", kind: "invoke" },
		workspaceFileDiff: { channel: "git:workspace-file-diff", kind: "invoke" },
		stage: { channel: "git:stage", kind: "invoke" },
		unstage: { channel: "git:unstage", kind: "invoke" },
		discard: { channel: "git:discard", kind: "invoke" },
		commit: { channel: "git:commit", kind: "invoke" },
		cherryPick: { channel: "git:cherry-pick", kind: "invoke" },
		revert: { channel: "git:revert", kind: "invoke" },
		reset: { channel: "git:reset", kind: "invoke" },
		dropCommit: { channel: "git:drop-commit", kind: "invoke" },
		generateCommitMessage: { channel: "git:generate-commit-message", kind: "invoke" },
		init: { channel: "git:init", kind: "invoke" },
		push: { channel: "git:push", kind: "invoke" },
		pull: { channel: "git:pull", kind: "invoke" },
		fetch: { channel: "git:fetch", kind: "invoke" },
	},
	pi: {
		check: { channel: "pi:check", kind: "invoke" },
		checkCustom: { channel: "pi:check-custom", kind: "invoke" },
		checkUpdate: { channel: "pi:update-check", kind: "invoke" },
		update: { channel: "pi:update", kind: "invoke" },
		/** 在系统终端中执行安装命令（npm install）并返回结果 */
		execInstall: { channel: "pi:exec-install", kind: "invoke" },
		/** 检查 npm 是否可用 */
		checkNpm: { channel: "pi:check-npm", kind: "invoke" },
	},
	wsl: {
		/** 获取已安装的 WSL 发行版列表（仅 Windows） */
		listDistros: { channel: "wsl:list-distros", kind: "invoke" },
		/** 验证 WSL 连接：检查 distro + user 是否可达，以及 pi 是否已安装 */
		validateConnection: { channel: "wsl:validate-connection", kind: "invoke" },
	},
	logs: {
		list: { channel: "logs:list", kind: "invoke", pack: (query) => [query ?? {}] },
		clear: { channel: "logs:clear", kind: "invoke" },
		openFolder: { channel: "logs:open-folder", kind: "invoke" },
		/** 获取 app 日志文件总大小 */
		getSize: { channel: "logs:get-size", kind: "invoke" },
	},
	rpcLogs: {
		/** 获取 RPC 日志文件总大小 */
		getSize: { channel: "rpc-logs:get-size", kind: "invoke" },
		/** 从文件读取 RPC 日志 */
		get: { channel: "rpc-logs:get", kind: "invoke" },
		/** 清空 RPC 日志 */
		clear: { channel: "rpc-logs:clear", kind: "invoke" },
		setLogging: { channel: "rpc-logs:logging-set", kind: "invoke" },
		getLogging: { channel: "rpc-logs:logging-get", kind: "invoke" },
		openFile: { channel: "rpc-logs:open-file", kind: "invoke" },
	},
	app: {
		info: { channel: "app:info", kind: "invoke" },
		preferredSystemLanguages: { channel: "app:preferred-system-languages", kind: "invoke" },
		checkUpdate: { channel: "app:check-update", kind: "invoke" },
		downloadUpdate: { channel: "app:download-update", kind: "invoke" },
		installUpdate: { channel: "app:install-update", kind: "invoke" },
		onUpdateProgress: { channel: "app:update-progress", kind: "subscribe" },
		feedbackEnvironment: { channel: "app:feedback-environment", kind: "invoke" },
		openExternal: { channel: "app:open-external", kind: "invoke" },
		onOpenInBrowser: { channel: "app:open-in-browser", kind: "subscribe" },
		restart: { channel: "app:restart", kind: "invoke" },
		visionTest: { channel: "vision:test", kind: "invoke" },
		rendererLog: { channel: "renderer:log", kind: "invoke" },
		minimizeWindow: { channel: "app:window-minimize", kind: "invoke" },
		toggleMaximizeWindow: { channel: "app:window-toggle-maximize", kind: "invoke" },
		toggleAlwaysOnTopWindow: { channel: "app:window-toggle-always-on-top", kind: "invoke" },
		closeWindow: { channel: "app:window-close", kind: "invoke" },
		toggleDevTools: { channel: "app:toggle-devtools", kind: "invoke" },
	},
	skills: {
		list: { channel: "skills:list", kind: "invoke" },
		create: { channel: "skills:create", kind: "invoke" },
		toggle: { channel: "skills:toggle", kind: "invoke" },
		delete: { channel: "skills:delete", kind: "invoke" },
		openFolder: { channel: "skills:open-folder", kind: "invoke" },
		rename: { channel: "skills:rename", kind: "invoke" },
	},
	prompts: {
		list: { channel: "prompts:list", kind: "invoke" },
		create: { channel: "prompts:create", kind: "invoke" },
		delete: { channel: "prompts:delete", kind: "invoke" },
		openFolder: { channel: "prompts:open-folder", kind: "invoke" },
		edit: { channel: "prompts:edit", kind: "invoke" },
		listByProject: { channel: "prompts:list-by-project", kind: "invoke" },
		createInProject: { channel: "prompts:create-in-project", kind: "invoke" },
		deleteFromProject: { channel: "prompts:delete-in-project", kind: "invoke" },
		rename: { channel: "prompts:rename", kind: "invoke" },
		renameInProject: { channel: "prompts:rename-in-project", kind: "invoke" },
	},
	promptStore: {
		search: { channel: "prompt-store:search", kind: "invoke" },
		get: { channel: "prompt-store:get", kind: "invoke" },
		import: { channel: "prompt-store:import", kind: "invoke" },
	},
	skillStore: {
		search: { channel: "skill-store:search", kind: "invoke" },
		import: { channel: "skill-store:import", kind: "invoke" },
	},
	// SkillHub（api.skillhub.cn）
	skillHub: {
		search: {
			channel: "skill-hub:search",
			kind: "invoke",
			pack: (query, page, pageSize, sortBy, order) => [{ query, page, pageSize, sortBy, order }],
		},
		detail: { channel: "skill-hub:detail", kind: "invoke" },
		install: { channel: "skill-hub:install", kind: "invoke" },
	},
	yaoPrompts: {
		list: { channel: "yao-prompts:list", kind: "invoke" },
		detail: { channel: "yao-prompts:detail", kind: "invoke" },
		import: { channel: "yao-prompts:import", kind: "invoke" },
	},
	extensions: {
		list: { channel: "extensions:list", kind: "invoke" },
		uninstall: { channel: "extensions:uninstall", kind: "invoke" },
		install: { channel: "extensions:install", kind: "invoke" },
		removeBuiltIn: { channel: "extensions:remove-built-in", kind: "invoke" },
		restoreBuiltIn: { channel: "extensions:restore-built-in", kind: "invoke" },
		update: { channel: "extensions:update", kind: "invoke" },
	},
	settings: {
		get: { channel: "settings:get", kind: "invoke" },
		update: { channel: "settings:update", kind: "invoke" },
		testPiProxy: { channel: "settings:test-pi-proxy", kind: "invoke" },
		onApplyWindow: { channel: "settings:apply-window", kind: "subscribe" },
	},
	config: {
		getModels: { channel: "config:get-models", kind: "invoke" },
		getAuth: { channel: "config:get-auth", kind: "invoke" },
		getSettings: { channel: "config:get-settings", kind: "invoke" },
		getTrust: { channel: "config:get-trust", kind: "invoke" },
		saveModels: { channel: "config:save-models", kind: "invoke" },
		saveAuth: { channel: "config:save-auth", kind: "invoke" },
		saveSettings: { channel: "config:save-settings", kind: "invoke" },
		/** 原子设置 omp 默认供应商/默认模型（主进程 read-merge-write，避免渲染层并发覆盖 settings.json） */
		setDefaultModel: { channel: "config:set-default-model", kind: "invoke" },
		saveRaw: { channel: "config:save-raw", kind: "invoke" },
		export: { channel: "config:export", kind: "invoke" },
		import: { channel: "config:import", kind: "invoke" },
		/** 从 provider 的 baseUrl + apiKey 拉取可用模型列表 */
		fetchModels: {
			channel: "config:fetch-models",
			kind: "invoke",
			pack: (baseUrl, apiKey, apiType) => [{ baseUrl, apiKey, apiType }],
		},
		/** 快速测试 provider 连接：发送一条最小请求验证 baseUrl/apiKey/模型 是否正常 */
		testProvider: {
			channel: "config:test-provider",
			kind: "invoke",
			pack: (baseUrl, apiKey, modelId, apiType, headers) => [{ baseUrl, apiKey, modelId, apiType, headers }],
		},
	},
	agents: {
		list: { channel: "agents:list", kind: "invoke" },
		getMessages: { channel: "agents:get-messages", kind: "invoke" },
		create: { channel: "agents:create", kind: "invoke" },
		rename: { channel: "agents:rename", kind: "invoke" },
		stop: { channel: "agents:stop", kind: "invoke" },
		prompt: { channel: "agents:prompt", kind: "invoke" },
		abort: { channel: "agents:abort", kind: "invoke" },
		exportHtml: { channel: "agents:export-html", kind: "invoke" },
		getForkMessages: { channel: "agents:fork-messages", kind: "invoke" },
		forkSession: { channel: "agents:fork-session", kind: "invoke" },
		cloneSession: { channel: "agents:clone-session", kind: "invoke" },
		switchSession: { channel: "agents:switch-session", kind: "invoke" },
		editMessage: { channel: "agents:edit-message", kind: "invoke" },
		deleteMessage: { channel: "agents:delete-message", kind: "invoke" },
		/** 同文件重发：截断该用户消息及其后续，不生成新会话文件 */
		prepareResend: { channel: "agents:prepare-resend", kind: "invoke" },
		reload: { channel: "agents:reload", kind: "invoke" },
		restart: { channel: "agents:restart", kind: "invoke" },
		compact: { channel: "agents:compact", kind: "invoke" },
		// 双用途通道：invoke（主动拉取）+ subscribe（主进程推送运行态），见 onRuntimeState
		runtimeState: { channel: "agents:runtime-state", kind: "invoke" },
		cycleModel: { channel: "agents:cycle-model", kind: "invoke" },
		availableModels: { channel: "agents:available-models", kind: "invoke" },
		setModel: { channel: "agents:set-model", kind: "invoke" },
		/** 刷新模型配置：通知运行中的 agent 重新加载 models.json，无需重启 */
		refreshModels: { channel: "agents:refresh-models", kind: "invoke" },
		cycleThinking: { channel: "agents:cycle-thinking", kind: "invoke" },
		setThinking: { channel: "agents:set-thinking", kind: "invoke" },
		commands: { channel: "agents:commands", kind: "invoke" },
		onState: { channel: "agents:state", kind: "subscribe" },
		/** 桌面宠物点击跳转：主进程通知主窗切换到活跃 Agent tab */
		onFocusTarget: { channel: "pet:focus-agent-target", kind: "subscribe" },
		onMessages: { channel: "agents:message", kind: "subscribe" },
		onLog: { channel: "agents:log", kind: "subscribe" },
		/** 流式思考内容更新，agent 忙碌时实时推送当前思考文本 */
		onThinking: { channel: "agents:thinking", kind: "subscribe" },
		/** 主进程 → 渲染进程的轻量 toast 通知（如 abort 已请求停止） */
		onNotice: { channel: "agents:notice", kind: "subscribe" },
		/** RPC 日志，用于调试 */
		onRpcLog: { channel: "agents:rpc-log", kind: "subscribe" },
		onRuntimeState: { channel: "agents:runtime-state", kind: "subscribe" },
		/** Agent Extension UI 协议：主进程 → 渲染进程，推送扩展的 UI 请求（select/confirm/input/editor） */
		onUiRequest: { channel: "agents:ui-request", kind: "subscribe" },
		/** 渲染进程 → 主进程，传递用户在 UI 请求中的响应（选中的选项、输入的文本等） */
		sendUiResponse: { channel: "agents:ui-response", kind: "invoke" },
		notifyAsk: { channel: "agents:notify-ask", kind: "invoke" },
		/** 项目信任确认：主进程 → 渲染进程，启动 Agent 前请求用户对含 .pi 资源的项目做信任决策 */
		onTrustRequest: { channel: "agents:trust-request", kind: "subscribe" },
		/** 项目信任确认：渲染进程 → 主进程，回传用户的信任选择（trust-remember/trust-session/deny） */
		respondTrustRequest: { channel: "agents:trust-response", kind: "invoke" },
	},
	pet: {
		/** 宠物窗监听主进程推送的聚合状态 */
		onState: { channel: "pet:state", kind: "subscribe" },
		/** 列出可用宠物包（内置 + petdex） */
		list: { channel: "pet:list", kind: "invoke" },
		/** 开关宠物 */
		setEnabled: { channel: "pet:set-enabled", kind: "invoke" },
		/** 切换当前宠物 */
		setId: { channel: "pet:set-id", kind: "invoke" },
		/** 拖拽移动窗口位置 */
		moveWindow: { channel: "pet:move-window", kind: "invoke" },
		/** 点击宠物跳转活跃 Agent */
		focusAgent: { channel: "pet:focus-agent", kind: "invoke" },
		/** 主进程 → 宠物窗：推送当前选中宠物的 manifest（含 spritesheetUrl），切换宠物时热加载 */
		onSprite: { channel: "pet:current-sprite", kind: "subscribe" },
		/** 宠物窗 → 主进程：拉取当前选中宠物的 manifest（挂载时主动拉取，避免推送竞态丢失） */
		getCurrent: { channel: "pet:get-current", kind: "invoke" },
		/** 主进程 → 宠物窗：推送通知气泡（出错/完成时宠物头顶弹窗） */
		onNotify: { channel: "pet:notify", kind: "subscribe" },
		/** 设置页 → 主进程 → 宠物窗：预览动画行（测试用）——双用途通道，见 onPreviewMode */
		setPreviewMode: { channel: "pet:preview-mode", kind: "invoke" },
		onPreviewMode: { channel: "pet:preview-mode", kind: "subscribe" },
		/** 主进程 → 宠物窗：推送窗口能力探测结果（透明/穿透/自由定位） */
		onCaps: { channel: "pet:caps", kind: "subscribe" },
		/** 调试：发送测试通知弹窗 */
		testNotify: { channel: "pet:test-notify", kind: "invoke" },
		/** 双击宠物触发逗弄：主进程注入一次 jumping 后恢复真实聚合态 */
		tease: { channel: "pet:tease", kind: "invoke" },
		/** 拖拽起止通知（开始时暂停巡游，避免松手后 tick 命中反向边界瞬移） */
		setDragging: { channel: "pet:drag-state", kind: "invoke" },
		/** 拖拽相对位移（连续 screenX 差值，避免 DPI 坐标单位混用） */
		moveBy: { channel: "pet:move-by", kind: "invoke" },
		/** 宠物窗 → 主进程：React 已挂载且 IPC 监听器已注册，主进程可安全推送初始状态 */
		ready: { channel: "pet:ready", kind: "send" },
		/** 宠物窗 → 主进程：请求显示右键上下文菜单 */
		contextMenu: { channel: "pet:context-menu", kind: "invoke" },
	},
	terminal: {
		list: { channel: "terminal:list", kind: "invoke" },
		ensure: { channel: "terminal:ensure", kind: "invoke" },
		create: { channel: "terminal:create", kind: "invoke" },
		input: { channel: "terminal:input", kind: "invoke" },
		resize: { channel: "terminal:resize", kind: "invoke" },
		close: { channel: "terminal:close", kind: "invoke" },
		shells: { channel: "terminal:shells", kind: "invoke" },
		onData: { channel: "terminal:data", kind: "subscribe" },
		onExit: { channel: "terminal:exit", kind: "subscribe" },
	},
	feishu: {
		connect: { channel: "feishu:connect", kind: "invoke" },
		/** 临时连接（不保存 bot 配置），用于首次添加 Bot 时先验证后保存 */
		connectTemp: { channel: "feishu:connect-temp", kind: "invoke" },
		disconnect: { channel: "feishu:disconnect", kind: "invoke" },
		connectByBot: { channel: "feishu:connect-by-bot", kind: "invoke" },
		statusRequest: { channel: "feishu:status-request", kind: "invoke" },
		onStatus: { channel: "feishu:status", kind: "subscribe" },
		botsList: { channel: "feishu:bots-list", kind: "invoke" },
		botAdd: { channel: "feishu:bot-add", kind: "invoke" },
		botRemove: { channel: "feishu:bot-remove", kind: "invoke" },
		botConfig: { channel: "feishu:bot-config", kind: "invoke" },
		botSecret: { channel: "feishu:bot-secret", kind: "invoke" },
		testConnection: { channel: "feishu:test-connection", kind: "invoke" },
		bindingsList: { channel: "feishu:bindings-list", kind: "invoke" },
		bindingRemove: { channel: "feishu:binding-remove", kind: "invoke" },
		bindingUpdate: { channel: "feishu:binding-update", kind: "invoke" },
		onMessages: { channel: "feishu:messages", kind: "subscribe" },
		onBindingsChanged: { channel: "feishu:bindings-changed", kind: "subscribe" },
		onWhoamiResult: { channel: "feishu:whoami-result", kind: "subscribe" },
		onBotsChanged: { channel: "feishu:bots-changed", kind: "subscribe" },
		/** 获取指定 Agent 绑定的飞书 Bot ID */
		sessionBotGet: { channel: "feishu:session-bot-get", kind: "invoke" },
		/** 设置指定 Agent 使用的飞书 Bot ID */
		sessionBotSet: { channel: "feishu:session-bot-set", kind: "invoke" },
	},
	dialog: {
		/** 打开系统原生文件/文件夹选择器，返回选中路径列表 */
		pickFiles: { channel: "dialog:pick-files", kind: "invoke" },
	},
	clipboard: {
		// 写入文本是 fire-and-forget（不返回 Promise，void .catch），实现走覆盖层
		writeText: { channel: "clipboard:write-text", kind: "local" },
	},
	perf: {
		// 非 IPC：PIDECK_PERF=1 环境标志，实现走覆盖层
		enabled: { kind: "local" },
	},
	browser: {
		openExternal: { channel: "browser:open-external", kind: "invoke" },
	},
	scratchPad: {
		list: { channel: "scratch-pad:list", kind: "invoke" },
		create: { channel: "scratch-pad:create", kind: "invoke" },
		delete: { channel: "scratch-pad:delete", kind: "invoke" },
		load: { channel: "scratch-pad:load", kind: "invoke" },
		save: { channel: "scratch-pad:save", kind: "invoke" },
		export: { channel: "scratch-pad:export", kind: "invoke" },
	},
} satisfies IpcTable;

/**
 * 不暴露为 api 成员、但 preload/主进程直接使用的通道。
 * （preload 启动握手：ready / error）
 */
export const mainOnlyChannels = [
	{ channel: "preload:ready", kind: "send" },
	{ channel: "preload:error", kind: "send" },
] as const satisfies readonly IpcOpEntry[];

/** 通道名 → 派生扁平键（"agents:list" → "agentsList"）。 */
function camelFromChannel(channel: string): string {
	return channel
		.split(/[:-]/)
		.filter(Boolean)
		.map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
		.join("");
}

/**
 * 历史键名兼容表：老 ipc.ts 的常量名与严格 camelCase 派生产生过偏差
 * （产品名大小写 openCode、省略中间段 logsSize/rpcLoggingSet、DevTools 内嵌大写）。
 * 保持历史调用点零感知；新增通道禁止往这里加条目——新通道直接用严格派生名。
 */
const CHANNEL_KEY_OVERRIDES: Readonly<Record<string, string>> = {
	"opencode-sessions:scan": "openCodeSessionsScan",
	"opencode-sessions:import": "openCodeSessionsImport",
	"logs:get-size": "logsSize",
	"rpc-logs:logging-set": "rpcLoggingSet",
	"rpc-logs:logging-get": "rpcLoggingGet",
	"app:toggle-devtools": "appToggleDevTools",
};

/**
 * 由 ipcTable + mainOnlyChannels 派生的扁平通道常量表。
 * 保持历史 `ipcChannels.xxx` 调用点形态；派生冲突（两个通道名算出同一键）在模块加载时直接抛错。
 */
export const ipcChannels: Readonly<Record<string, string>> = (() => {
	const out: Record<string, string> = {};
	const register = (channel: string) => {
		const key = CHANNEL_KEY_OVERRIDES[channel] ?? camelFromChannel(channel);
		const existing = out[key];
		if (existing !== undefined && existing !== channel) {
			throw new Error(`IPC 通道派生键冲突: ${key}（${existing} vs ${channel}）`);
		}
		out[key] = channel;
	};
	for (const namespace of Object.values(ipcTable)) {
		for (const entry of Object.values(namespace)) {
			if (entry.channel) register(entry.channel);
		}
	}
	for (const entry of mainOnlyChannels) {
		register(entry.channel);
	}
	return out;
})();

/**
 * 主进程 handler 签名映射：由 api 命名空间类型生成。
 * - invoke/sendSync 成员 → ipcMain.handle 的 handler（参数来自成员函数签名；带 pack 的成员退化为宽松签名）
 * - subscribe/send/local 成员不产生 handle handler（subscribe 是主进程推送，send/local 另有去处）
 */
export type IpcHandlerMap<TTableNs, TApiNs> = {
	[M in keyof TTableNs as TTableNs[M] extends { kind: "invoke" } | { kind: "sendSync" } ? M : never]:
		TTableNs[M] extends { pack: (...args: unknown[]) => readonly unknown[] }
			? (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
			: M extends keyof TApiNs
				? TApiNs[M] extends (...args: never[]) => unknown
					? (event: IpcMainInvokeEvent, ...args: Parameters<TApiNs[M]>) => Awaited<ReturnType<TApiNs[M]>>
					: never
				: never;
};

/** 主进程 ipcMain.on 注册映射：send 成员（单向通知，如 pet:ready）。 */
export type IpcOnMap<TTableNs> = {
	[M in keyof TTableNs as TTableNs[M] extends { kind: "send" } ? M : never]: (
		event: IpcMainEvent,
		...args: unknown[]
	) => void;
};
