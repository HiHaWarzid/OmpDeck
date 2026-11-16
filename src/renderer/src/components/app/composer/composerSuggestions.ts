/**
 * 输入框建议投影：`/` 命令、`@` 文件引用、`&` 会话引用的触发识别、候选构造与插入文本。
 *
 * 触发规则与候选构造必须住在同一模块：`detectTrigger` 判定的「正在输入哪类引用」
 * 直接决定 `buildSuggestionItems` 返回什么形状的条目，两者分开就会重新长出第二套路径规则
 * （历史上的 `/fast on` 子命令、`@src/ 说明` 钉住浮层都出自这类漂移）。
 *
 * 纯函数：命令目录来自 omp runtime，文件树来自项目扫描，模块本身不碰 IPC 与 React。
 */
import type { FileTreeNode, PiCommand } from "../../../../../shared/types";
import { formatFilePathRef } from "../RichInput";

export type ComposerSuggestionResult = {
	text: string;
	cursor: number;
};

export type ComposerTrigger = {
	start: number;
	char: string;
	query: string;
};

export function detectTrigger(
	text: string,
	cursor: number,
): ComposerTrigger | null {
	if (cursor < 0 || cursor > text.length) cursor = text.length;
	const before = text.slice(0, cursor);
	const atIdx = before.lastIndexOf("@");
	const slashIdx = before.lastIndexOf("/");
	const ampIdx = before.lastIndexOf("&");
	const start = Math.max(atIdx, slashIdx, ampIdx);
	if (start < 0) return null;
	const char = before[start];
	const segment = before.slice(start + 1);
	if (char === "&") {
		if (/[\n]/.test(segment)) return null;
		const prev = start > 0 ? before[start - 1] : "";
		// 只阻止 URL 查询参数场景（?foo=bar&），不拦 &&、&chip& 等正常场景
		if (prev === "=" || prev === "?") return null;
		return { start, char, query: segment };
	}
	if (char === "/") {
		// 检查 / 是否属于 @file 路径（@ 在前且路径段内无空白），是则当作 @ 触发而非命令。
		// 关键：路径完成后光标后有空格/后续文本时（@src/ 说明…），必须关闭，
		// 否则路径中的每个 / 都会把建议框永久钉住。
		const beforeSlash = before.slice(0, start);
		const atBefore = beforeSlash.lastIndexOf("@");
		if (atBefore >= 0 && !/\s/.test(beforeSlash.slice(atBefore))) {
			const fileSegment = before.slice(atBefore + 1);
			if (/\s/.test(fileSegment)) return null;
			return { start: atBefore, char: "@", query: fileSegment };
		}
		// 子命令输入：`/fast on` 保留触发，让带 subcommands 的命令能继续提示第二段。
		// 只放行「命令名 + 恰好一个子命令 token」，且 / 必须位于词首（行首或空白之后），
		// 否则正文里的 "and/or something" 会被误判成命令；再出现空白即关闭，避免面板钉死。
		const subMatch = /^([\w.:-]+) ([\w.:-]*)$/.exec(segment);
		const charBeforeSlash = start > 0 ? before[start - 1] : "";
		if (subMatch && (!charBeforeSlash || /\s/.test(charBeforeSlash))) return { start, char, query: segment };
	}
	if (/[\s@/&]/.test(segment)) return null;
	const prevChar = start > 0 ? before[start - 1] : "";
	if (prevChar) {
		if (/[:/]/.test(prevChar)) return null;
	}
	return { start, char, query: segment };
}

export function applySuggestion(
	current: string,
	cursor: number,
	value: string,
): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor);
	if (!trigger) {
		const text = `${current}${value} `;
		return { text, cursor: text.length };
	}
	const text = `${current.slice(0, trigger.start)}${value} ${current.slice(cursor)}`;
	return { text, cursor: trigger.start + value.length + 1 };
}

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
	/** 命令参数提示（omp input.hint），渲染在命令名右侧，如 `[on|off|status]` */
	hint?: string;
	/** 不可选中的分组头；目录本身可选，不再使用 disabled 表示目录 */
	disabled?: boolean;
	/** 树形缩进层级（0=根目录），仅在 @ 无关键词时使用 */
	treeDepth?: number;
	/** 目录引用：UI 显示文件夹图标，插入路径与文件相同 */
	isDirectory?: boolean;
	sessionMeta?: { sessionId: string; filePath: string; projectPath?: string };
};

