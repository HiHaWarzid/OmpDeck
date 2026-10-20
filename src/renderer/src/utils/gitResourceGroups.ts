import type { GitResourceGroups } from "../../../shared/types";

/**
 * 变更列表的结构等价判断：四组资源逐项比较路径/状态/字母/旧路径。
 *
 * 主进程每次 `git.status` 都会新建对象，引用比较必然不等；而 Git 面板的静默轮询
 * 每 5 秒一次，大仓库（实测 3000+ 变更）每次重渲染整棵资源树要 200ms 以上。
 * 因此轮询落地前用内容比较复用旧引用：内容未变 → 引用不变 → 整棵列表跳过渲染。
 *
 * 必须比较用户可见的全部字段：漏掉任一字段都会让界面吞掉真实的状态更新
 * （例如文件从工作区移到暂存区、重命名的 oldPath 变化）。
 */
export function sameResourceGroups(
	a: GitResourceGroups,
	b: GitResourceGroups,
): boolean {
	if (a === b) return true;
	for (const key of ["merge", "index", "workingTree", "untracked"] as const) {
		const left = a[key];
		const right = b[key];
		if (left === right) continue;
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i += 1) {
			const x = left[i];
			const y = right[i];
			if (
				x.path !== y.path ||
				x.status !== y.status ||
				x.letter !== y.letter ||
				x.oldPath !== y.oldPath
			) {
				return false;
			}
		}
	}
	return true;
}
