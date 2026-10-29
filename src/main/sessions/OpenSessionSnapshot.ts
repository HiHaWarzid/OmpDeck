/**
 * OpenSessionSnapshot —— 「上次运行打开了哪些会话」的崩溃恢复快照。
 *
 * 背景（2026-10-28 事故）：开发态主进程被外部 `Stop-Process` / 终端 Ctrl-C 强杀时，
 * 渲染层内存里的已打开会话列表随进程消失；agent 子进程只拿到 stdin EOF，会话 JSONL
 * 本身完好，但用户重启后面对空工作区，只能自己去历史抽屉里翻。本模块把已打开会话的
 * **身份**落盘，下次启动一次性交还给渲染层恢复。
 *
 * 设计约束：
 * - **同步写**：强杀路径上异步写完全没有落地机会。同一事故里三次异常退出后
 *   `settings.json` 的 mtime 一直停在 16:45（before-quit 的 `flushSave()` 从没写成），
 *   因此这里刻意不用 JsonFileStore，而用 `writeFileSync` + `renameSync` 原子替换，
 *   代价是每次最多约 1KB 的同步 IO。
 * - 只存身份（projectId / sessionPath / title），不存消息：正文由 omp `--resume` 重建。
 * - `cleanExit` 是判据：正常退出会清空快照，只有非正常退出才在下次启动交付恢复数据。
 * - 交付是**一次性**的：取出后立即从文件里清掉，避免同一批会话在后续每次崩溃时重复复活。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentTab, CrashedRun, RecoverableSession } from "../../shared/types";

const SNAPSHOT_FILE = "open-sessions.json";
/** emitState 每 50ms 就可能推一次全量快照，落盘必须合并成低频写。 */
const WRITE_DEBOUNCE_MS = 800;

type SnapshotFile = {
	version: 1;
	pid: number;
	startedAt: number;
	/** 正常退出置 true；进程被强杀时永远停在 false。 */
	cleanExit: boolean;
	sessions: RecoverableSession[];
};

