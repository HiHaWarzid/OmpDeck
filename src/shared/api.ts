/**
 * window.piDesktop 的完整接口定义 —— IPC 接缝的类型面。
 *
 * 单一事实源：preload 的 api 字面量以 `satisfies PiDesktopApi` 校验，
 * 通道表 `ipcTable` 以 `satisfies IpcTable` 校验，previewApi/browserApi 假实现
 * 以 `PiDesktopApi` 编译期校验——任何一侧漂移都会在 typecheck 时暴露。
 *
 * 成员名/签名与 src/preload/index.ts 的 api 字面量一一对应（由生成器建表，
 * 不要在此文件之外另起一份）。
 */
import type {
	AgentMessagesDelta,
	AgentRuntimeState,
	AgentTab,
	AgentUiRequest,
	AfkState,
	AfkTask,
	AppInfo,
	AppLogEntry,
	AppLogLevel,
	AppLogQuery,
	AppSettings,
	AppUpdateDownloadProgress,
	AppUpdateDownloadResult,
	AppUpdateAsset,
	AppUpdateInfo,
	AvailableModel,
	BranchDiffResult,
	ChatMessage,
	ClaudeImportReport,
	ClaudeSessionSummary,
	CodexImportReport,
	CodexSessionSummary,
	CommitDetail,
	CommitEntry,
	ConfigFileDiagnostic,
	CreateAgentInput,
	CreatePiPromptTemplateInput,
	CreatePiSkillInput,
	CreateProjectSkillInput,
	DraftMeta,
	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
	FeedbackEnvironment,
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuChatMessage,
	FeishuConnectInput,
	FeishuTestResult,
	FileTreeNode,
	ForkMessage,
	GitBranchInfo,
	GitCommitFileDiff,
	GitRef,
	GitResourceGroups,
	GitWorkspaceDiffGroup,
	GitWorkspaceFileDiff,
	ImageContent,
	NpmAvailabilityResult,
	OpenCodeImportReport,
	OpenCodeSessionSummary,
	PetAggregateState,
	PetManifest,
	PetNotification,
	PetWindowCaps,
	PiCliUpdateResult,
	PiCommand,
	PiExtensionListResult,
	PiInstallExecResult,
	PiInstallStatus,
	PiPromptTemplateListResult,
	PiPromptTemplateSummary,
	PiProxyTestResult,
	PiSkillListResult,
	PiSkillSummary,
	PiUpdateCheckResult,
	Project,
	ProjectResourceListResult,
	PromptStoreItem,
	PromptStoreSearchResult,
	ScratchPadData,
	SendPromptInput,
	SendPromptResult,
	SessionSummary,
	SkillHubDetail,
	SkillHubInstallResult,
	SkillHubSearchResult,
	TerminalDataEvent,
	TerminalExitEvent,
	TerminalTab,
	ThinkingUpdate,
	WorktreeEntry,
	YaoPromptDetailResult,
	YaoPromptListResult,
} from "./types";

export interface EditorsApi {
	list: () => Promise<ExternalEditor[]>;
	redetect: () => Promise<AppSettings>;
	update: (editorId: ExternalEditorId, patch: Partial<ExternalEditorSetting>) => Promise<AppSettings>;
	chooseExecutable: () => Promise<string | null>;
	openProject: (editor: ExternalEditor, projectPath: string) => Promise<void>;
}

export interface ProjectsApi {
	list: () => Promise<Project[]>;
	add: () => Promise<Project | null>;
	remove: (id: string) => Promise<Project[]>;
	reorder: (projectIds: string[]) => Promise<Project[]>;
	onChanged: (callback: (projects: Project[]) => void) => () => void;
	listRoot: () => Promise<Project[]>;
	listWorktreeChildren: (parentId: string) => Promise<Project[]>;
	toggleWorktreeEnabled: (projectId: string) => Promise<Project | null>;
	chooseChatPath: () => Promise<string | null>;
	setChatPath: (path: string) => Promise<Project | null>;
	listModels: (projectId?: string) => Promise<AvailableModel[]>;
}

