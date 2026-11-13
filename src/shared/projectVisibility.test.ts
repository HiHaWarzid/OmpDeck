import { describe, expect, it } from "vitest";
import type { Project } from "./types";
import {
	diffVanishedProjects,
	filterProjectsForEnvironment,
	isProjectVisibleInEnvironment,
	projectEnvironmentOf,
	resolveProjectEnvironment,
} from "./projectVisibility";

/**
 * 这组断言保护的是「项目不见了 = 删除 还是 环境过滤」这条判断。
 * 判错的代价不对称：误判成删除会真切掉面板钉选、展开目录和会话缓存，
 * 而 WSL/Windows 切换每次都会制造一批「看起来消失」的项目。
 */

type ProjectShape = Pick<Project, "id" | "kind" | "environment">;

const chat: ProjectShape = { id: "chat", kind: "chat" };
const win: ProjectShape = { id: "win", environment: "windows" };
const wsl: ProjectShape = { id: "wsl", environment: "wsl" };
/** 旧数据没有 environment 字段（兼容口径：视为 windows）。 */
const legacy: ProjectShape = { id: "legacy" };

describe("projectVisibility", () => {
	it("旧数据缺省按 windows 处理，chat 跨环境可见", () => {
		expect(resolveProjectEnvironment(legacy)).toBe("windows");
		expect(isProjectVisibleInEnvironment(legacy, "windows")).toBe(true);
		expect(isProjectVisibleInEnvironment(legacy, "wsl")).toBe(false);
		expect(isProjectVisibleInEnvironment(chat, "windows")).toBe(true);
		expect(isProjectVisibleInEnvironment(chat, "wsl")).toBe(true);
	});

	it("settings.wslEnabled 直接决定当前环境", () => {
		expect(projectEnvironmentOf(false)).toBe("windows");
		expect(projectEnvironmentOf(true)).toBe("wsl");
	});

	it("另一环境的项目缺席不算消失", () => {
		// 从 windows 切到 wsl：windows 项目全部缺席，但它们没被删除。
		expect(diffVanishedProjects([win, chat], [chat, wsl], "wsl")).toEqual([]);
		// 切回 windows 同理。
		expect(diffVanishedProjects([wsl, chat], [chat, win], "windows")).toEqual([]);
	});

	it("同环境项目中缺席的才算消失", () => {
		expect(diffVanishedProjects([win, chat], [chat], "windows")).toEqual(["win"]);
		expect(diffVanishedProjects([wsl], [], "wsl")).toEqual(["wsl"]);
	});

	it("跨 await 期间用户切换环境也不会误删另一批项目", () => {
		// next 已是另一环境的列表（调用方在删除中途切换了环境）：
		// 按各项目自身 environment 裁决，只有当前环境下才可能被判定为消失。
		expect(diffVanishedProjects([wsl, win], [chat], "wsl")).toEqual(["wsl"]);
		expect(diffVanishedProjects([wsl, win], [chat], "windows")).toEqual(["win"]);
	});

	it("next 全部存活时返回空集（无删除路径不触发清理）", () => {
		expect(diffVanishedProjects([win, wsl, chat], [chat, win, wsl], "windows")).toEqual([]);
	});
});

/**
 * 主进程下发列表与渲染层差集必须用同一个谓词。这两组断言把「同一谓词」
 * 变成可执行契约：过滤结果里出现的每个项目，必然不会被差集判成消失。
 */
describe("filterProjectsForEnvironment", () => {
	const all: ProjectShape[] = [chat, win, wsl, legacy];

	it("linux/windows 环境下只留本环境项目与 chat", () => {
		expect(filterProjectsForEnvironment(all, "windows").map((p) => p.id)).toEqual([
			"chat",
			"win",
			"legacy",
		]);
		expect(filterProjectsForEnvironment(all, "wsl").map((p) => p.id)).toEqual([
			"chat",
			"wsl",
		]);
	});

	it("过滤结果与逐条 isProjectVisibleInEnvironment 完全一致", () => {
		for (const environment of ["windows", "wsl"] as const) {
			expect(filterProjectsForEnvironment(all, environment)).toEqual(
				all.filter((p) => isProjectVisibleInEnvironment(p, environment)),
			);
		}
	});

	it("过滤后的列表再与原列表求差集，结果必为空（环境过滤不算删除）", () => {
		// 这正是主进程下发列表 → 渲染层 syncVanishedProjects 的真实顺序：
		// 换了环境后 prev 里另一环境的项目不该被清理。
		for (const environment of ["windows", "wsl"] as const) {
			const visible = filterProjectsForEnvironment(all, environment);
			expect(diffVanishedProjects(all, visible, environment)).toEqual([]);
		}
	});
});