function sanitizeSessions(value: unknown): RecoverableSession[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const sessions: RecoverableSession[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const raw = item as Partial<RecoverableSession>;
		if (typeof raw.projectId !== "string" || typeof raw.sessionPath !== "string") continue;
		if (!raw.projectId || !raw.sessionPath) continue;
		// 同一会话可能因项目重开被写两次；按 (项目, 会话) 去重，避免恢复出重复标签页。
		const key = `${raw.projectId}\u0000${raw.sessionPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		sessions.push({
			projectId: raw.projectId,
			sessionPath: raw.sessionPath,
			title: typeof raw.title === "string" && raw.title ? raw.title : undefined,
		});
	}
	return sessions;
}

/** 只记录真正可恢复的会话：匿名会话（no-session）和已关闭的标签页没有会话文件可 resume。 */
function toSessions(tabs: readonly AgentTab[]): RecoverableSession[] {
	const seen = new Set<string>();
	const sessions: RecoverableSession[] = [];
	for (const tab of tabs) {
		if (tab.noSession || tab.status === "closed") continue;
		if (!tab.projectId || !tab.sessionPath) continue;
		const key = `${tab.projectId}\u0000${tab.sessionPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		sessions.push({ projectId: tab.projectId, sessionPath: tab.sessionPath, title: tab.title });
	}
	return sessions;
}

export class OpenSessionSnapshot {
	private readonly filePath: string;
	private current: SnapshotFile | null = null;
	private pending: CrashedRun | null = null;
	private timer: NodeJS.Timeout | null = null;
	/** 上次落盘的 payload；emitState 高频推送时用它跳掉无变化写入。 */
	private lastPayload: string | null = null;

	constructor(userDataDir: string) {
		this.filePath = join(userDataDir, SNAPSHOT_FILE);
	}

	/**
	 * 读取上一次运行的快照；只有「非正常退出且仍有会话」才算待恢复。
	 * 必须在 beginRun() 之前调用（beginRun 会覆盖文件）。
	 */
	readCrashedRun(): CrashedRun | null {
		let parsed: Partial<SnapshotFile> | null = null;
		try {
			parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<SnapshotFile>;
		} catch {
			// 文件不存在（首次运行）或内容损坏：都按「没有可恢复会话」处理，
			// 后续 beginRun 会把它重写成合法内容。
			return null;
		}
		if (!parsed || parsed.cleanExit !== false) return null;
		const sessions = sanitizeSessions(parsed.sessions);
		if (sessions.length === 0) return null;
		this.pending = {
			startedAt: Number(parsed.startedAt) || 0,
			pid: Number(parsed.pid) || 0,
			sessions,
		};
		return this.pending;
	}

	/**
	 * 标记本次运行开始：写入本进程 PID/启动时间并置 cleanExit=false。
	 * 上次未交付的恢复数据会原样带进新文件——渲染层还没取走就再次崩溃时不会丢。
	 */
	beginRun(): void {
		this.lastPayload = null;
		this.current = {
			version: 1,
			pid: process.pid,
			startedAt: Date.now(),
			cleanExit: false,
			sessions: this.pending?.sessions ?? [],
		};
		this.writeSync(this.current);
	}

	/**
	 * 记录当前打开的会话（防抖合并写入）。
	 *
	 * 尚未被渲染层取走的待恢复会话必须一并保留：启动后 agent 列表第一次推送通常是空列表，
	 * 若直接用空列表覆盖，就会在渲染层调用 takeCrashedRun 之前把恢复数据抹掉（再次崩溃即永久丢失）。
	 */
	recordAgents(tabs: readonly AgentTab[]): void {
		if (!this.current) return;
		const open = toSessions(tabs);
		const undelivered = this.pending?.sessions ?? [];
		const sessions = undelivered.length
			? [
					...undelivered.filter(
						(item) =>
							!open.some(
								(session) =>
									session.projectId === item.projectId &&
									session.sessionPath === item.sessionPath,
							),
					),
					...open,
				]
			: open;
		const payload = JSON.stringify(sessions);
		if (payload === this.lastPayload) return;
		this.lastPayload = payload;
		this.current = { ...this.current, sessions };
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			if (this.current) this.writeSync(this.current);
		}, WRITE_DEBOUNCE_MS);
	}

	/** 一次性交付崩溃快照：同一进程内第二次调用返回 null，并清掉文件里的待恢复列表。 */
	takeCrashedRun(): CrashedRun | null {
		const pending = this.pending;
		if (!pending) return null;
		this.pending = null;
		if (this.current) {
			this.current = {
				...this.current,
				sessions: this.current.sessions.filter(
					(session) =>
						!pending.sessions.some(
							(item) =>
								item.projectId === session.projectId &&
								item.sessionPath === session.sessionPath,
						),
				),
			};
			this.writeSync(this.current);
		}
		// 取出后重启恢复会产生与取出前相同的 tab 列表；不清缓存会被误判成「无变化」而不落盘。
		this.lastPayload = null;
		return pending;
	}

	/** 正常退出：取消待写、清空会话列表并置 cleanExit=true（同步落盘）。 */
	markCleanExit(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending = null;
		this.lastPayload = null;
		const base = this.current ?? {
			version: 1 as const,
			pid: process.pid,
			startedAt: Date.now(),
			cleanExit: false,
			sessions: [],
		};
		this.current = { ...base, cleanExit: true, sessions: [] };
		this.writeSync(this.current);
	}

	private writeSync(snapshot: SnapshotFile): void {
		const tmpPath = `${this.filePath}.${process.pid}.tmp`;
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(tmpPath, JSON.stringify(snapshot), "utf8");
			// rename 在 Windows 上会替换已存在的目标（MoveFileEx REPLACE_EXISTING），
			// 因此读侧永远看到完整 JSON，不会读到写了一半的文件。
			renameSync(tmpPath, this.filePath);
		} catch {
			// 恢复信息是尽力而为的旁路数据：磁盘写失败不能影响主流程，也不能抛到 emitState 回调里。
			try {
				rmSync(tmpPath, { force: true });
			} catch {
				// 忽略清理失败
			}
		}
	}
}
