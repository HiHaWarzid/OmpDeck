import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { CommandError, createCommandRunner } from "./CommandRunner";
import type { ExecutorOptions } from "./CommandRunner";

type Behavior =
	| { type: "ok"; stdout: string }
	| { type: "error"; error: Error }
	| { type: "hang" };

/**
 * 可注入的 fake executor：按脚本回放行为，并复刻 node execFile 的关键语义——
 * options.timeout 到达后 kill 子进程（reject 一个 killed=true / code=null 的错误）。
 * 测试用 vi fake timers 驱动 timeout，避免真实墙钟等待。
 */
function createFakeExecutor(script: Behavior[]) {
	const calls: Array<{ bin: string; args: string[]; options: ExecutorOptions }> = [];
	let index = 0;
	const exec = (bin: string, args: string[], options: ExecutorOptions) =>
		new Promise<{ stdout: string }>((resolve, reject) => {
			calls.push({ bin, args, options });
			const behavior = script[index] ?? { type: "ok", stdout: "" };
			index += 1;

			let timer: ReturnType<typeof setTimeout> | undefined;
			if (options.timeout) {
				timer = setTimeout(() => {
					const err = new Error(`Command failed: ${bin} ${args.join(" ")}`) as Error & {
						killed: boolean;
						signal: string;
						code: null;
					};
					err.killed = true;
					err.signal = "SIGTERM";
					err.code = null;
					reject(err);
				}, options.timeout);
			}

			if (behavior.type === "ok") {
				if (timer) clearTimeout(timer);
				resolve({ stdout: behavior.stdout });
			} else if (behavior.type === "error") {
				if (timer) clearTimeout(timer);
				reject(behavior.error);
			}
			// "hang"：什么都不做，只等 options.timeout 触发 kill 型 reject。
		});
	return { exec, calls };
}

/** 只等 timeout 触发的行为（配合 fake timers 确定性驱动） */
const hang: Behavior = { type: "hang" };

/** 捕获拒绝值用于断言（5+ 调用点共享同一 try/catch 形状） */
async function capture<T>(promise: Promise<T>): Promise<unknown> {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

afterEach(() => {
	vi.useRealTimers();
});

test("成功：stdout 原样返回，cwd/env 透传给执行器", async () => {
	const { exec, calls } = createFakeExecutor([{ type: "ok", stdout: "main\n" }]);
	const runner = createCommandRunner({ exec });
	const result = await runner.runCommand("git", ["branch", "--show-current"], {
		cwd: "D:/repo",
		env: { PATH: "/custom" },
	});
	assert.equal(result.stdout, "main\n");
	assert.equal(calls[0].bin, "git");
	assert.deepEqual(calls[0].args, ["branch", "--show-current"]);
	assert.equal(calls[0].options.cwd, "D:/repo");
	assert.deepEqual(calls[0].options.env, { PATH: "/custom" });
});

test("失败：stderr 并入错误消息，退出码透传，kind=command", async () => {
	const exitError = Object.assign(new Error("Command failed: git checkout"), {
		stderr: "error: pathspec 'x' did not match any file(s)",
		code: 1,
	});
	const { exec } = createFakeExecutor([{ type: "error", error: exitError }]);
	const runner = createCommandRunner({ exec });
	const error = await capture(runner.runCommand("git", ["checkout", "x"]));
	assert.ok(error instanceof CommandError);
	assert.equal(error.kind, "command");
	assert.equal(error.code, 1);
	assert.match(error.message, /did not match any file/);
});

test("超时：执行器 kill 型错误归一为 kind=timeout，且超时已下放给执行器", async () => {
	vi.useFakeTimers();
	const { exec, calls } = createFakeExecutor([hang]);
	const runner = createCommandRunner({ exec });
	const pending = capture(runner.runCommand("git", ["push"], { timeoutMs: 30 }));
	await vi.advanceTimersByTimeAsync(30);
	const error = await pending;
	assert.ok(error instanceof CommandError);
	assert.equal(error.kind, "timeout");
	assert.equal(error.code, undefined);
	assert.match(error.message, /timed out after 30ms/);
	// 超时以 timeout 选项下放给执行器（默认 executor 由 node 负责 kill 语义）
	assert.equal(calls[0].options.timeout, 30);
});

test("外部 kill 的标志（killed=true）同样归一为 kind=timeout", async () => {
	const killedError = Object.assign(new Error("Command failed: git fetch"), {
		killed: true,
		signal: "SIGTERM",
		code: null,
	});
	const { exec } = createFakeExecutor([{ type: "error", error: killedError }]);
	const runner = createCommandRunner({ exec });
	const error = await capture(runner.runCommand("git", ["fetch"], { timeoutMs: 30_000 }));
	assert.ok(error instanceof CommandError);
	assert.equal(error.kind, "timeout");
});

test("allowFailure：失败返回空 stdout 而非抛错", async () => {
	const { exec } = createFakeExecutor([
		{ type: "error", error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) },
	]);
	const runner = createCommandRunner({ exec });
	const result = await runner.runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
		allowFailure: true,
	});
	assert.deepEqual(result, { stdout: "" });
});

test("ENOENT：归类 not-found 并附带 PATH/安装指引", async () => {
	const { exec } = createFakeExecutor([
		{ type: "error", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) },
	]);
	const runner = createCommandRunner({ exec });
	const error = await capture(runner.runGh("D:/repo", ["issue", "list"]));
	assert.ok(error instanceof CommandError);
	assert.equal(error.kind, "not-found");
	assert.match(error.message, /请检查 PATH 或是否安装 gh/);
});

test("runGit 默认超时 30s、缓冲 32MB，返回 stdout 字符串", async () => {
	const { exec, calls } = createFakeExecutor([{ type: "ok", stdout: "main" }]);
	const runner = createCommandRunner({ exec });
	const stdout = await runner.runGit("D:/repo", ["branch", "--show-current"]);
	assert.equal(stdout, "main");
	assert.equal(calls[0].bin, "git");
	assert.equal(calls[0].options.cwd, "D:/repo");
	assert.equal(calls[0].options.timeout, 30_000);
	assert.equal(calls[0].options.maxBuffer, 32 * 1024 * 1024);
});

test("runGh 默认超时 30s、缓冲 16MB，可覆盖超时", async () => {
	const { exec, calls } = createFakeExecutor([{ type: "ok", stdout: "[]" }]);
	const runner = createCommandRunner({ exec });
	await runner.runGh("D:/repo", ["issue", "list"], { timeoutMs: 120_000 });
	assert.equal(calls[0].bin, "gh");
	assert.equal(calls[0].options.timeout, 120_000);
	assert.equal(calls[0].options.maxBuffer, 16 * 1024 * 1024);
});

test("allowFailure 优先级最高：即使 ENOENT 也不抛错", async () => {
	const { exec } = createFakeExecutor([
		{ type: "error", error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) },
	]);
	const runner = createCommandRunner({ exec });
	const result = await runner.runGit("D:/repo", ["rev-parse", "--is-inside-work-tree"], {
		allowFailure: true,
	});
	assert.equal(result, "");
});