export interface ProjectResourcesApi {
	list: (projectId: string) => Promise<ProjectResourceListResult>;
	createSkill: (input: CreateProjectSkillInput) => Promise<PiSkillSummary>;
	deleteSkill: (projectId: string, skillPath: string) => Promise<void>;
	deleteExtension: (projectId: string, extensionPath: string) => Promise<void>;
	toggleExtension: (projectId: string, extensionPath: string, enabled: boolean) => Promise<void>;
	toggleSkill: (projectId: string, skillPath: string, enabled: boolean) => Promise<PiSkillSummary>;
	renameSkill: (projectId: string, skillPath: string, newName: string) => Promise<PiSkillSummary>;
}

export interface FilesApi {
	list: (projectId: string) => Promise<FileTreeNode[]>;
	open: (path: string) => Promise<void>;
	showInFolder: (path: string) => Promise<void>;
	readContent: (path: string) => Promise<string>;
	/** 读取二进制文件为 data URL（粘贴资源管理器图片文件时用） */
	readBase64: (path: string) => Promise<string>;
	writeContent: (path: string, content: string) => Promise<void>;
	delete: (path: string, recursive?: boolean) => Promise<void>;
	rename: (path: string, newName: string) => Promise<string>;
	create: (parentDir: string, name: string, type: "file" | "directory") => Promise<string>;
	copy: (sourcePaths: string[], targetDir: string) => Promise<string[]>;
	move: (sourcePaths: string[], targetDir: string) => Promise<string[]>;
	/**
	 * Electron 32+ 已移除 File.path，拖拽/粘贴得到的 File 必须经 webUtils 解析本地路径。
	 * 同步返回，可在 drop/paste 事件中立即使用。
	 */
	getPathForFile: (file: File) => string;
	/** 读取资源管理器「复制文件」到剪贴板的路径列表（同步，sendSync）。 */
	getClipboardPaths: () => string[];
}

export interface SessionsApi {
	list: (projectId?: string) => Promise<SessionSummary[]>;
	rename: (filePath: string, newName: string) => Promise<void>;
	copy: (projectId: string, filePath: string) => Promise<{ cancelled?: boolean; sessionPath?: string }>;
	exportHtml: (projectId: string, filePath: string) => Promise<{ path: string }>;
	delete: (filePath: string) => Promise<void>;
	readMessages: (filePath: string) => Promise<Array<{ role: string; content: string; timestamp: number }>>;
	readUserPrompts: (filePath: string, maxCount?: number) => Promise<string[]>;
	readSessionMeta: (filePath: string) => Promise<{ provider?: string; modelId?: string; thinkingLevel?: string }>;
	readChatMessages: (filePath: string) => Promise<ChatMessage[]>;
	readMessageFullText: (agentId: string, messageId: string, entryId?: string) => Promise<{ text: string }>;
}

export interface CodexSessionsApi {
	scan: (projectId: string) => Promise<CodexSessionSummary[]>;
	import: (projectId: string, sourcePaths: string[]) => Promise<CodexImportReport>;
}

export interface ClaudeSessionsApi {
	scan: (projectId: string) => Promise<ClaudeSessionSummary[]>;
	import: (projectId: string, sourcePaths: string[]) => Promise<ClaudeImportReport>;
}

export interface OpenCodeSessionsApi {
	scan: (projectId: string) => Promise<OpenCodeSessionSummary[]>;
	import: (projectId: string, sourcePaths: string[]) => Promise<OpenCodeImportReport>;
}

