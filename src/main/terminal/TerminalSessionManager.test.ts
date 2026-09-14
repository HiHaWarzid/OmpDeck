import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "./TerminalSessionManager";

/**
 * 终端会话生命周期测试。
 *
 * 用真实管理器 + 假 pty 驱动，断言可观测结果而非实现细节：
 * 进程退出/显式关闭后会话是否被释放（不再持有 pty 与回放缓冲）、
 * 迟到的 onExit 是否重复广播 terminalExit、dispose 是否清掉输出合并定时器、
 * close 是否 kill 掉进程，以及按键是否按 tabId 索引路由到正确的 pty。
 */

const h = vi.hoisted(() => {
	class FakePty {
		readonly write = vi.fn();
		readonly resize = vi.fn();
		readonly kill = vi.fn();
		private readonly dataListeners: Array<(data: string) => void> = [];
		private readonly exitListeners: Array<(event: { exitCode: number }) => void> = [];

		onData(listener: (data: string) => void) {
			this.dataListeners.push(listener);
		}

		onExit(listener: (event: { exitCode: number }) => void) {
			this.exitListeners.push(listener);
		}

		emitData(data: string) {
			for (const listener of this.dataListeners) listener(data);
		}

		emitExit(exitCode: number) {
			for (const listener of this.exitListeners) listener({ exitCode });
		}
	}

	const instances: FakePty[] = [];
	const spawn = vi.fn(() => {
		const terminal = new FakePty();
		instances.push(terminal);
		return terminal;
	});

	return { instances, spawn };
});

vi.mock("node-pty", () => ({ spawn: h.spawn }));
// win32 下 shell 候选探测会 execSync("where wsl.exe")；测试里桩掉，避免起子进程且保持候选确定
vi.mock("node:child_process", () => ({
	execSync: () => {
		throw new Error("stub: skip wsl detection");
	},
}));

type Emitted = { channel: string; payload: unknown };

function makeManager(cwd = "C:/work") {
	const emitted: Emitted[] = [];
	const emit = vi.fn((channel: string, payload: unknown) => {
		emitted.push({ channel, payload });
	});
	return { manager: new TerminalSessionManager(() => cwd, emit), emit, emitted };
}

function channels(emitted: Emitted[], channel: string) {
	return emitted.filter((entry) => entry.channel === channel);
}

function spawnedPty(index: number) {
	const pty = h.instances[index];
	if (!pty) throw new Error(`no pty spawned at index ${index}`);
	return pty;
}

