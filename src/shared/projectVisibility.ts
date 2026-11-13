/**
 * 项目可见性契约（主进程与渲染进程共用）：
 *
 * 主进程只把「当前环境 + Chat」的项目下发给渲染进程，渲染进程因此看到的是一个**过滤后**的
 * 列表。这个事实决定了所有「某项目不见了」的判断：不见 = 删除 **或** 环境过滤。
 * 两侧必须用同一个谓词，否则渲染层的差集清理会把另一环境的项目当成已删除，
 * 连带删掉它们的面板钉选、展开目录与会话缓存（且项目切回来时再也回不到原位）。
 */

import type { Project } from "./types";

export type ProjectEnvironment = "windows" | "wsl";

/** 项目所属环境；旧数据缺省按 windows 处理（与主进程 store 的兼容规则一致）。 */
export function resolveProjectEnvironment(
	project: Pick<Project, "environment">,
): ProjectEnvironment {
	return project.environment === "wsl" ? "wsl" : "windows";
}

/** 当前设置对应的项目环境。 */
export function projectEnvironmentOf(wslEnabled: boolean): ProjectEnvironment {
	return wslEnabled ? "wsl" : "windows";
}

/**
 * 该项目在当前环境下是否可见。Chat 项目跨环境始终可见：
 * 它不属于任何一个文件系统环境，藏起来只会让用户以为聊天记录丢了。
 */
export function isProjectVisibleInEnvironment(
	project: Pick<Project, "kind" | "environment">,
	environment: ProjectEnvironment,
): boolean {
	if (project.kind === "chat") return true;
	return resolveProjectEnvironment(project) === environment;
}

/**
 * 按当前环境过滤项目列表。主进程下发列表与渲染层差集必须用同一谓词，
 * 否则「另一环境的项目」会被当成「已删除」。
 */
export function filterProjectsForEnvironment<T extends Pick<Project, "kind" | "environment">>(
	projects: readonly T[],
	environment: ProjectEnvironment,
): T[] {
	return projects.filter((project) => isProjectVisibleInEnvironment(project, environment));
}

/**
 * 可见列表的差集：`prev` 里真正**消失**的项目 id。
 *
 * 只有「原本在当前环境可见」的项目缺席才算删除；被环境过滤掉的项目不算。
 * 这比「比较删除前后 settings.wslEnabled 是否变化」更稳：它按项目自身的 environment
 * 逐条裁决，跨 await 期间用户切换环境也不会把另一批项目误判成已删除。
 */
export function diffVanishedProjects(
	prev: readonly Pick<Project, "id" | "kind" | "environment">[],
	next: readonly Pick<Project, "id">[],
	environment: ProjectEnvironment,
): string[] {
	const alive = new Set(next.map((project) => project.id));
	return prev
		.filter(
			(project) =>
				!alive.has(project.id) && isProjectVisibleInEnvironment(project, environment),
		)
		.map((project) => project.id);
}