export interface GitApi {
	branches: (projectId: string) => Promise<GitBranchInfo>;
	checkout: (projectId: string, branch: string) => Promise<GitBranchInfo>;
	createBranch: (projectId: string, branchName: string) => Promise<GitBranchInfo>;
	/** 读取文件的 Git HEAD 原始内容，供差异编辑器左侧基准列使用。 */
	originalContent: (filePath: string) => Promise<string>;
	worktreeList: (projectId: string) => Promise<WorktreeEntry[]>;
	worktreeCreate: (projectId: string, branchName: string) => Promise<{ path: string; branch: string }>;
	worktreeRemove: (projectId: string, worktreePath: string) => Promise<boolean>;
	commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; path?: string; allBranches?: boolean }) => Promise<CommitEntry[]>;
	refs: (projectId: string) => Promise<GitRef[]>;
	branchCompare: (projectId: string, base: string, target: string) => Promise<BranchDiffResult>;
	commitDetail: (projectId: string, ref: string) => Promise<CommitDetail | null>;
	commitFileDiff: (projectId: string, ref: string, filePath: string, originalPath?: string) => Promise<GitCommitFileDiff | null>;
	diffFileBetween: (projectId: string, ref1: string, ref2: string, filePath: string) => Promise<string>;
	status: (projectId: string) => Promise<GitResourceGroups>;
	workspaceFileDiff: (projectId: string, group: GitWorkspaceDiffGroup, filePath: string) => Promise<GitWorkspaceFileDiff | null>;
	stage: (projectId: string, paths: string[]) => Promise<void>;
	unstage: (projectId: string, paths: string[]) => Promise<void>;
	discard: (projectId: string, group: "workingTree" | "untracked", filePath: string) => Promise<void>;
	commit: (projectId: string, message: string) => Promise<void>;
	cherryPick: (projectId: string, hash: string) => Promise<void>;
	revert: (projectId: string, hash: string) => Promise<void>;
	reset: (projectId: string, hash: string, mode: "soft" | "mixed" | "hard") => Promise<void>;
	dropCommit: (projectId: string, hash: string) => Promise<void>;
	generateCommitMessage: (projectId: string) => Promise<string>;
	init: (projectId: string) => Promise<void>;
	push: (projectId: string) => Promise<void>;
	pull: (projectId: string) => Promise<void>;
	fetch: (projectId: string) => Promise<void>;
}

export interface PiApi {
	check: () => Promise<PiInstallStatus>;
	/** 验证用户手动输入的 pi 路径，通过后主进程会自动保存到 settings.customPiPath */
	checkCustom: (customPath: string) => Promise<PiInstallStatus>;
	checkUpdate: () => Promise<PiUpdateCheckResult>;
	update: () => Promise<PiCliUpdateResult>;
	/** 执行安装命令（如 npm install -g pi）并返回执行结果 */
	execInstall: (command: string) => Promise<PiInstallExecResult>;
	/** 检查 npm 是否可用 */
	checkNpm: () => Promise<NpmAvailabilityResult>;
}

/** WSL 相关操作（仅 Windows 有效） */
export interface WslApi {
	listDistros: () => Promise<string[]>;
	validateConnection: (distro: string, user: string) => Promise<{ ok: boolean; whoami: string; piVersion: string; error: string }>;
}

export interface LogsApi {
	list: (query?: AppLogQuery) => Promise<AppLogEntry[]>;
	clear: () => Promise<void>;
	openFolder: () => Promise<void>;
	getSize: () => Promise<number>;
}

export interface RpcLogsApi {
	getSize: (agentId?: string) => Promise<number>;
	get: (options?: { agentId?: string; days?: number; limit?: number }) => Promise<Array<{ id: string; agentId: string; direction: string; summary: string; time: number; data?: unknown }>>;
	clear: (agentId?: string) => Promise<void>;
	setLogging: (agentId: string, enabled: boolean) => Promise<boolean>;
	getLogging: (agentId: string) => Promise<boolean>;
	openFile: (agentId: string) => Promise<void>;
}

export interface AppApi {
	info: () => Promise<AppInfo>;
	preferredSystemLanguages: () => Promise<string[]>;
	checkUpdate: () => Promise<AppUpdateInfo>;
	downloadUpdate: (asset: AppUpdateAsset) => Promise<AppUpdateDownloadResult>;
	installUpdate: (filePath: string) => Promise<void>;
	onUpdateProgress: (callback: (progress: AppUpdateDownloadProgress) => void) => () => void;
	feedbackEnvironment: () => Promise<FeedbackEnvironment>;
	openExternal: (url: string, forceSystem?: boolean) => Promise<void>;
	onOpenInBrowser: (callback: (url: string) => void) => () => void;
	restart: () => Promise<void>;
	visionTest: (config: { baseUrl: string; apiKey: string }) => Promise<{ ok: boolean; models?: string[]; error?: string }>;
	rendererLog: (level: AppLogLevel, scope: string, message: string, detail?: unknown) => Promise<void>;
	minimizeWindow: () => Promise<void>;
	toggleMaximizeWindow: () => Promise<void>;
	toggleAlwaysOnTopWindow: () => Promise<boolean>;
	closeWindow: () => Promise<void>;
	toggleDevTools: () => Promise<boolean>;
}

