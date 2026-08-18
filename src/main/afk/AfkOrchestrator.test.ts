/**
 * AfkOrchestrator 状态机测试（ADR-0001 可测试性杠杆）：注入 FakeTicketSource +
 * 各依赖 fake（AgentManager/WorktreeService/ProjectStore/SettingsStore），
 * 用真实 Orchestrator 代码走完 selection → worktree → spawn → settled/error → 终态，
 * 以及超时与崩溃恢复路径。gh/git 网络面分别由 FakeTicketSource 与 mocked CommandRunner 隔离
 * （CommandRunner 自身语义由 src/main/utils/CommandRunner.test.ts 覆盖，本套件不重复）。
 *
 * 计时全部用 fake timers 驱动：Orchestrator 内部 setInterval/Date.now 确定性推进，
 * 不依赖真实墙钟（ts-no-test-timers）。
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { AgentTab, AfkSettings, AfkState, AppSettings, CreateAgentInput, Project, SendPromptInput, SendPromptResult } from "../../shared/types";
import type { AgentManagerEventListener } from "../../shared/types";
import { AfkOrchestrator, type AfkOrchestratorDeps } from "./AfkOrchestrator";
import type { AfkTicket, TicketSource } from "./ticketSources";

/** 每测试用例独立临时 userData（beforeEach 注入 electron mock 与各 fake 的锚点） */
let userData = "";

// ── electron / CommandRunner mock（hoisted：vi.mock 工厂先于模块求值执行；
//    工厂内不可引用模块 import，临时目录经 state 容器在 beforeEach 注入） ──

const { state, mocks } = vi.hoisted(() => ({
	state: { userData: "" },
	mocks: {
		runGit: vi.fn(async (_cwd: string, _args: string[]) => ""),
	},
}));

vi.mock("electron", () => ({
	app: { getPath: () => state.userData },
}));

vi.mock("../utils/CommandRunner", () => ({
	CommandError: class extends Error {
		kind: string;
		code: number | undefined;
		constructor(kind: string, message: string, code?: number) {
			super(message);
			this.kind = kind;
			this.code = code;
		}
	},
	// 真实命令执行由 CommandRunner.test.ts 覆盖；此处按参数分类返回确定性 stdout
	runGit: mocks.runGit,
	runGh: async () => "",
	runCommand: async () => ({ stdout: "" }),
}));

// ── 依赖 fakes ──

class FakeAgentManager {
	readonly listeners: AgentManagerEventListener[] = [];
	readonly tabs = new Map<string, AgentTab>();
	readonly prompts: SendPromptInput[] = [];
	readonly stopped: string[] = [];
	/** 设置后 sendPrompt 拒绝（模拟 RPC 预检失败路径） */
	rejectPromptError: string | null = null;
	private counter = 0;

	onAgentEvent(listener: AgentManagerEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	list(): AgentTab[] {
		return [...this.tabs.values()];
	}

	async create(input: CreateAgentInput): Promise<AgentTab> {
		this.counter += 1;
		const tab: AgentTab = {
			id: `tab-${this.counter}`,
			projectId: input.projectId,
			cwd: input.cwd ?? "",
			title: input.title ?? "",
			status: "running",
			createdAt: Date.now(),
			noSession: input.noSession,
		};
		this.tabs.set(tab.id, tab);
		return tab;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		this.prompts.push(input);
		if (this.rejectPromptError !== null) return { accepted: false, error: this.rejectPromptError };
		return { accepted: true };
	}

	async stop(agentId: string): Promise<void> {
		this.stopped.push(agentId);
		this.tabs.delete(agentId);
	}

	emitSettled(agentId: string): void {
		for (const listener of this.listeners) listener({ type: "settled", agentId });
	}

	emitError(agentId: string, lastError: string): void {
		for (const listener of this.listeners) {
			listener({
				type: "statusChanged",
				agentId,
				status: "error",
				tab: { id: agentId, projectId: "", cwd: "", title: "", status: "error", createdAt: 0, lastError },
			});
		}
	}
}

class FakeWorktreeService {
	readonly createAfkCalls: Array<{ projectPath: string; ticketId: number; title: string }> = [];
	readonly removedWithWip: Array<{ worktreePath: string; projectPath: string; ticketRef: number }> = [];
	readonly committedWip: Array<{ worktreePath: string; ticketRef: number }> = [];
	readonly ensuredAuthorFor: string[] = [];

