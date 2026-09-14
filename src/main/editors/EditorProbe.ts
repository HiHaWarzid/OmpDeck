import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ExternalEditor, ExternalEditorId } from "../../shared/types";

/** 探测候选表的一行：纯数据，测试注入假命中即可覆盖优先级，不必触碰真实文件系统/注册表。 */
export type EditorCandidate = {
	id: ExternalEditorId;
	name: string;
	commands: string[];
	commonPaths: string[];
	windowsExecutableNames?: string[];
	windowsRegistryNames?: string[];
	args?: string[];
};

/** 探测子进程的最小形状：只保留 stdout 读取、error/close 通知与 kill，避免 node ChildProcess 重载外泄。 */
export type ProbeChild = {
	stdout: { setEncoding(encoding: BufferEncoding): void; on(event: "data", listener: (chunk: string) => void): void } | null;
	/** 子进程创建失败（如 ENOENT）。 */
	onError(listener: () => void): void;
	/** 子进程已退出（含被 kill）；到此前 stdout 已读全。 */
	onClose(listener: () => void): void;
	kill(signal?: NodeJS.Signals): boolean;
};

/** spawn 端口：默认走 node child_process，测试注入假实现即可统计 kill/模拟永不退出。 */
export type SpawnProbeChild = (command: string, args: string[]) => ProbeChild;

/**
 * 注册表兜底探测：返回候选项可启动的安装路径，未命中/超时/非 Windows 返回 null。
 * timeoutMs 是该候选人注册表探测的总上限；signal 中止时实现必须 kill 在跑的子进程。
 */
export type RegistryInstallLookup = (
	candidate: EditorCandidate,
	timeoutMs: number,
	signal: AbortSignal,
) => Promise<string | null>;

/** 探测批执行端口：文件系统、PATH 查找与注册表兜底均可注入。 */
export type EditorProbePorts = {
	exists(path: string): Promise<boolean>;
	findOnPath(command: string): Promise<string | null>;
	lookupRegistryInstall: RegistryInstallLookup;
};

/** 单条 reg query 的时间上限：正常安装表几百毫秒返回，给足余量又不至于卡住整批。 */
export const PROBE_COMMAND_TIMEOUT_MS = 4_000;
/** 一次「检测已安装编辑器」的总预算：耗尽即取消剩余探测并返回已找到的结果。 */
export const DETECT_BUDGET_MS = 10_000;

const REGISTRY_UNINSTALL_ROOTS = [
	"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/** 真实 spawn 适配器：把 node ChildProcess 收敛成 ProbeChild，spawn 选项不外泄到端口调用方。 */
export const spawnProbeChild: SpawnProbeChild = (command, args) => {
	const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
	return {
		stdout: child.stdout,
		onError: (listener) => {
			child.once("error", listener);
		},
		onClose: (listener) => {
			child.once("close", listener);
		},
		kill: (signal) => child.kill(signal),
	};
};

/**
 * 有界命令执行器：到 timeoutMs 或 signal 中止即 kill 子进程，并返回已收集输出（永不 reject）。
 * 超时路径必须 kill，否则卡死的 reg.exe 会一直占着句柄，探测批也就无法收敛。
 */
export function createBoundedCommandRunner(spawnChild: SpawnProbeChild) {
	return (command: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<string> =>
		new Promise<string>((resolve) => {
			let output = "";
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let child: ProbeChild;
			try {
				child = spawnChild(command, args);
			} catch {
				// spawn 本身抛错（如参数非法）等同本次探测无输出，不打断整批。
				resolve("");
				return;
			}
			function finish() {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", killAndFinish);
				resolve(output);
			}
			function killAndFinish() {
				if (settled) return;
				try {
					child.kill();
				} catch {
					// 子进程可能已退出；kill 失败不影响收敛。
				}
				finish();
			}
			signal.addEventListener("abort", killAndFinish, { once: true });
			if (signal.aborted) {
				killAndFinish();
				return;
			}
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk) => {
				output += chunk;
			});
			child.onError(finish);
			child.onClose(finish);
			timer = setTimeout(killAndFinish, Math.max(1, timeoutMs));
		});
}

function parseRegValue(block: string, name: string) {
	const match = block.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, "im"));
	return match?.[1]?.trim() ?? "";
}

function normalizeDisplayIcon(value: string) {
	const trimmed = value.trim().replace(/^"|"$/g, "");
	return trimmed.replace(/,-?\d+$/, "");
}