export interface SkillsApi {
	list: () => Promise<PiSkillListResult>;
	create: (input: CreatePiSkillInput) => Promise<PiSkillSummary>;
	toggle: (path: string, enabled: boolean) => Promise<PiSkillSummary>;
	delete: (path: string) => Promise<void>;
	openFolder: (path?: string) => Promise<void>;
	rename: (skillPath: string, newName: string) => Promise<PiSkillSummary>;
}

export interface PromptsApi {
	list: () => Promise<PiPromptTemplateListResult>;
	create: (input: CreatePiPromptTemplateInput) => Promise<PiPromptTemplateSummary>;
	delete: (filePath: string) => Promise<void>;
	openFolder: () => Promise<void>;
	edit: (filePath: string, content?: string) => Promise<string | void>;
	listByProject: (projectPath: string) => Promise<PiPromptTemplateListResult>;
	createInProject: (projectPath: string, input: CreatePiPromptTemplateInput) => Promise<PiPromptTemplateSummary>;
	deleteFromProject: (projectPath: string, fileName: string) => Promise<void>;
	rename: (oldName: string, newName: string) => Promise<PiPromptTemplateSummary>;
	renameInProject: (projectPath: string, oldName: string, newName: string) => Promise<PiPromptTemplateSummary>;
}

export interface PromptStoreApi {
	search: (query: string, options?: { limit?: number; type?: string; category?: string; tag?: string }) => Promise<PromptStoreSearchResult>;
	get: (id: string) => Promise<PromptStoreItem>;
	import: (data: { title: string; description: string; content: string }) => Promise<PiPromptTemplateSummary>;
}

export interface SkillStoreApi {
	search: (query: string) => Promise<PromptStoreSearchResult>;
	/**
	 * locationId 运行期接受任意位置 id（主进程 handler 默认 "pi-global" 且不校验枚举，
	 * 渲染层保存位置含 project 级 4 值）；类型放宽为 string 与运行期契约一致。
	 */
	import: (item: PromptStoreItem, locationId?: string) => Promise<PiSkillSummary>;
}

/** SkillHub（api.skillhub.cn） */
export interface SkillHubApi {
	search: (query: string, page?: number, pageSize?: number, sortBy?: string, order?: string) => Promise<SkillHubSearchResult>;
	detail: (slug: string) => Promise<SkillHubDetail | null>;
	install: (slug: string, installDir: string) => Promise<SkillHubInstallResult>;
}

export interface YaoPromptsApi {
	list: (opts?: { category?: string; search?: string; page?: number; pageSize?: number; onlyCategories?: boolean }) => Promise<YaoPromptListResult>;
	detail: (slug: string, category: string) => Promise<YaoPromptDetailResult>;
	import: (slug: string, category: string) => Promise<PiPromptTemplateSummary>;
}

export interface ExtensionsApi {
	list: (forceRefresh?: boolean) => Promise<PiExtensionListResult>;
	uninstall: (source: string, scope?: "user" | "project" | "unknown") => Promise<void>;
	install: (source: string) => Promise<string>;
	removeBuiltIn: (source: string) => Promise<void>;
	restoreBuiltIn: (source: string) => Promise<void>;
	update: () => Promise<PiCliUpdateResult>;
}

export interface SettingsApi {
	get: () => Promise<AppSettings>;
	update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
	testPiProxy: () => Promise<PiProxyTestResult>;
	onApplyWindow: (callback: (settings: AppSettings) => void) => () => void;
}

export interface ConfigApi {
	getModels: () => Promise<{ raw: string; parsed: { providers: Record<string, unknown> }; diagnostic?: ConfigFileDiagnostic }>;
	getAuth: () => Promise<{ raw: string; parsed: Record<string, unknown>; diagnostic?: ConfigFileDiagnostic }>;
	getSettings: () => Promise<{ raw: string; parsed: Record<string, unknown>; diagnostic?: ConfigFileDiagnostic }>;
	getTrust: () => Promise<{ raw: string; parsed: Record<string, unknown>; diagnostic?: ConfigFileDiagnostic }>;
	saveModels: (data: unknown) => Promise<{ valid: boolean; error?: string }>;
	saveAuth: (data: unknown) => Promise<{ valid: boolean; error?: string }>;
	saveSettings: (settings: Record<string, unknown>) => Promise<{ valid: boolean; error?: string }>;
	/** 原子设置 omp 默认供应商/默认模型，返回是否写入成功 */
	setDefaultModel: (provider: string, modelId: string) => Promise<{ valid: boolean; error?: string }>;
	saveRaw: (fileName: string, rawJson: string) => Promise<{ valid: boolean; error?: string }>;
	export: () => Promise<string>;
	import: (packageJson: string) => Promise<{ valid: boolean; error?: string }>;
	/** 从 provider 的 baseUrl + apiKey 拉取可用模型列表 */
	fetchModels: (baseUrl: string, apiKey: string, apiType?: string) => Promise<{
		success: boolean;
		models?: Array<{ id: string; name?: string }>;
		error?: string;
		requestUrl?: string;
		sessionBaseUrlNeedsVersion?: boolean;
		suggestedBaseUrl?: string;
	}>;
	/** 快速测试 provider 连接：发送一条最小请求验证配置是否正常 */
	testProvider: (baseUrl: string, apiKey: string, modelId: string, apiType?: string, headers?: Record<string, string>) => Promise<{
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
		requestUrl?: string;
		requestBody?: string;
		sessionBaseUrlNeedsVersion?: boolean;
		suggestedBaseUrl?: string;
	}>;
}

