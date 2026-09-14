import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "vitest";

import { PiProcess } from "./PiProcess";

/**
 * PiProcess.stop 的退出确认契约（不启动真实 pi，直接驱动终止协议）。
 *
 * 裸 kill 只表示「信号已发出」：child 若忽略 SIGTERM，exit 永不到达，上层就会在
 * 「已不可达却仍报 running」的状态下继续持有会话文件与模型连接，并让 stopAll 够不到它。
 */

class FakeChild extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly killSignals: Array<NodeJS.Signals | undefined> = [];
	/** true = 听话的 child：kill 后异步报退出。 */
	exitOnKill = false;

	kill(signal?: NodeJS.Signals): boolean {
		this.killSignals.push(signal);
		if (this.exitOnKill) queueMicrotask(() => this.emit("exit", { code: 0, signal: null }));
		return true;
	}
}

/** 强杀分支由测试接管：真实分支会执行 taskkill/SIGKILL，不能在测试里对假 pid 开火。 */
class TestPiProcess extends PiProcess {
	treeKills = 0;

	protected override killProcessTree(): void {
		this.treeKills += 1;
	}
}

/**
 * 把假 child 直接装进私有字段：生产路径由 start() 装配 proc/rpc，
 * 这里等价于「已启动」状态，只为驱动 stop() 的终止协议。
 */
function installFakeChild(process: PiProcess, child: FakeChild): void {
	const internals = process as unknown as { proc: FakeChild; rpc: { close(error?: Error): void } };
	internals.proc = child;
	internals.rpc = { close: () => undefined };
}

test("child 忽略信号时，stop 在宽限期后升级强杀并最终收口为 isRunning()===false", async () => {
	const process = new TestPiProcess("C:/work", undefined, undefined, {
		stopGraceMs: 10,
		stopKillConfirmMs: 10,
	});
	const child = new FakeChild();
	installFakeChild(process, child);
	assert.equal(process.isRunning(), true);

	await process.stop();

	assert.equal(child.killSignals.length, 1, "应先发温和终止信号");
	assert.equal(process.treeKills, 1, "宽限期内未退出应升级强杀");
	assert.equal(process.isRunning(), false, "exit 始终未到也不能报 running");
});

test("child 在宽限期内退出时，stop 不再强杀并立即确认", async () => {
	const process = new TestPiProcess("C:/work", undefined, undefined, { stopGraceMs: 1_000 });
	const child = new FakeChild();
	child.exitOnKill = true;
	installFakeChild(process, child);

	await process.stop();

	assert.equal(process.treeKills, 0, "已确认退出就不该再强杀");
	assert.equal(process.isRunning(), false);
});
