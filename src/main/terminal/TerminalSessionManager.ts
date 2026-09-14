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

type Emit = (channel: string, payload: unknown) => void;
const MAX_TERMINAL_REPLAY_BUFFER = 200_000;
/**
 * 回放缓冲分片数上限：字符上限只在追加时按字符数触发，逐字节输出的极端情况下
 * 分片数组会先于字符数膨胀（20 万条空转 join），分片数超限时同样合并一次。
 */
const MAX_TERMINAL_REPLAY_PARTS = 1024;
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

/** 会话销毁原因：close=显式关闭（含 agent 关闭），exit=进程自行退出 */
type TerminalSessionDisposeReason = "close" | "exit";

type TerminalSessionHandlers = {
	/** 合并窗口到期/退出收尾：把待广播输出交给管理器（terminalData） */
	onOutput: (chunk: string) => void;
	/** 进程首次退出：交给管理器广播一次 terminalExit */
	onExit: (exitCode: number | undefined) => void;
	/** 会话已释放：交给管理器摘除索引 */
	onDispose: () => void;
};

/**
 * 单个终端 tab 的属主：独占一个 pty、一份回放缓冲与一个输出合并定时器。
 *
 * 之所以把生命周期收进这个类，是因为此前 pty/缓冲挂在管理器里、只有显式 close 才清，
 * 任何漏发 terminal:close 的卸载都会按 tab 泄漏一个 pty 与 20 万字符回放缓冲直到应用退出。
 * 结束分两步：进程退出只释放 pty（tab 与回放缓冲要留给 renderer 显示最后输出），
 * 显式关闭才彻底销毁；两步都幂等，因为 close 与进程退出会竞争同一次结束。
 */