export interface AgentsApi {
	list: () => Promise<AgentTab[]>;
	getMessages: (agentId: string) => Promise<ChatMessage[]>;
	create: (input: CreateAgentInput) => Promise<AgentTab>;
	rename: (agentId: string, name: string) => Promise<AgentTab>;
	stop: (agentId: string) => Promise<void>;
	prompt: (input: SendPromptInput) => Promise<SendPromptResult>;
	abort: (agentId: string) => Promise<void>;
	exportHtml: (agentId: string) => Promise<{ path: string }>;
	getForkMessages: (agentId: string) => Promise<ForkMessage[]>;
	forkSession: (agentId: string, entryId: string) => Promise<{ text?: string; cancelled?: boolean }>;
	cloneSession: (agentId: string) => Promise<{ cancelled?: boolean }>;
	switchSession: (agentId: string, sessionPath: string) => Promise<{ cancelled?: boolean }>;
	editMessage: (agentId: string, messageId: string, text: string) => Promise<void>;
	deleteMessage: (agentId: string, messageId: string) => Promise<void>;
	/** 同文件重发准备：截断原用户消息及其后续，返回可重新 prompt 的原文。 */
	prepareResend: (agentId: string, messageId: string) => Promise<{ text: string; images?: ImageContent[] }>;
	reload: (agentId: string) => Promise<void>;
	restart: (agentId: string) => Promise<AgentTab>;
	compact: (agentId: string, prompt?: string) => Promise<AgentRuntimeState>;
	runtimeState: (agentId: string) => Promise<AgentRuntimeState>;
	cycleModel: (agentId: string) => Promise<AgentRuntimeState>;
	availableModels: (agentId: string) => Promise<AvailableModel[]>;
	setModel: (agentId: string, provider: string, modelId: string) => Promise<AgentRuntimeState>;
	/** 刷新模型配置，让运行中的 agent 重新加载 models.json */
	refreshModels: (agentId: string) => Promise<AgentRuntimeState>;
	cycleThinking: (agentId: string) => Promise<AgentRuntimeState>;
	setThinking: (agentId: string, level: string) => Promise<AgentRuntimeState>;
	commands: (agentId: string) => Promise<PiCommand[]>;
	onState: (callback: (tabs: AgentTab[]) => void) => () => void;
	/** 桌面宠物点击跳转：主进程通知主窗切换到活跃 Agent tab */
	onFocusTarget: (callback: (target: { agentId: string }) => void) => () => void;
	onMessages: (callback: (payload: AgentMessagesDelta) => void) => () => void;
	onLog: (callback: (payload: { agentId: string; text: string }) => void) => () => void;
	onThinking: (callback: (payload: ThinkingUpdate) => void) => () => void;
	/** 主进程轻量 toast 通知（如 abort 已请求停止） */
	onNotice: (callback: (payload: { agentId?: string; message: string; i18nKey?: string; kind?: "info" | "warning" | "error"; duration?: number }) => void) => () => void;
	onRpcLog: (callback: (payload: { agentId: string; direction: string; summary: string; data: unknown }) => void) => () => void;
	onRuntimeState: (callback: (payload: { agentId: string; state: AgentRuntimeState }) => void) => () => void;
	/** 向 Agent 发送扩展 UI 响应（用户回答了 select/confirm/input/editor 对话框） */
	sendUiResponse: (agentId: string, requestId: string, response: { value?: string | boolean | null; cancelled?: boolean; confirmed?: boolean }) => Promise<void>;
	/** 监听 Agent 扩展 UI 请求（模型通过扩展调用了 ctx.ui.select/confirm/input/editor） */
	onUiRequest: (callback: (request: AgentUiRequest) => void) => () => void;
	/** 非活动 Agent 收到 ask 请求时请求主进程发系统通知（渲染层先判定聚焦与设置开关） */
	notifyAsk: (title: string, body: string) => Promise<void>;
	/** 监听项目信任确认请求（主进程在启动 Agent 前对含 .pi 资源的项目发起） */
	onTrustRequest: (callback: (request: { requestId: string; cwd: string; projectName: string }) => void) => () => void;
	/** 回传用户对项目信任确认弹窗的选择（trust-remember/trust-session/deny） */
	respondTrustRequest: (requestId: string, choice: "trust-remember" | "trust-session" | "deny") => Promise<void>;
}

