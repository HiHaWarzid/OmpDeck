/**
 * 搜索关键词匹配：空关键词视为「全匹配」，其余按大小写无关的子串匹配。
 *
 * 侧栏会话/项目/Agent 过滤与 App 的折叠态过滤共用同一条谓词，避免各写一份
 * 「空串要不要放行」的隐式约定——空关键词放行是搜素框语义，不是可选优化。
 */
export function matches(value: string, keyword: string) {
	return (
		!keyword.trim() ||
		value.toLowerCase().includes(keyword.trim().toLowerCase())
	);
}