	async createAfk(projectPath: string, ticketId: number, title: string) {
		this.createAfkCalls.push({ projectPath, ticketId, title });
		return { path: join(projectPath, `wt-${ticketId}`), branch: `afk-${ticketId}-wip`, reused: false };
	}

	async removeWithWip(worktreePath: string, projectPath: string, ticketRef: number): Promise<boolean> {
		this.removedWithWip.push({ worktreePath, projectPath, ticketRef });
		return true;
	}

	async gcBranch(): Promise<void> {}

	async commitWip(worktreePath: string, ticketRef: number): Promise<void> {
		this.committedWip.push({ worktreePath, ticketRef });
	}

	async ensureGitAuthor(projectPath: string): Promise<void> {
		this.ensuredAuthorFor.push(projectPath);
	}
}

class FakeProjectStore {
	readonly projects: Project[] = [];

	get(id: string): Project | undefined {
		return this.projects.find((project) => project.id === id);
	}

	async add(): Promise<void> {}

	findByPath(): Project | null {
		return null;
	}

	async remove(): Promise<void> {}
}

class FakeSettingsStore {
	afk: AfkSettings = {
		enabled: false,
		targetProjectIds: ["p1"],
		pollIntervalMs: 60_000,
		timeoutMs: 30 * 60_000,
	};

	get(): AppSettings {
		return { afk: this.afk } as AppSettings;
	}

	async update(patch: Partial<AppSettings>): Promise<AppSettings> {
		if (patch.afk) this.afk = { ...this.afk, ...patch.afk };
		return this.get();
	}
}

/**
 * FakeTicketSource：复刻真实 gh 语义的关键副作用——
 * - claim 把 assignee 置为 @me（真实 gh 的 --add-assignee @me）
 * - failIssue/completeIssue 把 ticket 移出 ready-for-agent 列表（真实 gh 的重标 label），
 *   防止 poll 把同一 ticket 循环重派。
 */
class FakeTicketSource implements TicketSource {
	readonly readyList: AfkTicket[] = [];
	readonly bodies = new Map<number, string>();
	readonly claimed: number[] = [];
	readonly completed: Array<{ number: number; prUrl?: string }> = [];
	readonly failed: Array<{ number: number; summary: string }> = [];
	readonly prs: Array<{ branch: string; title: string; body: string }> = [];
	/** ticket number → 可派发项目路径约束（模拟按项目扫描 gh list）；缺省不限路径 */
	readonly ticketProjectPaths = new Map<number, string>();
	me = "afk-bot";
	listCalls = 0;
	private prCounter = 0;

	async listReadyForAgent(cwd: string): Promise<AfkTicket[]> {
		this.listCalls += 1;
		return this.readyList
			.filter((ticket) => {
				const bound = this.ticketProjectPaths.get(ticket.number);
				return bound === undefined || bound === cwd;
			})
			.map((ticket) => ({ ...ticket }));
	}

	async getIssueBody(_cwd: string, number: number): Promise<string> {
		return this.bodies.get(number) ?? "";
	}

	async getCurrentUser(): Promise<string> {
		return this.me;
	}

	async claim(_cwd: string, number: number): Promise<void> {
		this.claimed.push(number);
		const ticket = this.readyList.find((item) => item.number === number);
		if (ticket) ticket.assignees = [this.me];
	}

	async completeIssue(_cwd: string, number: number, prUrl?: string): Promise<void> {
		this.completed.push({ number, prUrl });
		this.removeTicket(number);
	}

	async failIssue(_cwd: string, number: number, summary: string): Promise<void> {
		this.failed.push({ number, summary });
		this.removeTicket(number);
	}

	async createPr(_cwd: string, branch: string, title: string, body: string): Promise<{ url: string }> {
		this.prs.push({ branch, title, body });
		this.prCounter += 1;
		return { url: `https://github.com/org/repo/pull/${this.prCounter}` };
	}

