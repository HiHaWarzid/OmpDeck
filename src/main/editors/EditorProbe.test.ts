import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWindowsRegistryLookup,
	probe,
	type EditorCandidate,
	type EditorProbePorts,
	type SpawnProbeChild,
} from "./EditorProbe";

/** 卡死的探测子进程：永不 close，只记录 kill，用于断言超时/预算耗尽路径不遗留僵尸。 */
function createHangingSpawn(kills: number[]): SpawnProbeChild {
	return () => ({
		stdout: null,
		onError: () => {},
		onClose: () => {},
		kill: () => {
			kills.push(Date.now());
			return true;
		},
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("probe 有界探测批", () => {
	it("预算耗尽时 kill 卡死的探测子进程，并返回已探测到的部分结果", async () => {
		const kills: number[] = [];
		const candidates: EditorCandidate[] = [
			{ id: "vscode", name: "Visual Studio Code", commands: ["code"], commonPaths: [] },
			{
				id: "cursor",
				name: "Cursor",
				commands: [],
				commonPaths: [],
				windowsRegistryNames: ["cursor"],
				windowsExecutableNames: ["Cursor.exe"],
			},
			{
				id: "zed",
				name: "Zed",
				commands: [],
				commonPaths: [],
				windowsRegistryNames: ["zed"],
				windowsExecutableNames: ["Zed.exe"],
			},
		];
		const ports: EditorProbePorts = {
			exists: async () => false,
			findOnPath: async (command) => (command === "code" ? "/usr/bin/code" : null),
			lookupRegistryInstall: createWindowsRegistryLookup({
				spawnChild: createHangingSpawn(kills),
				exists: async () => false,
				platform: "win32",
			}),
		};

		const started = Date.now();
		const editors = await probe(candidates, 120, ports);
		const elapsed = Date.now() - started;

		expect(editors.map((editor) => editor.id)).toEqual(["vscode"]);
		expect(editors[0].detectedFrom).toBe("path");
		// 卡死的注册表查询必须被 kill，且 probe 仍在预算内返回
		expect(kills).toHaveLength(1);
		expect(elapsed).toBeLessThan(1_000);
	});

	it("超时的 reg query 不让整批挂起：kill 后继续探测后续候选", async () => {
		vi.useFakeTimers();
		const kills: number[] = [];
		const candidates: EditorCandidate[] = [
			{ id: "vscode", name: "Visual Studio Code", commands: ["code"], commonPaths: [] },
			{
				id: "cursor",
				name: "Cursor",
				commands: [],
				commonPaths: [],
				windowsRegistryNames: ["cursor"],
				windowsExecutableNames: ["Cursor.exe"],
			},
			{
				id: "zed",
				name: "Zed",
				commands: [],
				commonPaths: [],
				windowsRegistryNames: ["zed"],
				windowsExecutableNames: ["Zed.exe"],
			},
			{ id: "idea", name: "IntelliJ IDEA", commands: [], commonPaths: ["C:/JetBrains/idea64.exe"] },
		];
		const commonPathHit = async (path: string) => path === "C:/JetBrains/idea64.exe";
		const ports: EditorProbePorts = {
			exists: commonPathHit,
			findOnPath: async (command) => (command === "code" ? "/usr/bin/code" : null),
			lookupRegistryInstall: createWindowsRegistryLookup({
				spawnChild: createHangingSpawn(kills),
				exists: commonPathHit,
				platform: "win32",
			}),
		};

		const pending = probe(candidates, 10_000, ports);
		await vi.advanceTimersByTimeAsync(10_000);
		const editors = await pending;

		// 两个注册表候选各超时一次被 kill，但 idea 仍在剩余预算内被探测到
		expect(kills).toHaveLength(2);
		expect(editors.map((editor) => editor.id)).toEqual(["vscode", "idea"]);
		expect(editors.map((editor) => editor.detectedFrom)).toEqual(["path", "common-path"]);
	});

	it("正常路径：结果顺序与 PATH > 常见目录 > 注册表的优先级保持不变", async () => {
		const registryCalls: string[] = [];
		const candidates: EditorCandidate[] = [
			{
				id: "vscode",
				name: "Visual Studio Code",
				commands: ["code"],
				commonPaths: ["C:/VSCode/Code.exe"],
				windowsRegistryNames: ["visual studio code"],
				windowsExecutableNames: ["Code.exe"],
			},
			{
				id: "cursor",
				name: "Cursor",
				commands: ["cursor"],
				commonPaths: ["C:/Cursor/Cursor.exe"],
				windowsRegistryNames: ["cursor"],
				windowsExecutableNames: ["Cursor.exe"],
			},
			{
				id: "zed",
				name: "Zed",
				commands: [],
				commonPaths: [],
				windowsRegistryNames: ["zed"],
				windowsExecutableNames: ["Zed.exe"],
			},
			{
				id: "phpstorm",
				name: "PhpStorm",
				commands: ["phpstorm"],
				commonPaths: [],
				windowsRegistryNames: ["phpstorm"],
				windowsExecutableNames: ["phpstorm64.exe"],
			},
		];
		const ports: EditorProbePorts = {
			findOnPath: async (command) => (command === "code" ? "/usr/bin/code" : null),
			exists: async (path) => path === "C:/Cursor/Cursor.exe",
			lookupRegistryInstall: async (candidate) => {
				registryCalls.push(candidate.id);
				return candidate.id === "zed" ? "C:/Zed/Zed.exe" : null;
			},
		};

		const editors = await probe(candidates, 5_000, ports);

		expect(editors).toEqual([
			{ id: "vscode", name: "Visual Studio Code", command: "/usr/bin/code", args: undefined, detectedFrom: "path" },
			{ id: "cursor", name: "Cursor", command: "C:/Cursor/Cursor.exe", args: undefined, detectedFrom: "common-path" },
			{ id: "zed", name: "Zed", command: "C:/Zed/Zed.exe", args: undefined, detectedFrom: "common-path" },
		]);
		// vscode/cursor 已在前两级命中不查注册表；phpstorm 三级皆未命中被丢弃
		expect(registryCalls).toEqual(["zed", "phpstorm"]);
	});
});
