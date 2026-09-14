import { afterEach, describe, expect, it, vi } from "vitest";

// EditorDetector 在模块顶层引入 electron 的 shell；vitest 的 node 环境没有 electron 运行时。
vi.mock("electron", () => ({
	shell: { openPath: async () => "" },
}));

import type { ExternalEditor } from "../../shared/types";
import { openProjectInEditor, type EditorLaunchDeps, type EditorLaunchPort } from "./EditorDetector";

type LaunchBehavior = "spawn" | "error" | "silent";

/** 假启动端口：按行为回放 spawn/error；silent 模拟进程创建永不回调（挂起）。 */
function createFakeLauncher(behavior: LaunchBehavior) {
	let kills = 0;
	const launch: EditorLaunchPort = (_command, _args, callbacks) => {
		if (behavior === "spawn") queueMicrotask(() => callbacks.onSpawn(4242));
		if (behavior === "error") queueMicrotask(() => callbacks.onError(new Error("spawn ENOENT")));
		return {
			kill: () => {
				kills += 1;
				return true;
			},
		};
	};
	return { launch, kills: () => kills };
}

const editor: ExternalEditor = {
	id: "vscode",
	name: "Visual Studio Code",
	command: "Code.exe",
	detectedFrom: "manual",
};

function launchDeps(
	launch: EditorLaunchPort,
	timeoutMs: number,
	openPath: (path: string) => Promise<string> = async () => "",
): EditorLaunchDeps {
	return { launch, resolveCommand: async () => null, openPath, timeoutMs };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("openProjectInEditor 启动收敛", () => {
	it("进程创建迟迟不回调时：kill 启动句柄并以明确错误拒绝，不挂起", async () => {
		const fake = createFakeLauncher("silent");
		const started = Date.now();

		await expect(openProjectInEditor(editor, "D:/project", launchDeps(fake.launch, 25))).rejects.toThrow(
			/Editor launch timed out after 25ms: vscode/,
		);

		expect(fake.kills()).toBe(1);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("正常路径：spawn 到达即 resolve，且超时计时器已清理（不会误杀）", async () => {
		vi.useFakeTimers();
		const fake = createFakeLauncher("spawn");

		const pending = openProjectInEditor(editor, "D:/project", launchDeps(fake.launch, 50));
		await vi.advanceTimersByTimeAsync(0);
		await expect(pending).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(fake.kills()).toBe(0);
	});

	it("spawn 失败但系统打开回退成功时 resolve（保留原回退语义）", async () => {
		const fake = createFakeLauncher("error");

		await expect(openProjectInEditor(editor, "D:/project", launchDeps(fake.launch, 50))).resolves.toBeUndefined();
		expect(fake.kills()).toBe(0);
	});

	it("spawn 失败且系统打开回退也失败时：以原始启动错误拒绝", async () => {
		const fake = createFakeLauncher("error");

		await expect(
			openProjectInEditor(editor, "D:/project", launchDeps(fake.launch, 50, async () => "Access is denied")),
		).rejects.toThrow("spawn ENOENT");
	});
});