	private removeTicket(number: number): void {
		const index = this.readyList.findIndex((ticket) => ticket.number === number);
		if (index >= 0) this.readyList.splice(index, 1);
	}
}

// ── harness ──

function makeTicket(number: number, title: string, overrides: Partial<AfkTicket> = {}): AfkTicket {
	return { number, title, labels: ["ready-for-agent"], assignees: [], ...overrides };
}

function buildHarness(settings: Partial<AfkSettings> = {}) {
	const agentManager = new FakeAgentManager();
	const worktreeService = new FakeWorktreeService();
	const projectStore = new FakeProjectStore();
	projectStore.projects.push({
		id: "p1",
		name: "repo",
		path: join(userData, "repo"),
		lastOpenedAt: 0,
	});
	const settingsStore = new FakeSettingsStore();
	settingsStore.afk = { ...settingsStore.afk, ...settings };
	const ticketSource = new FakeTicketSource();

	const deps: AfkOrchestratorDeps = {
		agentManager: agentManager as unknown as AfkOrchestratorDeps["agentManager"],
		worktreeService: worktreeService as unknown as AfkOrchestratorDeps["worktreeService"],
		projectStore: projectStore as unknown as AfkOrchestratorDeps["projectStore"],
		settingsStore: settingsStore as unknown as AfkOrchestratorDeps["settingsStore"],
		getMainWindow: () => null,
		ticketSource,
	};
	const orchestrator = new AfkOrchestrator(deps);
	return { orchestrator, agentManager, worktreeService, projectStore, settingsStore, ticketSource };
}

function writeStateFile(state: Partial<AfkState>): void {
	writeFileSync(join(userData, "afk-state.json"), JSON.stringify(state, null, 2), "utf8");
}

/** 推进一步 fake 时钟并排空微任务链（poll/dispatch 全是 async/await，无真实墙钟依赖） */
async function flushAsync(): Promise<void> {
	await vi.advanceTimersByTimeAsync(1);
}

/** 轮询等待条件成立（fake 时钟推进，最多 200ms fake 时间） */
async function settleUntil(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i += 1) {
		if (condition()) return;
		await vi.advanceTimersByTimeAsync(1);
	}
	throw new Error("settleUntil: 等待条件超时");
}

