import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { ipcChannels } from "../../shared/ipc";
import type { TerminalShell, TerminalTab } from "../../shared/types";

// 简单日志，不依赖 appLogger 以避免循环引用
const log = (msg: string) => {
	console.error(`[TerminalSessionManager] ${msg}`);
};

type TerminalRuntime = {
	tab: TerminalTab;
	pty: pty.IPty;
	/** 回放缓冲分片：追加 O(1)，超过上限才合并截断，避免高频输出下每块 O(n) 整串拷贝 */
	parts: string[];
	partsLength: number;
	/** 待广播到渲染进程的输出分片（合并窗口内累积，到期一次发完） */
	pendingParts: string[];
	flushTimer: NodeJS.Timeout | null;
};

type Emit = (channel: string, payload: unknown) => void;
const MAX_TERMINAL_REPLAY_BUFFER = 200_000;
/** PTY 输出合并窗口：构建日志等高吞吐输出时把每块一次 IPC 合并成窗口内一次，降低跨进程序列化次数 */
const TERMINAL_FLUSH_WINDOW_MS = 16;
type TerminalShellCandidate = {
	shell: TerminalShell;
	command: string;
	args: string[];
};

export function getTerminalShellCandidates(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): TerminalShellCandidate[] {
	if (platform === "win32") {
		const candidates: TerminalShellCandidate[] = [
			{ shell: "pwsh", command: "pwsh.exe", args: [] },
			{ shell: "powershell", command: "powershell.exe", args: [] },
			{ shell: "cmd", command: "cmd.exe", args: [] },
		];
		// 检测 Git Bash（常见安装路径）
		const gitBashPaths = [
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
		];
		for (const p of gitBashPaths) {
			if (existsSync(p)) {
				candidates.push({ shell: "git-bash", command: p, args: ["--login", "-i"] });
				break;
			}
		}
		// 检测 WSL：检查 wsl.exe 是否在 PATH 中
		try {
			execSync("where wsl.exe", { stdio: "ignore", timeout: 3000 });
			candidates.push({ shell: "wsl", command: "wsl.exe", args: [] });
		} catch {
			// wsl.exe 不可用，跳过 WSL
		}
		return dedupeShellCandidates(candidates);
	}

	if (platform === "darwin") {
		const userShell = normalizePosixShell(env.SHELL);
		const candidates: TerminalShellCandidate[] = [];
		if (userShell) candidates.push(userShell);
		// macOS GUI 应用拿到的进程环境通常不是用户登录 shell 环境；
		// 用登录 shell 启动可以让 zsh/bash 初始化 TTY 与用户 PATH，行为更接近 Terminal.app。
		candidates.push(
			{ shell: "zsh", command: "/bin/zsh", args: ["-l"] },
			{ shell: "bash", command: "/bin/bash", args: ["-l"] },
			{ shell: "sh", command: "/bin/sh", args: [] },
		);
		return dedupeShellCandidates(candidates);
	}

	const userShell = normalizePosixShell(env.SHELL);
	const candidates: TerminalShellCandidate[] = [];
	if (userShell) candidates.push(userShell);
	candidates.push(
		{ shell: "bash", command: "bash", args: [] },
		{ shell: "sh", command: "sh", args: [] },
	);
	return dedupeShellCandidates(candidates);
}

function normalizePosixShell(
	shellPath: string | undefined,
): TerminalShellCandidate | null {
	if (!shellPath) return null;
	const name = shellPath.split(/[\\/]/).pop();
	if (name === "zsh") return { shell: "zsh", command: shellPath, args: ["-l"] };
	if (name === "bash") return { shell: "bash", command: shellPath, args: ["-l"] };
	if (name === "fish") return { shell: "fish", command: shellPath, args: ["-l"] };
	if (name === "sh") return { shell: "sh", command: shellPath, args: [] };
	return { shell: "sh", command: shellPath, args: [] };
}

