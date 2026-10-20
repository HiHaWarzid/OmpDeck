import type { GitResource } from "../../../shared/types";

/**
 * Git 变更列表的目录树视图（纯函数，便于单测）。
 *
 * 为什么需要分页：变更列表按目录一次性渲染全部资源行。实测大仓库（3389 个变更、
 * 42k DOM 节点）下，一次按键的 React 提交 + 布局要 1.1~1.3 秒，用户侧表现为输入卡顿。
 * 目录数量本身不是上界（实测 3389 条分散在 744 个目录），所以只按目录截断没有意义，
 * 必须对整个树做总量上限：先渲染前 N 行，其余通过「加载更多」追加。
 */

/** 首次渲染的行数；一次「加载更多」追加的行数。 */
export const FILE_TREE_PAGE_SIZE = 200;

export interface FileTreeSection {
	dir: string;
	/** 本页实际渲染的资源（折叠目录为空） */
	resources: GitResource[];
	/** 该目录的资源总数，用于目录头计数徽标 */
	total: number;
}

export interface FileTreeView {
	sections: FileTreeSection[];
	/** 未渲染的资源行数（折叠目录内的行不计入：那是用户主动隐藏的） */
	hidden: number;
	/** 只有一个根目录时不显示目录头 */
	singleRoot: boolean;
}

/** 按目录分组 Git 资源，返回 { dir -> resources[] } 映射（保留原始顺序）。 */
export function groupGitResourcesByDir(
	resources: GitResource[],
	/** 项目根目录，传入后目录名显示为相对路径而非绝对路径 */
	rootPath?: string,
): Map<string, GitResource[]> {
	const dirs = new Map<string, GitResource[]>();
	for (const resource of resources) {
		// 将绝对路径转为相对路径，使目录分组显示简洁的相对路径而非长绝对路径
		let path = resource.path;
		if (rootPath) {
			const normalizedRoot = rootPath.replace(/[\\]+/g, "/").replace(/\/+$/, "");
			const normalizedPath = path.replace(/[\\]+/g, "/");
			if (normalizedPath.startsWith(normalizedRoot + "/")) {
				path = normalizedPath.slice(normalizedRoot.length + 1);
			} else if (normalizedPath === normalizedRoot) {
				path = "";
			}
		}
		const parts = path.split(/[/\\]/);
		const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
		const bucket = dirs.get(dir);
		if (bucket) bucket.push(resource);
		else dirs.set(dir, [resource]);
	}
	return dirs;
}

/** 目录名排序：根目录排最前，其余按本地化字典序。 */
export function sortGitDirs(dirs: string[]): string[] {
	return [...dirs].sort((a, b) => {
		if (a === "") return -1;
		if (b === "") return 1;
		return a.localeCompare(b);
	});
}

/**
 * 构造本页要渲染的目录树。
 *
 * 预算按目录顺序消耗，因此输出顺序与完整渲染一致（根目录在前），
 * 用户看到的始终是列表开头而不是随机抽样。折叠目录只输出目录头、
 * 不消耗预算，展开后仍受同一个预算约束。
 */
export function buildFileTreeView(
	resources: GitResource[],
	projectRoot: string | undefined,
	collapsedDirs: ReadonlySet<string>,
	limit: number,
): FileTreeView {
	const byDir = groupGitResourcesByDir(resources, projectRoot);
	const dirs = sortGitDirs([...byDir.keys()]);
	const singleRoot = dirs.length === 1 && dirs[0] === "";
	let budget = Math.max(0, Math.floor(limit));
	let hidden = 0;
	const sections: FileTreeSection[] = [];

	for (const dir of dirs) {
		const all = byDir.get(dir)!;
		if (collapsedDirs.has(dir) && !singleRoot) {
			sections.push({ dir, resources: [], total: all.length });
			continue;
		}
		if (budget <= 0) {
			hidden += all.length;
			continue;
		}
		const take = Math.min(budget, all.length);
		sections.push({ dir, resources: all.slice(0, take), total: all.length });
		budget -= take;
		hidden += all.length - take;
	}

	return { sections, hidden, singleRoot };
}