export interface PetApi {
	/** 宠物窗监听主进程推送的聚合状态 */
	onState: (callback: (state: PetAggregateState) => void) => () => void;
	list: () => Promise<PetManifest[]>;
	setEnabled: (value: boolean) => Promise<void>;
	setId: (id: string) => Promise<void>;
	moveWindow: (pos: { x: number; y: number }) => Promise<void>;
	focusAgent: () => Promise<void>;
	/** 主进程推送当前选中宠物的 manifest，据此加载 spritesheet */
	onSprite: (callback: (manifest: PetManifest) => void) => () => void;
	getCurrent: () => Promise<PetManifest | null>;
	/** 主进程推送通知气泡（出错/完成） */
	onNotify: (callback: (n: PetNotification) => void) => () => void;
	setPreviewMode: (mode: string) => Promise<void>;
	onPreviewMode: (callback: (mode: string) => void) => () => void;
	onCaps: (callback: (caps: PetWindowCaps) => void) => () => void;
	/** 调试：发送测试通知弹窗 */
	testNotify: (type: "error" | "done") => Promise<void>;
	/** 双击宠物触发逗弄：主进程注入一次 jumping 后恢复真实聚合态 */
	tease: () => Promise<void>;
	/** 通知主进程拖拽起止：开始时暂停巡游，结束时若处于 idle 则恢复巡游 */
	setDragging: (dragging: boolean) => Promise<void>;
	/** 拖拽相对位移（连续 screenX 差值），主进程读取当前窗口位置 + 增量 */
	moveBy: (delta: { dx: number; dy: number }) => Promise<void>;
	/** 通知主进程：宠物窗 React 已挂载，IPC 监听器已注册，可以安全推送初始状态 */
	ready: () => void;
	/** 右键上下文菜单 */
	contextMenu: () => Promise<void>;
}

export interface TerminalApi {
	list: (agentId: string) => Promise<TerminalTab[]>;
	ensure: (agentId: string, cwd?: string) => Promise<TerminalTab[]>;
	create: (agentId: string, shell?: string, cwd?: string) => Promise<TerminalTab>;
	input: (tabId: string, data: string) => Promise<void>;
	resize: (tabId: string, cols: number, rows: number) => Promise<void>;
	close: (tabId: string) => Promise<void>;
	shells: () => Promise<{ shell: string; label: string; available: boolean }[]>;
	onData: (callback: (payload: TerminalDataEvent) => void) => () => void;
	onExit: (callback: (payload: TerminalExitEvent) => void) => () => void;
}