function dedupeShellCandidates(candidates: TerminalShellCandidate[]) {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = `${candidate.command}\0${candidate.args.join("\0")}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export class TerminalSessionManager {
	private readonly runtimes = new Map<string, Map<string, TerminalRuntime>>();
	private shellCandidatesCache: TerminalShellCandidate[] | null = null;

	constructor(
		private readonly getCwd: (agentId: string) => string,
		private readonly emit: Emit,
	) {}

	list(agentId: string) {
		return [...(this.runtimes.get(agentId)?.values() ?? [])].map(
			(runtime) => this.snapshot(runtime),
		);
	}

	/**
	 * 返回当前平台可用的终端 shell 列表，供前端下拉选择。
	 * 返回前检测每个候选是否可 spawn，不可用的标记为 available: false。
	 */
	listShells(): { shell: TerminalShell; label: string; available: boolean }[] {
		return this.shellCandidates().map((c) => ({
			shell: c.shell,
			label: this.displayShell(c.shell),
			available: true,
		}));
	}

	ensure(agentId: string, cwd?: string) {
		const existing = this.list(agentId);
		if (existing.length > 0) return existing;
		// Renderer 在 StrictMode 下会重复触发 mount effect；这里提供原子兜底，
		// 避免 list -> create 两步之间的竞态导致“未点击却多出两个终端”。
		return [this.create(agentId, undefined, cwd)];
	}

	create(agentId: string, shell?: TerminalShell, cwd?: string): TerminalTab {
		const resolvedCwd = cwd ?? this.getCwd(agentId);
		const runtimes = this.ensureAgent(agentId);
		const index = runtimes.size + 1;
		const id = randomUUID();
		const spawned = this.spawnShell(resolvedCwd, shell);
		const tab: TerminalTab = {
			id,
			agentId,
			title: `${this.displayShell(spawned.shell)} ${index}`,
			cwd: resolvedCwd,
			shell: spawned.shell,
			createdAt: Date.now(),
		};
		const runtime: TerminalRuntime = {
			tab,
			pty: spawned.pty,
			parts: [],
			partsLength: 0,
			pendingParts: [],
			flushTimer: null,
		};
		runtimes.set(id, runtime);

		spawned.pty.onData((data) => {
			this.appendBuffer(runtime, data);
			// 同一 tab 的 PTY 块在短窗口内合并为一次 IPC；单定时器保证块序不颠倒。
			runtime.pendingParts.push(data);
			if (runtime.flushTimer == null) {
				runtime.flushTimer = setTimeout(() => {
					runtime.flushTimer = null;
					this.flushPending(runtime);
				}, TERMINAL_FLUSH_WINDOW_MS);
				runtime.flushTimer.unref?.();
			}
		});
		spawned.pty.onExit((event) => {
			tab.exited = true;
			tab.exitCode = event.exitCode;
			// 退出前把合并窗口内的残留输出刷完，保证回放内容完整
			this.flushPending(runtime);
			const exitText = `\r\n[process exited${event.exitCode != null ? ` with code ${event.exitCode}` : ""}]\r\n`;
			this.appendBuffer(runtime, exitText);
			this.emit(ipcChannels.terminalExit, {
				tabId: id,
				exitCode: event.exitCode,
			});
		});

		return tab;
	}

	input(tabId: string, data: string) {
		const runtime = this.requireTab(tabId);
		if (runtime.tab.exited) return;
		runtime.pty.write(data);
	}

	resize(tabId: string, cols: number, rows: number) {
		// 终端已关闭时静默忽略 resize，避免已销毁的 tab 触发未处理异常
		const found = this.findRuntime(tabId);
		if (!found || found.runtime.tab.exited) return;
		found.runtime.pty.resize(Math.max(2, cols), Math.max(1, rows));
	}

	close(tabId: string) {
		const found = this.findRuntime(tabId);
		if (!found) return;
		this.flushPending(found.runtime);
		found.runtime.pty.kill();
		found.tabs.delete(tabId);
		if (found.tabs.size === 0) this.runtimes.delete(found.runtime.tab.agentId);
	}

	closeAgent(agentId: string) {
		const tabs = this.runtimes.get(agentId);
		if (!tabs) return;
		for (const runtime of tabs.values()) {
			this.flushPending(runtime);
			runtime.pty.kill();
		}
		this.runtimes.delete(agentId);
	}

	closeAll() {
		for (const agentId of this.runtimes.keys()) {
			this.closeAgent(agentId);
		}
	}

	private ensureAgent(agentId: string) {
		const existing = this.runtimes.get(agentId);
		if (existing) return existing;
		const next = new Map<string, TerminalRuntime>();
		this.runtimes.set(agentId, next);
		return next;
	}

	private requireTab(tabId: string) {
		const found = this.findRuntime(tabId);
		if (!found) throw new Error(`Terminal not found: ${tabId}`);
		return found.runtime;
	}

	private findRuntime(tabId: string) {
		for (const tabs of this.runtimes.values()) {
			const runtime = tabs.get(tabId);
			if (runtime) return { tabs, runtime };
		}
		return undefined;
	}

	private snapshot(runtime: TerminalRuntime): TerminalTab {
		return {
			...runtime.tab,
			buffer: this.getBuffer(runtime),
		};
	}

	private getBuffer(runtime: TerminalRuntime): string {
		// 分片不足两个时直接返回（含已合并的单片），避免高频输出路径的 join 开销。
		if (runtime.parts.length <= 1) return runtime.parts[0] ?? "";
		const joined = runtime.parts.join("");
		runtime.parts = [joined];
		return joined;
	}

	private appendBuffer(runtime: TerminalRuntime, data: string) {
		// Renderer 会在切换项目/agent 时卸载 TerminalDock；主进程保留有限回放，
		// 切回来才能重建 xterm scrollback，同时用字符上限避免长期终端占用过多内存。
		// 分片追加 O(1)；仅当总量超过上限时才合并截断一次，避免高频输出下整串拷贝 O(n²)。
		runtime.parts.push(data);
		runtime.partsLength += data.length;
		if (runtime.partsLength > MAX_TERMINAL_REPLAY_BUFFER) {
			const joined = runtime.parts.join("");
			const tail = joined.slice(-MAX_TERMINAL_REPLAY_BUFFER);
			runtime.parts = [tail];
			runtime.partsLength = tail.length;
		}
	}

	/** 合并窗口到期：把累积的 PTY 输出一次性广播给渲染进程。 */
	private flushPending(runtime: TerminalRuntime) {
		if (runtime.flushTimer != null) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
		}
		if (runtime.pendingParts.length === 0) return;
		const chunk = runtime.pendingParts.join("");
		runtime.pendingParts = [];
		this.emit(ipcChannels.terminalData, { tabId: runtime.tab.id, data: chunk });
	}

	private spawnShell(cwd: string, preferredShell?: TerminalShell): { shell: TerminalShell; pty: pty.IPty } {
		const candidates = this.shellCandidates();
		// 如果有首选 shell，先在候选列表中查找匹配项
		const ordered = preferredShell
			? [
					...candidates.filter((c) => c.shell === preferredShell),
					...candidates.filter((c) => c.shell !== preferredShell),
			  ]
			: candidates;
		log(`spawnShell: preferred=${preferredShell}, ordered=${ordered.map((c) => c.shell).join(", ")}`);
		let lastError: unknown;
		for (const candidate of ordered) {
			try {
				// macOS GUI 应用（Electron）不继承登录 shell 的环境变量，
				// LANG/LC_CTYPE 可能为空或 C，导致 shell 内 UTF-8 输出乱码。
				// 显式注入 UTF-8 locale，让 shell 知道应以 UTF-8 解释字节流。
				const env = { ...process.env };
				if (!env.LANG) env.LANG = "en_US.UTF-8";
				if (!env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
				const terminal = pty.spawn(candidate.command, candidate.args, {
					name: "xterm-256color",
					cols: 80,
					rows: 24,
					cwd,
					env,
				});
				return { shell: candidate.shell, pty: terminal };
			} catch (error) {
				lastError = error;
				log(`Failed to spawn ${candidate.shell} (${candidate.command}): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("No supported shell found");
	}

	private shellCandidates(): TerminalShellCandidate[] {
		// 进程运行期间平台与 PATH 不变；缓存探测结果，避免每次创建终端/列出 shell
		// 都 execSync("where wsl.exe") 同步阻塞主进程（最坏 3s 超时）。
		if (this.shellCandidatesCache == null) {
			this.shellCandidatesCache = getTerminalShellCandidates(process.platform, process.env);
		}
		return this.shellCandidatesCache;
	}

	private displayShell(shell: TerminalShell) {
		if (shell === "pwsh") return "pwsh";
		if (shell === "powershell") return "Windows PowerShell";
		if (shell === "cmd") return "cmd";
		if (shell === "zsh") return "zsh";
		if (shell === "bash") return "bash";
		if (shell === "fish") return "fish";
		if (shell === "git-bash") return "Git Bash";
		if (shell === "wsl") return "WSL";
		return "shell";
	}
}