beforeEach(() => {
	userData = join(tmpdir(), `afk-orchestrator-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
	state.userData = userData;
	vi.useFakeTimers();
	mkdirSync(userData, { recursive: true });
});

afterEach(() => {
	mocks.runGit.mockReset();
	mocks.runGit.mockImplementation(async () => "");
	rmSync(userData, { recursive: true, force: true });
	vi.useRealTimers();
});

// ── tests ──

describe("AfkOrchestrator 状态机", () => {
	test("happy path：selection → worktree → spawn → settled → push/PR → pr-pending", async () => {
		const h = buildHarness();
		h.ticketSource.readyList.push(makeTicket(42, "Fix flaky test", { labels: ["ready-for-agent", "workflow:test"] }));
		h.ticketSource.bodies.set(42, "repro steps\n---\ndetails");

		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);
		await h.orchestrator.stop();

		// dispatch 完成：任务登记 + 认领 + worktree 创建 + agent spawn + brief 派发
		const task = h.orchestrator.getState().tasks[0]!;
		assert.equal(task.status, "running");
		assert.equal(task.ticketRef, 42);
		assert.equal(task.branch, "afk-42-wip");
		assert.ok(task.worktreePath);
		assert.equal(task.agentId, "tab-1");
		assert.deepEqual(h.ticketSource.claimed, [42]);
		assert.equal(h.worktreeService.createAfkCalls.length, 1);
		assert.deepEqual(
			h.worktreeService.createAfkCalls[0],
			{ projectPath: join(userData, "repo"), ticketId: 42, title: "Fix flaky test" },
		);
		assert.equal(h.worktreeService.ensuredAuthorFor.length, 1, "派发前应保证 git author（ADR-0003）");
		const prompt = h.agentManager.prompts[0]!;
		assert.match(prompt.message, /# Goal\nFix flaky test/);
		assert.match(prompt.message, /# Brief\nrepro steps/);
		assert.match(prompt.message, /# Workflow\nworkflow:test/);

		// 真实提交含 [afk-wip] 快照 → 过滤后仍有余量 → 开 PR
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) =>
			args[0] === "log" ? "feat: real work\n[afk-wip] #42\nchore: cleanup" : "",
		);
		h.agentManager.emitSettled(task.agentId!);
		await settleUntil(() => h.orchestrator.getState().tasks[0]!.status === "pr-pending");

		const done = h.orchestrator.getState().tasks[0]!;
		assert.equal(done.status, "pr-pending");
		assert.ok(done.prUrl, "开 PR 后应回填 prUrl");
		assert.equal(h.ticketSource.prs.length, 1);
		assert.equal(h.ticketSource.prs[0]!.branch, "afk-42-wip");
		assert.match(h.ticketSource.prs[0]!.title, /AFK #42: Fix flaky test/);
		assert.match(h.ticketSource.prs[0]!.body, /feat: real work/);
		assert.match(h.ticketSource.prs[0]!.body, /chore: cleanup/);
		assert.doesNotMatch(h.ticketSource.prs[0]!.body, /\[afk-wip\] #42/, "WIP 快照不应进入 PR body（ADR-0006）");
		assert.deepEqual(h.ticketSource.completed, [{ number: 42, prUrl: done.prUrl }]);
		assert.equal(h.worktreeService.removedWithWip.length, 1);
		assert.deepEqual(h.ticketSource.failed, [], "成功路径不应触发失败回写");
		assert.ok(h.agentManager.stopped.includes(task.agentId!), "终态后应停 agent 防泄漏");
	});

	test("无真实提交：不开 PR，标 complete + 注释说明（ADR-0006）", async () => {
		const h = buildHarness();
		h.ticketSource.readyList.push(makeTicket(7, "Docs only"));
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);
		await h.orchestrator.stop();

		const task = h.orchestrator.getState().tasks[0]!;
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) =>
			args[0] === "log" ? "[afk-wip] #7\n[afk-wip] #7" : "",
		);
		h.agentManager.emitSettled(task.agentId!);
		await settleUntil(() => h.orchestrator.getState().tasks[0]!.status === "complete");

		assert.equal(h.ticketSource.prs.length, 0, "无真实提交不应开 PR");
		assert.deepEqual(h.ticketSource.completed, [{ number: 7, prUrl: undefined }]);
		assert.equal(h.worktreeService.removedWithWip.length, 1);
	});

	test("agent error：failed + needs-info 回写 + 删 worktree（keepWorktree=false）", async () => {
		const h = buildHarness();
		h.ticketSource.readyList.push(makeTicket(3, "Will fail"));
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);
		await h.orchestrator.stop();

		const task = h.orchestrator.getState().tasks[0]!;
		h.agentManager.emitError(task.agentId!, "RPC 连接中断");
		await settleUntil(() => h.orchestrator.getState().tasks[0]!.status === "failed");

		const failed = h.orchestrator.getState().tasks[0]!;
		assert.equal(failed.status, "failed");
		assert.ok(failed.endedAt);
		assert.match(failed.errorSummary!, /RPC 连接中断/);
		assert.deepEqual(h.ticketSource.failed, [{ number: 3, summary: "RPC 连接中断" }]);
		assert.equal(h.worktreeService.removedWithWip.length, 1, "非超时失败应删 worktree");
		assert.equal(h.worktreeService.committedWip.length, 0);
		assert.ok(h.agentManager.stopped.includes(task.agentId!));
	});

	test("超时：failed（keepWorktree=true）→ WIP 快照提交、worktree 保留（ADR-0003）", async () => {
		const h = buildHarness({ pollIntervalMs: 5, timeoutMs: 30 });
		h.ticketSource.readyList.push(makeTicket(9, "Slow task"));
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);

		// 推进 fake 时钟越过 timeoutMs：poll 周期内 checkTimeouts 判定超时
		await vi.advanceTimersByTimeAsync(100);
		await settleUntil(() => h.orchestrator.getState().tasks[0]!.status === "failed");
		await h.orchestrator.stop();

		const failed = h.orchestrator.getState().tasks[0]!;
		assert.equal(failed.status, "failed");
		assert.match(failed.errorSummary!, /超时/);
		assert.ok(failed.worktreePath, "超时后 worktree 保留供重跑复用（ADR-0003）");
		assert.equal(h.worktreeService.committedWip.length, 1, "超时路径应提交 WIP 快照");
		assert.deepEqual(h.worktreeService.committedWip[0]!.ticketRef, 9);
		assert.equal(h.worktreeService.removedWithWip.length, 0, "超时路径不删 worktree");
		assert.deepEqual(h.ticketSource.failed.map((f) => f.number), [9]);
	});

	test("RPC 预检失败：failed + 回写 needs-info（sendPrompt accepted=false）", async () => {
		const h = buildHarness({ pollIntervalMs: 5 });
		h.ticketSource.readyList.push(makeTicket(31, "Rejected"));
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);

		// 当前任务已 running；模拟下一次派发遇到 RPC 拒绝
		h.agentManager.rejectPromptError = "模型未配置";
		h.ticketSource.readyList.push(makeTicket(32, "Second"));
		// 让旧任务失败退场（串行锁 hasActiveTask 释放），下一轮 poll 派发新 ticket
		h.agentManager.emitError(h.orchestrator.getState().tasks[0]!.agentId!, "旧任务失败");
		await settleUntil(() => h.orchestrator.getState().tasks.some((t) => t.ticketRef === 32));
		await settleUntil(() => h.orchestrator.getState().tasks.find((t) => t.ticketRef === 32)!.status === "failed");
		await h.orchestrator.stop();

		const second = h.orchestrator.getState().tasks.find((t) => t.ticketRef === 32)!;
		assert.equal(second.status, "failed");
		assert.match(second.errorSummary!, /RPC 预检失败/);
		assert.match(second.errorSummary!, /模型未配置/);
		assert.ok(h.worktreeService.removedWithWip.length >= 2, "预检失败走删除路径（keepWorktree=false）");
		assert.ok(h.ticketSource.failed.some((f) => f.number === 32), "预检失败应回写 needs-info 防循环重派");
	});

	test("已认领给别人的 ticket 跳过（AFK Identity）", async () => {
		const h = buildHarness();
		h.ticketSource.readyList.push(makeTicket(11, "Taken", { assignees: ["someone-else"] }));
		await h.orchestrator.start();
		await settleUntil(() => h.ticketSource.listCalls >= 1);
		await flushAsync();
		await h.orchestrator.stop();

		assert.equal(h.orchestrator.getState().tasks.length, 0, "别人的 ticket 不应被派发");
		assert.deepEqual(h.ticketSource.claimed, []);
	});

	test("崩溃恢复：agent 已死 → 强清 worktree 留 WIP → failed（ADR-0003）", async () => {
		writeStateFile({
			tasks: [
				{
					ticketRef: 21,
					title: "Interrupted",
					projectId: "p1",
					worktreePath: join(userData, "wt-21"),
					branch: "afk-21-wip",
					agentId: "gone-agent",
					status: "running",
					startedAt: Date.now() - 1000,
				},
			],
			enabled: false,
		});
		const h = buildHarness();
		await h.orchestrator.start();
		await h.orchestrator.stop();

		const recovered = h.orchestrator.getState().tasks[0]!;
		assert.equal(recovered.status, "failed");
		assert.match(recovered.errorSummary!, /崩溃恢复/);
		assert.equal(h.worktreeService.removedWithWip.length, 1, "死亡 agent 应强清 worktree 留 WIP");
		assert.equal(h.worktreeService.removedWithWip[0]!.ticketRef, 21);
		assert.deepEqual(h.ticketSource.failed.map((f) => f.number), [21], "回写 needs-info 防循环重派");
	});

	test("崩溃恢复：agent 仍存活 → needs-review 等人，不判死", async () => {
		writeStateFile({
			tasks: [
				{
					ticketRef: 22,
					title: "Still working",
					projectId: "p1",
					worktreePath: join(userData, "wt-22"),
					branch: "afk-22-wip",
					agentId: "alive-agent",
					status: "running",
					startedAt: Date.now() - 1000,
				},
			],
			enabled: false,
		});
		const h = buildHarness();
		h.agentManager.tabs.set("alive-agent", {
			id: "alive-agent",
			projectId: "p1",
			cwd: join(userData, "wt-22"),
			title: "AFK: #22",
			status: "running",
			createdAt: 0,
		});
		await h.orchestrator.start();
		await h.orchestrator.stop();

		const recovered = h.orchestrator.getState().tasks[0]!;
		assert.equal(recovered.status, "needs-review", "agent 存活 → 等人审，不判死");
		assert.equal(h.worktreeService.removedWithWip.length, 0, "存活任务不动 worktree");
		assert.deepEqual(h.ticketSource.failed, []);
	});

	test("崩溃恢复：queued 未派发任务 → failed + needs-info 回写", async () => {
		writeStateFile({
			tasks: [
				{
					ticketRef: 23,
					title: "Never dispatched",
					projectId: "p1",
					status: "queued",
					startedAt: Date.now() - 1000,
				},
			],
			enabled: false,
		});
		const h = buildHarness();
		await h.orchestrator.start();
		await h.orchestrator.stop();

		const recovered = h.orchestrator.getState().tasks[0]!;
		assert.equal(recovered.status, "failed");
		assert.equal(h.ticketSource.failed.length, 1);
	});
});

describe("AfkOrchestrator 串行与选择规则", () => {
	test("同一 ticket 已有活跃任务时不再重派（串行锁 + ACTIVE_STATUSES）", async () => {
		const h = buildHarness({ pollIntervalMs: 5 });
		h.ticketSource.readyList.push(makeTicket(50, "Active"));
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);

		// 推进多轮 poll（pollInterval 5ms）；任务仍 running 期间不得重复派发
		await vi.advanceTimersByTimeAsync(30);
		assert.equal(h.orchestrator.getState().tasks.length, 1, "活跃任务期间不得重复派发");
		assert.equal(h.ticketSource.claimed.filter((n) => n === 50).length, 1, "claim 只应发生一次");
		await h.orchestrator.stop();
	});

	test("无目标项目时轮询直接跳过，不发 gh list", async () => {
		const h = buildHarness({ targetProjectIds: [] });
		h.ticketSource.readyList.push(makeTicket(60, "Orphan"));
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 0);
		await flushAsync();
		await h.orchestrator.stop();
		assert.equal(h.ticketSource.listCalls, 0, "无项目时连 gh list 都不应发起");
	});
});

describe("AfkOrchestrator applySettings 热更新", () => {
	test("enabled=true 置位后立即轮询派发；enabled=false 停表不再派发", async () => {
		const h = buildHarness({ pollIntervalMs: 5 });
		// 初始 settings 未启用：applySettings 前不轮询
		await h.orchestrator.applySettings({ afk: h.settingsStore.afk });
		await flushAsync();
		assert.equal(h.orchestrator.getState().enabled, false);
		assert.equal(h.ticketSource.listCalls, 0, "未启用不得发 gh list");

		h.ticketSource.readyList.push(makeTicket(90, "Live toggle"));
		// 模拟 settings-save：先落库再 applySettings（enabled 已由 SettingsStore 持久化）
		await h.settingsStore.update({ afk: { ...h.settingsStore.afk, enabled: true } });
		await h.orchestrator.applySettings({ afk: h.settingsStore.afk });
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);
		assert.equal(h.orchestrator.getState().enabled, true, "applySettings 应同步 state.enabled");
		assert.equal(h.ticketSource.claimed.filter((n) => n === 90).length, 1, "启用后应派发首个 ready ticket");

		// 停用：后续轮询不再派发新任务（当前任务保持运行到事件路径收口）
		await h.settingsStore.update({ afk: { ...h.settingsStore.afk, enabled: false } });
		await h.orchestrator.applySettings({ afk: h.settingsStore.afk });
		assert.equal(h.orchestrator.getState().enabled, false);
		await vi.advanceTimersByTimeAsync(50);
		assert.equal(h.ticketSource.claimed.length, 1, "停用后不得再派发");
		await h.orchestrator.stop();
	});

	test("targetProjectIds 变更：下一轮 poll 按新项目扫描，任务绑定新项目", async () => {
		const h = buildHarness({ pollIntervalMs: 5 });
		h.projectStore.projects.push({
			id: "p2",
			name: "repo2",
			path: join(userData, "repo2"),
			lastOpenedAt: 0,
		});
		h.ticketSource.readyList.push(makeTicket(91, "From p2"));
		h.ticketSource.ticketProjectPaths.set(91, join(userData, "repo2"));
		await h.settingsStore.update({
			afk: { ...h.settingsStore.afk, enabled: true, targetProjectIds: ["p1"] },
		});
		await h.orchestrator.applySettings({ afk: h.settingsStore.afk });
		await settleUntil(() => h.ticketSource.listCalls >= 1);
		await flushAsync();
		assert.equal(h.orchestrator.getState().tasks.length, 0, "p1 无 ready ticket，不得派发");

		// 目标切到 p2（不改 enabled）：立即扫下一轮并派发
		await h.settingsStore.update({
			afk: { ...h.settingsStore.afk, targetProjectIds: ["p2"] },
		});
		await h.orchestrator.applySettings({ afk: h.settingsStore.afk });
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);
		assert.equal(h.orchestrator.getState().tasks[0]!.projectId, "p2", "任务应绑定新目标项目");
		await h.orchestrator.stop();
	});
});

describe("AfkOrchestrator 终止与工单地址", () => {
	test("terminate：stop agent + failed 收口 + WIP 保留 + needs-info 回写", async () => {
		const h = buildHarness();
		h.ticketSource.readyList.push(makeTicket(77, "Kill me"));
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);
		await h.orchestrator.stop();

		const task = h.orchestrator.getState().tasks[0]!;
		await h.orchestrator.terminate(task.ticketRef);
		await settleUntil(() => h.orchestrator.getState().tasks[0]!.status === "failed");

		const terminated = h.orchestrator.getState().tasks[0]!;
		assert.equal(terminated.status, "failed");
		assert.ok(terminated.endedAt, "终止应落到终态（endedAt 已记录）");
		assert.match(terminated.errorSummary!, /用户终止/);
		assert.ok(h.agentManager.stopped.includes(task.agentId!), "终止应停 agent");
		assert.deepEqual(h.ticketSource.failed.map((f) => f.number), [77], "回写 needs-info 防循环重派");
		assert.equal(h.worktreeService.committedWip.length, 1, "用户终止等同超时：WIP 快照提交（ADR-0003）");
		assert.equal(h.worktreeService.removedWithWip.length, 0, "用户终止保留 worktree 供重跑复用");
	});

	test("terminate 幂等：终态任务再次终止不重复处理", async () => {
		const h = buildHarness();
		h.ticketSource.readyList.push(makeTicket(78, "Already done"));
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);
		await h.orchestrator.stop();

		const task = h.orchestrator.getState().tasks[0]!;
		await h.orchestrator.terminate(task.ticketRef);
		await settleUntil(() => h.orchestrator.getState().tasks[0]!.status === "failed");
		const failedCount = h.ticketSource.failed.length;
		await h.orchestrator.terminate(task.ticketRef);
		assert.equal(h.ticketSource.failed.length, failedCount, "终态任务不重复回写");
	});

	test("ticketUrl：dispatch 时从 git remote 反查仓库基址拼工单地址", async () => {
		const h = buildHarness();
		h.ticketSource.readyList.push(makeTicket(55, "Url me"));
		mocks.runGit.mockImplementation(async (_cwd: string, args: string[]) =>
			args[0] === "remote" ? "git@github.com:org/repo.git" : "",
		);
		await h.orchestrator.start();
		await settleUntil(() => h.orchestrator.getState().tasks.length === 1);
		await h.orchestrator.stop();

		const task = h.orchestrator.getState().tasks[0]!;
		assert.equal(task.ticketUrl, "https://github.com/org/repo/issues/55");
		assert.ok(task.createdAt, "dispatch 应登记 createdAt");
		assert.ok(task.claimedAt, "认领成功后应记录 claimedAt");
		assert.ok(task.worktreeAt, "worktree 创建后应记录 worktreeAt");
	});
});