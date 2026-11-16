/**
 * 文件树展平：把项目扫描得到的树投影成「文件 + 目录」的扁平列表。
 *
 * 目录节点一并保留（而不是只留文件）：@ 引用允许引用目录，chip 白名单也按
 * relativePath 校验，两处消费方都要求空目录同样出现。
 */
import type { FileTreeNode } from "../../../shared/types";

export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) =>
		node.type === "file"
			? [node]
			: [node, ...flattenFiles(node.children ?? [])],
	);
}
