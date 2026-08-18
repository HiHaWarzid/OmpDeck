/**
 * 统一的 projectId → Project 解析守卫。
 * 所有按 projectId 定位项目的 IPC handler 均经此解析，消除各模块重复的
 * `projectStore.get(projectId); if (!project) …` 样板（错误消息保持历史一致）。
 * - resolveProject：项目缺失时抛出 `Project not found: <id>`。
 * - withProject：项目缺失时返回调用方给定的 fallback（不抛错，供返回空值语义的成员），
 *   未给 fallback 时抛出与 resolveProject 相同的错误。
 * - projectNotFoundError：构造与守卫一致的错误对象，供 mutation 结果校验等场景复用。
 */
import type { Project } from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";

export interface ProjectGuard {
	resolveProject(projectId: string): Project;
	withProject<T>(projectId: string, fn: (project: Project) => T): T;
	withProject<T, F>(projectId: string, fn: (project: Project) => T, fallback: F): T | F;
}

/** 构造与所有守卫一致的错误对象（错误消息的唯一出处）。 */
export function projectNotFoundError(projectId: string): Error {
	return new Error(`Project not found: ${projectId}`);
}

export function createProjectGuard(projectStore: ProjectStore): ProjectGuard {
	const resolveProject = (projectId: string): Project => {
		const project = projectStore.get(projectId);
		if (!project) throw projectNotFoundError(projectId);
		return project;
	};
	const withProject = <T, F = never>(
		projectId: string,
		fn: (project: Project) => T,
		...fallback: [F] | []
	): T | F => {
		const project = projectStore.get(projectId);
		if (!project) {
			if (fallback.length > 0) return fallback[0] as F;
			throw projectNotFoundError(projectId);
		}
		return fn(project);
	};
	return { resolveProject, withProject };
}