/** 飞书桥接 */
export interface FeishuApi {
	connect: (input: FeishuConnectInput) => Promise<{ success: boolean; message: string }>;
	connectTemp: (input: FeishuConnectInput) => Promise<{ success: boolean; message: string; botInfo?: { id: string; name: string } }>;
	disconnect: () => Promise<{ success: boolean }>;
	connectByBot: (botId: string) => Promise<{ success: boolean; message: string }>;
	statusRequest: () => Promise<FeishuBridgeStatus>;
	onStatus: (callback: (status: FeishuBridgeStatus) => void) => () => void;
	botsList: () => Promise<FeishuBotConfig[]>;
	botAdd: (input: FeishuConnectInput) => Promise<{ success: boolean; bot?: FeishuBotConfig; error?: string }>;
	botRemove: (botId: string) => Promise<boolean>;
	botConfig: (botId: string, patch: Partial<FeishuBotConfig>) => Promise<FeishuBotConfig | undefined>;
	botSecret: (botId: string) => Promise<string>;
	testConnection: (appId: string, appSecret: string) => Promise<FeishuTestResult>;
	bindingsList: () => Promise<FeishuChatBinding[]>;
	bindingRemove: (chatId: string) => Promise<boolean>;
	bindingUpdate: (chatId: string, patch: Partial<FeishuChatBinding>) => Promise<FeishuChatBinding | undefined>;
	onMessages: (callback: (message: FeishuChatMessage) => void) => () => void;
	onBindingsChanged: (callback: (bindings: FeishuChatBinding[]) => void) => () => void;
	onWhoamiResult: (callback: (openId: string) => void) => () => void;
	onBotsChanged: (callback: (bots: FeishuBotConfig[]) => void) => () => void;
	sessionBotGet: (agentId: string) => Promise<string | null>;
	sessionBotSet: (agentId: string, botId: string | null) => Promise<{ success: boolean; message?: string; chatId?: string }>;
}

/** 系统文件选择器 */
export interface DialogApi {
	pickFiles: (options?: { title?: string; includeDirectories?: boolean }) => Promise<string[]>;
}

/** 剪贴板 */
export interface ClipboardApi {
	/**
	 * 写入文本到系统剪贴板（fire-and-forget，不返回 Promise）。
	 * 使用主进程 clipboard API（经 IPC），避免窗口失焦时 navigator.clipboard 抛异常。
	 */
	writeText: (text: string) => void;
}

/** 性能诊断 */
export interface PerfApi {
	/** PIDECK_PERF=1 时渲染层开启帧间隔/渲染耗时诊断（见 utils/perfStats.ts） */
	enabled: boolean;
}

/** 内置浏览器 */
export interface BrowserApi {
	openExternal: (url: string) => Promise<void>;
}

export interface ScratchPadApi {
	list: () => Promise<DraftMeta[]>;
	create: () => Promise<DraftMeta>;
	delete: (draftPath: string) => Promise<void>;
	load: (draftPath?: string) => Promise<ScratchPadData>;
	save: (draftPath: string, content: string, cursorPosition: number) => Promise<void>;
	export: (draftPath: string) => Promise<boolean>;
}

/** AFK 挂机编排（主进程 AfkOrchestrator 的 IPC 面）。 */
export interface AfkApi {
	/** 快照：运行态 + 历史归档 */
	status: () => Promise<AfkState>;
	/** 启用/恢复轮询（设置变更后调用；enabled 持久化在 AppSettings.afk） */
	start: () => Promise<void>;
	/** 停用：停止轮询与新任务派发；已在跑的任务保持运行到终态 */
	stop: () => Promise<void>;
	/** 语义事件订阅：任务状态变更（AfkTask） */
	onStatusChanged: (callback: (task: AfkTask) => void) => () => void;
	/** 语义事件订阅：ticket complete（PR 已建） */
	onTicketCompleted: (callback: (task: AfkTask) => void) => () => void;
}

export interface PiDesktopApi {
	editors: EditorsApi;
	projects: ProjectsApi;
	projectResources: ProjectResourcesApi;
	files: FilesApi;
	sessions: SessionsApi;
	codexSessions: CodexSessionsApi;
	claudeSessions: ClaudeSessionsApi;
	openCodeSessions: OpenCodeSessionsApi;
	git: GitApi;
	pi: PiApi;
	wsl: WslApi;
	logs: LogsApi;
	rpcLogs: RpcLogsApi;
	app: AppApi;
	skills: SkillsApi;
	prompts: PromptsApi;
	promptStore: PromptStoreApi;
	skillStore: SkillStoreApi;
	skillHub: SkillHubApi;
	yaoPrompts: YaoPromptsApi;
	extensions: ExtensionsApi;
	settings: SettingsApi;
	config: ConfigApi;
	agents: AgentsApi;
	pet: PetApi;
	terminal: TerminalApi;
	feishu: FeishuApi;
	dialog: DialogApi;
	clipboard: ClipboardApi;
	perf: PerfApi;
	browser: BrowserApi;
	scratchPad: ScratchPadApi;
	afk: AfkApi;
}