/* ── 命令管理 ── */

/**
 * 桌面有专用 UI 承载、无需在斜线命令建议中暴露的内置命令。
 * `model`：桌面有模型选择器（model picker），重复暴露会造成两个入口不一致。
 */
const HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES: Record<string, true> = { model: true };

/**
 * 命令目录的唯一事实源是 omp runtime（启动推送 + `agents.commands` 拉取）。
 *
 * 1. 隐藏「桌面已有等价入口」的内置命令（`model` 有专用模型选择器）；
 * 2. 再按名字去重，保留先出现的可见项。顺序很关键：必须先隐藏再去重，
 *    否则 builtin `model` 先占位后，扩展同名命令会被当作重复项丢掉，
 *    用户可执行的命令从建议里消失。旧实现还维护过一份手写内置命令清单，
 *    它曾与 runtime 漂移，凭空多出 /copy、/hotkeys、/settings、/vision。
 */
export function filterVisibleCommands(commands: PiCommand[]) {
	const seen = new Set<string>();
	const visible: PiCommand[] = [];
	for (const command of commands) {
		const key = command.name.toLowerCase();
		const isBuiltin = command.source == null || command.source === "builtin";
		if (isBuiltin && HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES[key]) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		visible.push(command);
	}
	return visible;
}

function fuzzyScore(value: string, keyword: string) {
	if (!keyword) return 1;
	const text = value.toLowerCase();
	const query = keyword.toLowerCase();
	if (text.includes(query)) return 100 + query.length;
	let score = 0;
	let pos = 0;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found === -1) return 0;
		score += found === pos ? 8 : 2;
		pos = found + 1;
	}
	return score;
}

/** 目录引用在建议列表与插入文本中都用尾斜杠标记，避免 @src 被模型当成智能体。 */
function formatPathSuggestionLabel(node: FileTreeNode): string {
	return node.type === "directory" ? `@${node.name}/` : `@${node.name}`;
}

function formatPathSuggestionValue(node: FileTreeNode): string {
	return formatFilePathRef(node.relativePath, {
		isDirectory: node.type === "directory",
	});
}

/**
 * 从扁平路径列表（文件 + 目录）重建一级树视图。
 * 目录与文件均可选，便于直接 @src 这类目录引用。
 */
function buildFileTreeItems(entries: FileTreeNode[]): SuggestionItem[] {
	interface PathNode {
		name: string;
		relativePath: string;
		children: Map<string, PathNode>;
		files: FileTreeNode[];
		dirNode?: FileTreeNode;
	}
	// 用 / 分隔符构建路径树；目录节点单独挂 dirNode，空目录也能出现。
	const root: PathNode = { name: "", relativePath: "", children: new Map(), files: [] };
	const ensureDir = (parent: PathNode, part: string): PathNode => {
		let child = parent.children.get(part);
		if (!child) {
			const relativePath = parent.relativePath ? `${parent.relativePath}/${part}` : part;
			child = { name: part, relativePath, children: new Map(), files: [] };
			parent.children.set(part, child);
		}
		return child;
	};
	for (const entry of entries) {
		const parts = entry.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
		if (parts.length === 0) continue;
		if (entry.type === "directory") {
			let node = root;
			for (const part of parts) node = ensureDir(node, part);
			node.dirNode = entry;
			continue;
		}
		let node = root;
		for (const part of parts.slice(0, -1)) node = ensureDir(node, part);
		node.files.push(entry);
	}
	// 仅展平第一层（根目录文件 + 一级目录），避免大项目卡顿
	const result: SuggestionItem[] = [];
	function flatten(node: PathNode, depth: number, maxDepth: number) {
		const sortedDirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
		const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
		for (const dir of sortedDirs) {
			const dirPath = dir.dirNode?.relativePath ?? dir.relativePath;
			result.push({
				key: dir.dirNode?.path ?? `dir:${dirPath}`,
				label: `@${dir.name}/`,
				description: dirPath,
				// 必须插入 @dir/：裸 @dir 无法过 chip 路径规则，也易被模型当成 mention
				value: formatFilePathRef(dirPath, { isDirectory: true }),
				treeDepth: depth,
				isDirectory: true,
			});
			if (depth < maxDepth) flatten(dir, depth + 1, maxDepth);
		}
		for (const file of sortedFiles) {
			result.push({
				key: file.path,
				label: formatPathSuggestionLabel(file),
				description: file.relativePath,
				value: formatPathSuggestionValue(file),
				treeDepth: depth,
				isDirectory: file.type === "directory",
			});
		}
	}
	flatten(root, 0, 0); // 只展开第一层
	return result;
}