class TerminalSession {
	readonly tab: TerminalTab;
	private terminal: pty.IPty | null;
	/** 回放缓冲分片：追加 O(1)，超过上限才合并截断，避免高频输出下每块 O(n) 整串拷贝 */
	private parts: string[] = [];
	private partsLength = 0;
	/** 待广播到渲染进程的输出分片（合并窗口内累积，到期一次发完） */
	private pendingParts: string[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	/** pty 已脱开（进程退出或显式关闭）：此后拒绝写入、不再转发输出，也不再排定时器 */
	private released = false;
	/** 已从管理器索引摘除并释放回放缓冲；只有显式关闭会走到这里 */
	private removed = false;

	constructor(
		tab: TerminalTab,
		terminal: pty.IPty,
		private readonly handlers: TerminalSessionHandlers,
	) {
		this.tab = tab;
		this.terminal = terminal;
		terminal.onData((data) => this.receive(data));
		terminal.onExit((event) => this.handleExit(event.exitCode));
	}

	write(data: string) {
		if (this.terminal == null || this.tab.exited) return;
		this.terminal.write(data);
	}

	resize(cols: number, rows: number) {
		// 已退出的 tab 静默忽略 resize，避免对已销毁的 pty 调用
		if (this.terminal == null || this.tab.exited) return;
		this.terminal.resize(Math.max(2, cols), Math.max(1, rows));
	}

	snapshot(): TerminalTab {
		return {
			...this.tab,
			buffer: this.getBuffer(),
		};
	}

	/**
	 * 收口会话资源，按结束方式区分处理：
	 * - "exit"：进程自行退出——刷完待发输出、脱开 pty，但**保留** tab 与有限回放缓冲，
	 *   renderer 折叠/切换后回来仍要看到这个已退出 shell 及其最后输出。
	 * - "close"：显式关闭（含 closeAgent/closeAll）——额外 kill 存活进程、释放回放缓冲、
	 *   从管理器索引摘除。
	 * 幂等：先到者动手，后到者（重复退出、退出后再 close、重复 close）是空操作。
	 */
	dispose(reason: TerminalSessionDisposeReason) {
		if (this.removed) return;
		// 释放前把合并窗口内的待发输出刷完，保证已产生的内容不丢
		this.flushPending();
		const terminal = this.terminal;
		this.terminal = null;
		this.released = true;
		if (reason !== "close") return;
		this.removed = true;
		if (terminal != null) {
			try {
				terminal.kill();
			} catch (error) {
				// 进程可能已自行退出（close 与 onExit 竞争）；kill 失败不能阻断资源释放
				log(`kill failed for ${this.tab.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.parts = [];
		this.partsLength = 0;
		this.handlers.onDispose();
	}

	private receive(data: string) {
		// pty 脱开后仍可能有尾块到达：已释放的会话不能再排定时器，否则进程被残留 timer 拖住
		if (this.released) return;
		this.appendBuffer(data);
		// 同一 tab 的 PTY 块在短窗口内合并为一次 IPC；单定时器保证块序不颠倒。
		this.pendingParts.push(data);
		if (this.flushTimer == null) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null;
				this.flushPending();
			}, TERMINAL_FLUSH_WINDOW_MS);
			this.flushTimer.unref?.();
		}
	}

	private handleExit(exitCode: number | undefined) {
		// close() 之后 pty 仍会补发 onExit：此时会话的 pty 已脱开，必须静默丢弃，
		// 否则会为已关闭的 tab 再广播一次 terminalExit，并让 runtime 复活。
		if (this.released) return;
		this.tab.exited = true;
		this.tab.exitCode = exitCode;
		// 退出前把合并窗口内的残留输出刷完，保证 renderer 按序收到完整输出
		this.flushPending();
		const exitText = `\r\n[process exited${exitCode != null ? ` with code ${exitCode}` : ""}]\r\n`;
		// 退出文案同时写进回放缓冲：renderer 事件只覆盖当前挂载，重挂载时靠 tab.buffer 重建内容
		this.appendBuffer(exitText);
		this.handlers.onExit(exitCode);
		// 只释放 pty，tab 与回放缓冲留到显式关闭
		this.dispose("exit");
	}

	private getBuffer(): string {
		// 分片不足两个时直接返回（含已合并的单片），避免高频输出路径的 join 开销。
		if (this.parts.length <= 1) return this.parts[0] ?? "";
		const joined = this.parts.join("");
		this.parts = [joined];
		return joined;
	}

	private appendBuffer(data: string) {
		// Renderer 会在切换项目/agent 时卸载 TerminalDock；主进程保留有限回放，
		// 切回来才能重建 xterm scrollback，同时用上限避免长期终端占用过多内存。
		// 分片追加 O(1)；仅当超过字符/分片上限时才合并截断一次，避免高频输出下整串拷贝 O(n²)。
		this.parts.push(data);
		this.partsLength += data.length;
		if (
			this.partsLength > MAX_TERMINAL_REPLAY_BUFFER ||
			this.parts.length > MAX_TERMINAL_REPLAY_PARTS
		) {
			const joined = this.parts.join("");
			const tail = joined.slice(-MAX_TERMINAL_REPLAY_BUFFER);
			this.parts = [tail];
			this.partsLength = tail.length;
		}
	}

	/** 合并窗口到期：把累积的 PTY 输出一次性广播给渲染进程。 */
	private flushPending() {
		if (this.flushTimer != null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.pendingParts.length === 0) return;
		const chunk = this.pendingParts.join("");
		this.pendingParts = [];
		this.handlers.onOutput(chunk);
	}
}

export class TerminalSessionManager {
	/** tabId → 会话：按键/resize 走 O(1) 索引，不再每次输入都线性扫描所有 agent 的终端 */
	private readonly sessions = new Map<string, TerminalSession>();
	private shellCandidatesCache: TerminalShellCandidate[] | null = null;

	constructor(
		private readonly getCwd: (agentId: string) => string,
		private readonly emit: Emit,
	) {}

	list(agentId: string) {
		return [...this.sessions.values()]
			.filter((session) => session.tab.agentId === agentId)
			.map((session) => session.snapshot());
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
		const index = this.countSessions(agentId) + 1;
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
		const session = new TerminalSession(tab, spawned.pty, {
			onOutput: (chunk) => this.emit(ipcChannels.terminalData, { tabId: id, data: chunk }),
			onExit: (exitCode) => this.emit(ipcChannels.terminalExit, { tabId: id, exitCode }),
			// 退出/关闭即摘除索引：退出的 tab 不滞留，会话连同 pty 与回放缓冲一起被回收
			onDispose: () => this.sessions.delete(id),
		});
		this.sessions.set(id, session);

		return tab;
	}

	input(tabId: string, data: string) {
		// 退出/关闭后的 tab 已从索引摘除。renderer 的按键是 fire-and-forget（不接错误），
		// 这里静默忽略，避免 IPC reject 变成渲染进程 unhandledrejection。
		this.sessions.get(tabId)?.write(data);
	}

	resize(tabId: string, cols: number, rows: number) {
		// 终端已关闭时静默忽略 resize，避免已销毁的 tab 触发未处理异常
		this.sessions.get(tabId)?.resize(cols, rows);
	}

	close(tabId: string) {
		// dispose 幂等并会经 onDispose 摘除索引；已退出的 tab 走到这里就是空操作
		this.sessions.get(tabId)?.dispose("close");
	}

	closeAgent(agentId: string) {
		// dispose 会改写索引，先快照再遍历
		for (const session of [...this.sessions.values()]) {
			if (session.tab.agentId === agentId) session.dispose("close");
		}
	}

	closeAll() {
		for (const session of [...this.sessions.values()]) {
			session.dispose("close");
		}
	}

	private countSessions(agentId: string) {
		let count = 0;
		for (const session of this.sessions.values()) {
			if (session.tab.agentId === agentId) count += 1;
		}
		return count;
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