beforeEach(() => {
	h.instances.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("TerminalSessionManager 会话生命周期", () => {
	it("进程退出后释放 pty 但保留已退出 tab 与回放缓冲，重复退出/再 close 幂等", () => {
		vi.useFakeTimers();
		const { manager, emitted } = makeManager();
		const tab = manager.create("a1");
		const pty = spawnedPty(0);

		pty.emitData("hello");
		// 合并窗口内不广播，且只挂一个定时器
		expect(channels(emitted, "terminal:data")).toEqual([]);
		expect(vi.getTimerCount()).toBe(1);

		pty.emitExit(0);

		// 退出前先把合并窗口内的残留输出刷完，renderer 才能收全
		expect(channels(emitted, "terminal:data")).toEqual([
			{ channel: "terminal:data", payload: { tabId: tab.id, data: "hello" } },
		]);
		expect(channels(emitted, "terminal:exit")).toEqual([
			{ channel: "terminal:exit", payload: { tabId: tab.id, exitCode: 0 } },
		]);
		// 合并定时器已清掉：残留 timer 不会拖住进程，也不会再有迟到广播
		expect(vi.getTimerCount()).toBe(0);

		// pty 已脱开：按键不会再写到它
		manager.input(tab.id, "x");
		expect(pty.write).not.toHaveBeenCalled();

		// 已退出的 tab 仍在列表中（renderer 重挂载靠它恢复最后输出），带标记与回放缓冲
		const listed = manager.list("a1");
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe(tab.id);
		expect(listed[0]?.exited).toBe(true);
		expect(listed[0]?.exitCode).toBe(0);
		expect(listed[0]?.buffer).toBe("hello\r\n[process exited with code 0]\r\n");

		// ensure 不会另起 shell：已退出的会话仍代表这个 tab，回放缓冲随 list 一起返回
		expect(manager.ensure("a1").map((entry) => entry.id)).toEqual([tab.id]);
		expect(h.spawn).toHaveBeenCalledTimes(1);

		// 幂等：重复 onExit 不重复广播，也不覆盖首次退出码
		pty.emitExit(1);
		expect(channels(emitted, "terminal:exit")).toHaveLength(1);
		expect(manager.list("a1")[0]?.exitCode).toBe(0);

		// 只有显式 close 才真正移除
		manager.close(tab.id);
		expect(manager.list("a1")).toEqual([]);
		expect(() => manager.close(tab.id)).not.toThrow();
		expect(manager.list("a1")).toEqual([]);

		// 移除后再 ensure 才拉起全新终端
		const recreated = manager.ensure("a1");
		expect(recreated).toHaveLength(1);
		expect(recreated[0]?.id).not.toBe(tab.id);
	});

	it("已 close 的 tab 收到迟到 onExit：不广播 terminalExit，也不复活 runtime", () => {
		const { manager, emitted } = makeManager();
		const tab = manager.create("a1");
		const pty = spawnedPty(0);

		manager.close(tab.id);
		expect(pty.kill).toHaveBeenCalledTimes(1);
		expect(manager.list("a1")).toEqual([]);

		// close 之后 node-pty 仍会补发 onExit
		pty.emitExit(0);

		expect(channels(emitted, "terminal:exit")).toEqual([]);
		expect(manager.list("a1")).toEqual([]);
		manager.input(tab.id, "x");
		expect(pty.write).not.toHaveBeenCalled();
		expect(() => manager.close(tab.id)).not.toThrow();
	});

	it("合并窗口到期才广播，close/dispose 清掉未到期的待发定时器", () => {
		vi.useFakeTimers();
		const { manager, emitted } = makeManager();
		const tab = manager.create("a1");
		const pty = spawnedPty(0);

		pty.emitData("a");
		pty.emitData("b");
		// 窗口内不广播，且只挂一个定时器（块序不颠倒）
		expect(channels(emitted, "terminal:data")).toEqual([]);
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(16);
		expect(channels(emitted, "terminal:data")).toEqual([
			{ channel: "terminal:data", payload: { tabId: tab.id, data: "ab" } },
		]);
		expect(vi.getTimerCount()).toBe(0);

		pty.emitData("c");
		expect(vi.getTimerCount()).toBe(1);
		manager.close(tab.id);
		// 定时器被清掉，残留分片在同一次 dispose 里刷完
		expect(vi.getTimerCount()).toBe(0);
		expect(channels(emitted, "terminal:data")).toHaveLength(2);
		// 关闭后到达的尾块不能再排定时器
		pty.emitData("late");
		expect(vi.getTimerCount()).toBe(0);
		expect(channels(emitted, "terminal:data")).toHaveLength(2);
	});

	it("close 会 kill pty，并且刷完待发输出发生在 kill 之前", () => {
		const { manager, emit, emitted } = makeManager();
		const tab = manager.create("a1");
		const pty = spawnedPty(0);

		pty.emitData("partial");
		manager.close(tab.id);

		expect(pty.kill).toHaveBeenCalledTimes(1);
		expect(channels(emitted, "terminal:data")).toEqual([
			{ channel: "terminal:data", payload: { tabId: tab.id, data: "partial" } },
		]);
		expect(manager.list("a1")).toEqual([]);
		// 先 flush 再 kill：kill 之后到达的输出已经无人接收
		expect(emit.mock.invocationCallOrder[0]).toBeLessThan(
			pty.kill.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("closeAgent 释放该 agent 的全部会话，closeAll 清空所有会话", () => {
		const { manager } = makeManager();
		const a1 = manager.create("a1");
		const a2 = manager.create("a1");
		manager.create("a2");

		manager.closeAgent("a1");

		expect(manager.list("a1")).toEqual([]);
		expect(manager.list("a2")).toHaveLength(1);
		expect(spawnedPty(0).kill).toHaveBeenCalledTimes(1);
		expect(spawnedPty(1).kill).toHaveBeenCalledTimes(1);
		expect(a1.id).not.toBe(a2.id);

		manager.closeAll();
		expect(manager.list("a2")).toEqual([]);
		expect(spawnedPty(2).kill).toHaveBeenCalledTimes(1);
	});

	it("按键与 resize 按 tabId 索引路由到对应 pty，标题按 agent 内序号编号", () => {
		const { manager } = makeManager();
		const first = manager.create("a1");
		const second = manager.create("a1");
		const other = manager.create("a2");

		expect(first.title.endsWith(" 1")).toBe(true);
		expect(second.title.endsWith(" 2")).toBe(true);
		expect(other.title.endsWith(" 1")).toBe(true);

		manager.input(second.id, "ls");
		manager.resize(first.id, 100, 40);

		expect(spawnedPty(1).write).toHaveBeenCalledWith("ls");
		expect(spawnedPty(1).write).toHaveBeenCalledTimes(1);
		expect(spawnedPty(0).write).not.toHaveBeenCalled();
		expect(spawnedPty(2).write).not.toHaveBeenCalled();
		expect(spawnedPty(0).resize).toHaveBeenCalledWith(100, 40);
		expect(spawnedPty(1).resize).not.toHaveBeenCalled();
	});

	it("回放缓冲保留尾部内容且不因分片合并而丢失或错序", () => {
		const { manager } = makeManager();
		const tab = manager.create("a1");
		const pty = spawnedPty(0);

		for (let index = 0; index < 1500; index += 1) pty.emitData("ab");
		expect(manager.list("a1")[0]?.buffer).toBe("ab".repeat(1500));

		pty.emitData("x".repeat(250_000));
		const buffer = manager.list("a1")[0]?.buffer ?? "";
		expect(buffer.length).toBe(200_000);
		expect(buffer.endsWith("x".repeat(200_000))).toBe(true);
		expect(tab.id).toBe(manager.list("a1")[0]?.id);

		manager.close(tab.id);
	});
});