function isLaunchableRegistryPath(path: string, executableNames: string[]) {
	const extension = extname(path).toLowerCase();
	if (![".exe", ".cmd", ".bat"].includes(extension)) return false;
	const fileName = basename(path).toLowerCase();
	return executableNames.some((name) => name.toLowerCase() === fileName);
}

/** 注册表兜底探测实现：每条 reg query 都走有界执行器，超时即 kill 并放弃本次候选人。 */
export function createWindowsRegistryLookup(deps: {
	spawnChild: SpawnProbeChild;
	exists(path: string): Promise<boolean>;
	platform?: NodeJS.Platform;
}): RegistryInstallLookup {
	const run = createBoundedCommandRunner(deps.spawnChild);
	const platform = deps.platform ?? process.platform;
	return async (candidate, timeoutMs, signal) => {
		if (platform !== "win32") return null;
		const names = candidate.windowsRegistryNames ?? [];
		const executableNames = candidate.windowsExecutableNames ?? [];
		if (names.length === 0 || executableNames.length === 0) return null;

		const deadline = Date.now() + Math.max(1, timeoutMs);
		for (const root of REGISTRY_UNINSTALL_ROOTS) {
			if (signal.aborted) return null;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return null;
			const output = await run("reg", ["query", root, "/s"], remaining, signal);
			// 预算耗尽中止：此时输出可能只是半截 hive，继续解析没有意义。
			if (signal.aborted) return null;
			for (const block of output.split(/\r?\n(?=HKEY_)/)) {
				const displayName = parseRegValue(block, "DisplayName").toLowerCase();
				if (!displayName || !names.some((name) => displayName.includes(name))) continue;
				const displayIcon = normalizeDisplayIcon(parseRegValue(block, "DisplayIcon"));
				if (displayIcon && isLaunchableRegistryPath(displayIcon, executableNames) && await deps.exists(displayIcon)) return displayIcon;
				const installLocation = parseRegValue(block, "InstallLocation");
				if (!installLocation) continue;
				for (const executableName of executableNames) {
					const executablePath = join(installLocation, executableName);
					if (await deps.exists(executablePath)) return executablePath;
					const binPath = join(installLocation, "bin", executableName);
					if (await deps.exists(binPath)) return binPath;
				}
			}
		}
		return null;
	};
}

/**
 * 有界探测批：按候选表顺序探测（PATH → 常见安装目录 → 注册表兜底），
 * 整体受 budgetMs 约束；预算耗尽或单项超时即取消剩余探测并返回已找到的编辑器。
 */
export async function probe(
	candidates: EditorCandidate[],
	budgetMs: number,
	ports: EditorProbePorts,
): Promise<ExternalEditor[]> {
	const deadline = Date.now() + Math.max(1, budgetMs);
	const remaining = () => deadline - Date.now();
	// 预算耗尽时用它通知仍在跑的子进程探测（有界执行器会 kill）。
	const controller = new AbortController();
	const editors: ExternalEditor[] = [];
	const seen = new Set<ExternalEditorId>();
	try {
		for (const candidate of candidates) {
			if (remaining() <= 0) {
				controller.abort();
				break;
			}
			let command: string | null = null;
			let detectedFrom: ExternalEditor["detectedFrom"] = "path";
			for (const cli of candidate.commands) {
				command = await ports.findOnPath(cli);
				if (command) break;
			}
			if (!command) {
				for (const commonPath of candidate.commonPaths) {
					if (remaining() <= 0) break;
					if (await ports.exists(commonPath)) {
						command = commonPath;
						detectedFrom = "common-path";
						break;
					}
				}
			}
			if (!command && remaining() > 0) {
				const lookupBudget = Math.min(PROBE_COMMAND_TIMEOUT_MS, remaining());
				command = await ports.lookupRegistryInstall(candidate, lookupBudget, controller.signal);
				if (command) detectedFrom = "common-path";
			}
			if (!command) continue;
			if (seen.has(candidate.id)) continue;
			seen.add(candidate.id);
			editors.push({
				id: candidate.id,
				name: candidate.name,
				command,
				args: candidate.args,
				detectedFrom,
			});
		}
	} finally {
		// 无论正常结束还是抛错都要中止在跑的子进程，避免留下卡死的 reg.exe。
		controller.abort();
	}
	return editors;
}
