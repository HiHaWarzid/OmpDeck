import type {
	AgentTab,
	AppSettings,
	ChatMessage,
	FileTreeNode,
	PiSkillSummary,
	Project,
	SessionSummary,
	TerminalTab,
} from "../../shared/types";
import { createDefaultExternalEditorSettings } from "../../shared/types";
import { t } from "./i18n";

/**
 * preview 罐头 fixture 工厂（候选 6）：此前这些结构体在 previewApi.ts 内联手写
 * （PiSkillSummary 重造 4 处、全量 AppSettings 字面量 ~60 行），新增成员必须
 * 给罐头数据时变成一次函数调用而非复制粘贴结构体。全部工厂纯构造 + i18n 文案。
 */

export function makePreviewProject(overrides?: Partial<Project>): Project {
	return {
		id: "preview-project",
		name: "preview-project",
		path: "C:/Users/14012/preview-project",
		lastOpenedAt: Date.now(),
		sortOrder: 0,
		...overrides,
	};
}

export function makeChatProject(): Project {
	return {
		id: "builtin-chat",
		name: "Chat",
		path: "C:/Users/14012/AppData/Roaming/pi-desktop/chat-workspace",
		lastOpenedAt: Date.now(),
		pinned: true,
		sortOrder: -1,
		kind: "chat",
	};
}

export function makePreviewAgentTitle(): string {
	return t("preview.agentTitle");
}

export function makePreviewAgent(overrides?: Partial<AgentTab>): AgentTab {
	return {
		id: "preview-agent",
		projectId: "builtin-chat",
		cwd: "C:/Users/14012/AppData/Roaming/pi-desktop/chat-workspace",
		title: makePreviewAgentTitle(),
		status: "idle",
		sessionId: "preview",
		createdAt: Date.now(),
		...overrides,
	};
}

export function makePreviewMessages(): ChatMessage[] {
	const now = Date.now();
	return [
		{
			id: "m1",
			agentId: "preview-agent",
			role: "user",
			text: t("preview.userPrompt"),
			timestamp: now - 120000,
		},
		{
			id: "m2",
			agentId: "preview-agent",
			role: "assistant",
			text: t("preview.assistantText"),
			timestamp: now - 90000,
		},
		{
			id: "m3",
			agentId: "preview-agent",
			role: "tool",
			text: "✓ read done",
			timestamp: now - 60000,
			meta: { detailText: t("preview.toolDetail") },
		},
	];
}

export function makePreviewFileTree(): FileTreeNode[] {
	return [
		{
			name: "src",
			path: "C:/Users/14012/preview-project/src",
			relativePath: "src",
			type: "directory",
			children: [
				{
					name: "App.tsx",
					path: "C:/Users/14012/preview-project/src/App.tsx",
					relativePath: "src/App.tsx",
					type: "file",
				},
			],
		},
		{
			name: "README.md",
			path: "C:/Users/14012/preview-project/README.md",
			relativePath: "README.md",
			type: "file",
		},
	];
}

export function makePreviewSession(overrides?: Partial<SessionSummary>): SessionSummary {
	return {
		id: "s1",
		filePath: "preview.jsonl",
		projectPath: "C:/Users/14012/AppData/Roaming/pi-desktop/chat-workspace",
		name: t("preview.sessionName"),
		preview: t("preview.sessionPreview"),
		updatedAt: Date.now(),
		messageCount: 3,
		...overrides,
	};
}

export function makePreviewTerminalTab(
	agentId: string,
	index: number,
): TerminalTab {
	return {
		id: `preview-terminal-${index}`,
		agentId,
		title: `PowerShell ${index}`,
		cwd: "C:/Users/14012/preview-project",
		shell: "powershell",
		createdAt: Date.now(),
	};
}

export function makePreviewSkillSummary(overrides?: {
	id?: string;
	name?: string;
	path?: string;
	dir?: string;
	description?: string;
	sourceId?: "project-pi" | "pi-global";
	sourceLabel?: string;
	enabled?: boolean;
}): PiSkillSummary {
	const name = overrides?.name ?? "preview-skill";
	const id = overrides?.id ?? `project-pi:${name}`;
	const path =
		overrides?.path ?? `C:/Users/preview/project/.omp/skills/${name}/SKILL.md`;
	const dir =
		overrides?.dir ?? `C:/Users/preview/project/.omp/skills/${name}`;
	return {
		id,
		name,
		description: overrides?.description ?? "",
		path,
		dir,
		sourceId: (overrides?.sourceId ?? "project-pi") as PiSkillSummary["sourceId"],
		sourceLabel: overrides?.sourceLabel ?? ".omp/skills",
		type: "directory" as const,
		enabled: overrides?.enabled ?? true,
		valid: true,
		warnings: [],
	};
}

export function makePreviewAppSettings(): AppSettings {
	return {
		useNativeTitleBar: true,
		showNativeMenu: false,
		sendShortcut: "enter-send",
		theme: "system",
		lightBackground: "white",
		language: "system",
		startupWindowMode: "maximized",
		piEnvironmentChecked: true,
		enableGitManagement: true,
		gitCommitMessagePrompt: "",
		closeToTray: false,
		singleInstance: true,
		enableNotifications: true,
		// showThinking 由 pi agent 的 hideThinkingBlock 控制，运行时从主进程加载
		showThinking: true,
		showDevTools: false,
		electronChromiumSandbox: false,
		piProxyEnabled: false,
		piProxyUrl: "http://127.0.0.1:7890",
		piProxyBypass: "localhost,127.0.0.1,::1",
		desktopProxyEnabled: false,
		desktopProxyUrl: "http://127.0.0.1:7890",
		desktopProxyBypass: "localhost,127.0.0.1,::1",
		customPiPath: "",
		wslEnabled: false,
		wslDistro: "Ubuntu",
		wslUser: "root",
		telemetryEnabled: true,
		webServiceEnabled: false,
		webServiceHost: "0.0.0.0",
		webServicePort: 8765,
		rpcTimeout: 600_000,
		linkOpenMode: "external",
		contentMaxWidth: 1400,
		maxEditorFileSizeMB: 5,
		externalEditors: createDefaultExternalEditorSettings(),

		// 桌面宠物默认关闭
		petEnabled: false,
		petId: "clawd",
		petAlwaysOnTop: true,
		petScale: 0.8,
		petPatrolEnabled: true,
		petPatrolPauseMin: 5,
		favoriteModels: [],

		fontSize: "default",
		uiFontSize: null,
		chatFontSize: null,
		inputFontSize: null,
		zoomFactor: 1,
		fontFamilyBase: "system",
		fontFamilyBaseCustom: "",
		fontFamilyMono: "commit-mono",
		fontFamilyMonoCustom: "",
		removedBuiltInExtensions: [],
		disableUpdateCheck: false,
		piRpcOffline: true,
		piRpcNoExtensions: false,
		piRpcNoSkills: false,
		afk: { enabled: false, targetProjectIds: [], pollIntervalMs: 60_000, timeoutMs: 30 * 60_000 },
	};
}