export function buildSuggestionItems(
	prompt: string,
	cursor: number,
	commands: PiCommand[],
	files: FileTreeNode[],
	sessions?: { id: string; filePath: string; projectPath?: string; name?: string; preview: string; updatedAt: number }[],
): SuggestionItem[] {
	const allCommands = filterVisibleCommands(commands);
	const trigger = detectTrigger(prompt, cursor);
	if (!trigger) return [];
	const keyword = trigger.query.toLowerCase();
	if (trigger.char === "/") {
		// 已有子命令段：`/fast on`。只有命令自身声明了 subcommands 才展开，
		// 未声明的组合返回空——参数值不该被当成命令候选。
		const spaceAt = keyword.indexOf(" ");
		if (spaceAt > 0) {
			const commandName = keyword.slice(0, spaceAt);
			const subQuery = keyword.slice(spaceAt + 1);
			const command = allCommands.find((item) => item.name.toLowerCase() === commandName);
			if (!command) return [];
			return (command.subcommands ?? [])
				.filter((sub) => sub.name.toLowerCase().includes(subQuery))
				.map((sub) => ({
					// 用 runtime 的原始大小写生成插入文本，避免把 `/SkillName` 改写成小写
					key: `${command.name} ${sub.name}`,
					label: `/${command.name} ${sub.name}`,
					description: sub.description ?? "",
					value: `/${command.name} ${sub.name}`,
				}));
		}
		return allCommands
			.filter((command) => command.name.toLowerCase().includes(keyword))
			.map((command) => ({
				key: command.name,
				label: `/${command.name}`,
				hint: command.inputHint,
				description: command.description ?? "",
				value: `/${command.name}`,
			}));
	}
	if (trigger.char === "@") {
		if (!keyword) {
			// 无关键词：展示一级目录/文件；目录可直接选中引用
			return buildFileTreeItems(files);
		}
		// 有关键词：文件与目录一起模糊搜索；同名时目录略优先，方便找文件夹
		return files
			.map((file) => ({
				file,
				score:
					fuzzyScore(file.relativePath, keyword) +
					fuzzyScore(file.name, keyword) * 2 +
					(file.type === "directory" ? 4 : 0),
			}))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 15)
			.map((item) => ({
				key: item.file.path,
				label: formatPathSuggestionLabel(item.file),
				description: item.file.relativePath,
				// 相对路径含空格时同样加引号；目录追加 / 以通过 chip 规则并语义化为路径。
				value: formatPathSuggestionValue(item.file),
				isDirectory: item.file.type === "directory",
			}));
	}
	if (trigger.char === "&") {
		const list = sessions ?? [];
		return list
			.map((s) => ({ session: s, score: fuzzyScore(s.name ?? s.filePath, keyword) + fuzzyScore(s.preview ?? "", keyword) }))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				key: item.session.filePath,
				label: item.session.name ?? item.session.filePath,
				description: item.session.preview,
				value: `&${item.session.name ?? item.session.filePath}`,
				sessionMeta: { sessionId: item.session.id, filePath: item.session.filePath, projectPath: item.session.projectPath },
			}));
	}
	return [];
}
