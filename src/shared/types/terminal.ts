export type TerminalShell = "pwsh" | "powershell" | "cmd" | "zsh" | "bash" | "fish" | "sh" | "git-bash" | "wsl";

/** 终端 shell 候选，包含可执行路径和启动参数 */
export type TerminalShellCandidate = {
	shell: TerminalShell;
	label: string;
	/** 是否已检测到该 shell 可用 */
	available: boolean;
};

export type TerminalTab = {
	id: string;
	agentId: string;
	title: string;
	cwd: string;
	shell: TerminalShell;
	createdAt: number;
	exited?: boolean;
	exitCode?: number;
	buffer?: string;
};

export type TerminalDataEvent = {
	tabId: string;
	data: string;
};

export type TerminalExitEvent = {
	tabId: string;
	exitCode?: number;
};
