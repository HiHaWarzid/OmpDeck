import { homedir } from "node:os";
import type { WslEnvironment } from "../wsl/WslPaths";

/**
 * Frontmatter manifest 统一模块。
 *
 * 该逻辑此前在 SkillManager / ProjectResourceManager / PromptManager 中被复制了三份：
 * - parseFrontmatter / setFrontmatterName / setFrontmatterBoolean：三处语义完全一致；
 * - normalizeName / validateManifest：SkillManager 与 PromptManager 为 Unicode 版本，
 *   ProjectResourceManager 为 ASCII 版本（见 normalizeName 处的说明）；
 * - resolveWslHome：SkillManager / PromptManager 的 configureWsl 注入逻辑。
 *
 * Wave-3 swap-in 时各 manager 直接改调本模块，行为保持不变（union 语义）。
 */

/** Skill 清单文件名：目录型 skill 的 manifest 固定叫 SKILL.md（两个 skill manager 完全一致）。 */
export const SKILL_FILE = "SKILL.md";

export type ManifestKind = "skill" | "prompt";

/**
 * 解析 markdown 文件头部 frontmatter 块。
 * 只做最朴素的 key: value 行解析（非 YAML），与三处既有实现逐字一致：
 * - 必须以 `---` 开头且正文前有换行，懒匹配到第一个 `\n---` 结尾；
 * - 行内第一个 `:` 分割 key/value，key 为空或行内无冒号则跳过；
 * - value 去除首尾空白，并剥离首尾的单/双引号（各最多一个字符）。
 * 解析不到（无 `---` 块、未闭合、不在文件头）时返回空对象，调用方需自行兜底。
 */
export function parseFrontmatter(raw: string): Record<string, string> {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const result: Record<string, string> = {};
	if (!match) return result;
	for (const line of match[1].split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index === -1) continue;
		const key = line.slice(0, index).trim();
		let value = line.slice(index + 1).trim();
		value = value.replace(/^['"]|['"]$/g, "");
		if (key) result[key] = value;
	}
	return result;
}

/**
 * 把 frontmatter 对象序列化为 `---\nkey: value\n---` 块（LF 换行）。
 * 与两个 skill manager 的 create() 产出格式一致；行序按对象插入序保留。
 * 纯写入场景用（如新建清单文件）。
 */
export function serializeFrontmatter(frontmatter: Record<string, string>): string {
	const lines = Object.entries(frontmatter)
		.filter(([, value]) => value != null)
		.map(([key, value]) => `${key}: ${value}`);
	return `---\n${lines.join("\n")}\n---`;
}

/**
 * 原位替换 frontmatter 中的 name 字段（重命名 Skill 时同步更新清单）。
 * 注意：与 setFrontmatterBoolean 不同，name 缺失时【不会】追加 —— 重命名只作用于
 * 已带 name 字段的清单（两个 manager 的 create() 都会写入 name，因此原实现从未触发该缺口）。
 * 无 frontmatter 块时在文件头部补一个最小块（此时必然写入 name）。
 */
export function setFrontmatterName(raw: string, name: string): string {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return `---\nname: ${name}\n---\n\n${raw}`;
	const lines = match[1].split(/\r?\n/);
	const nextLines = lines.map((line) => {
		if (line.trim().startsWith("name:")) return `name: ${name}`;
		return line;
	});
	return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
}

/**
 * 替换/新增 frontmatter 中的布尔字段（如 disable-model-invocation 的开关）。
 * 行数 / 顺序保持不变，只有被命中的行改写；未命中则在块尾追加一行。
 */
export function setFrontmatterBoolean(raw: string, key: string, value: boolean): string {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return `---\n${key}: ${value}\n---\n\n${raw}`;
	const lines = match[1].split(/\r?\n/);
	let changed = false;
	const nextLines = lines.map((line) => {
		if (!line.trim().startsWith(`${key}:`)) return line;
		changed = true;
		return `${key}: ${value}`;
	});
	if (!changed) nextLines.push(`${key}: ${value}`);
	return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
}

/**
 * 规范化 manifest 名称：trim → Unicode 字母/数字/连字符保留，其余替换为连字符 → 连字符合并 → 去首尾连字符 → 小写。
 * 采用 SkillManager / PromptManager 的 Unicode 版本（`\p{L}\p{N}` + u flag），中文等非拉丁文字得以保留；
 * 注意 ProjectResourceManager 是 ASCII 版本（`[^a-z0-9-]`，中文会被替换为 `-`），
 * 二者在纯英文输入下结果完全一致，仅 Unicode 字符输入有差异 —— union 语义取 Unicode 版。
 */
export function normalizeName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * 校验解析出的 frontmatter，返回警告列表（空数组 = 合法）。
 * 按清单种类给出必填规则：
 * - skill：name 必填、description 必填（omp 不加载无 description 的 skill）、
 *   name 只允许 Unicode 字母/数字/单个连字符且 ≤64 字符、description ≤1024 字符；
 * - prompt：仅 description 必填（与 PromptManager.create 的“模板描述不能为空”一致）。
 * 注意 ProjectResourceManager 的校验是纯 ASCII 小写版（`^[a-z0-9]+(?:-[a-z0-9]+)*$`），
 * 对含中文的显示名会误报 —— union 语义取 Unicode 版（SkillManager 行为）。
 */
export function validateManifest(
	parsed: Record<string, string>,
	kind: ManifestKind = "skill",
): string[] {
	const name = String(parsed.name ?? "").trim();
	const description = String(parsed.description ?? "").trim();
	if (kind === "prompt") {
		const warnings: string[] = [];
		// Prompt 模板的 name 来自文件名，frontmatter 只有 description 是必填（与 PromptManager.create 的“模板描述不能为空”一致）
		if (!description) warnings.push("缺少 description");
		return warnings;
	}
	const warnings: string[] = [];
	if (!name) warnings.push("缺少 name");
	if (name && !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name)) {
		warnings.push("name 只能包含字母（含中文等）、数字和单个连字符");
	}
	if (name.length > 64) warnings.push("name 超过 64 个字符");
	if (!description) warnings.push("缺少 description，omp 不会加载该 skill");
	if (description.length > 1024) warnings.push("description 超过 1024 个字符");
	return warnings;
}

/**
 * WSL home 注入：环境存在时用 WSL 环境解析出的 windowsHome 取代传入的 Windows home，
 * 否则原样返回。SkillManager / PromptManager 的 configureWsl 均执行
 * `environment?.windowsHome ?? homedir()`，本函数即该逻辑的等价提纯：
 * 调用方传 `homedir()`（或不传，默认取它）作为基础 home，环境为空时行为不变。
 */
export function resolveWslHome(
	home: string = homedir(),
	environment: WslEnvironment | null = null,
): string {
	return environment?.windowsHome ?? home;
}