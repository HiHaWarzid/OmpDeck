/**
 * Store 市场 IPC handler：promptStore（prompts.chat）、skillStore、skillHub（Skills.sh）、yaoPrompts（中文精选）。
 * 搜索/详情/导入逻辑均含 inline fetch；导入操作委托给 PromptManager / SkillManager / XuePromptManager。
 * 返回 HandlerMap 由 registerIpcHandlers 统一注册（通道名/协议取自通道表）。
 */
import { ipcTable, type IpcHandlerMap, type SkillHubSearchPayload } from "../../shared/ipc";
import type { PiDesktopApi } from "../../shared/api";
import type {
	PiPromptTemplateSummary,
	PromptStoreSearchResult,
	PromptStoreSearchResponse,
	PromptStoreRawItem,
	PromptStoreItem,
} from "../../shared/types";
import type { PromptManager } from "../prompts/PromptManager";
import type { XuePromptManager } from "../prompts/XuePromptManager";
import type { SkillManager } from "../skills/SkillManager";
import type { AppLogger } from "../logging/AppLogger";

interface StoreHandlerDeps {
	promptManager: PromptManager;
	skillManager: SkillManager;
	xuePromptManager: XuePromptManager;
	appLogger: AppLogger;
}

type StoreHandlerMaps = {
	promptStore: IpcHandlerMap<typeof ipcTable.promptStore, PiDesktopApi["promptStore"]>;
	skillStore: IpcHandlerMap<typeof ipcTable.skillStore, PiDesktopApi["skillStore"]>;
	skillHub: IpcHandlerMap<typeof ipcTable.skillHub, PiDesktopApi["skillHub"]>;
	yaoPrompts: IpcHandlerMap<typeof ipcTable.yaoPrompts, PiDesktopApi["yaoPrompts"]>;
};

/** prompts.chat REST API 端点 */
const PROMPT_STORE_BASE = "https://prompts.chat/api";

/** 将 prompts.chat 原始 prompt 条目扁平化为 UI 消费的格式 */
function flattenPromptItem(raw: PromptStoreRawItem): PromptStoreItem {
	return {
		id: raw.id,
		title: raw.title,
		description: raw.description,
		content: raw.content,
		type: raw.type,
		author: raw.author?.name ?? "",
		category: raw.category?.name ?? "",
		tags: raw.tags?.map((t) => t.tag?.name).filter(Boolean) ?? [],
		votes: raw.voteCount ?? 0,
		createdAt: raw.createdAt,
	};
}

/**
 * 将 prompts.chat 的命名变量（${name} / ${name:default}）
 * 转换为 pi 的位置参数（$N / ${N:-default}）。
 * 同时生成 argument-hint。
 */
function convertStoreVarsToPiVars(content: string): {
	converted: string;
	argumentHint: string;
	varCount: number;
} {
	// 收集所有 ${name} 和 ${name:default}，保留出现顺序
	const varMap = new Map<string, { index: number; hasDefault: boolean; defaultVal?: string }>();
	let nextIndex = 1;
	// 先扫描所有变量并分配序号
	const scanRegex = /\$\{([a-zA-Z_]\w*)(?::(.*?))?\}/g;
	let scanMatch: RegExpExecArray | null;
	while ((scanMatch = scanRegex.exec(content)) !== null) {
		const varName = scanMatch[1];
		if (!varMap.has(varName)) {
			varMap.set(varName, {
				index: nextIndex++,
				hasDefault: scanMatch[2] !== undefined,
				defaultVal: scanMatch[2],
			});
		}
	}

	// 如果没有变量，直接返回原文
	if (varMap.size === 0) {
		return { converted: content, argumentHint: "", varCount: 0 };
	}

	// 替换变量
	let converted = content.replace(
		/\$\{([a-zA-Z_]\w*)(?::(.*?))?\}/g,
		(_match, varName: string, defaultVal?: string) => {
			const info = varMap.get(varName)!;
			if (defaultVal !== undefined) {
				return `\${${info.index}:-${defaultVal}}`;
			}
			return `$${info.index}`;
		},
	);

	// 生成 argument-hint：无默认值的用 <>, 有默认值的用 []
	const hints: string[] = [];
	for (let i = 1; i < nextIndex; i++) {
		const entry = Array.from(varMap.entries()).find(([, v]) => v.index === i);
		if (!entry) continue;
		const [varName, info] = entry;
		if (info.hasDefault) {
			hints.push(`[${varName}:${info.defaultVal}]`);
		} else {
			hints.push(`<${varName}>`);
		}
	}
	const argumentHint = hints.length > 0 ? hints.join(" ") : "";

	return { converted, argumentHint, varCount: varMap.size };
}

export function registerStoreHandlers(deps: StoreHandlerDeps): StoreHandlerMaps {
	const { promptManager, skillManager, xuePromptManager, appLogger } = deps;

	return {
		// ── Prompt Store (prompts.chat) ──────────────────────────────────────
		promptStore: {
			/**
			 * 搜索 prompts.chat 公开 prompt 市场。
			 * 使用 REST API 搜索，返回结构化结果供用户浏览和选择导入。
			 */
			search: async (_event, query: string, options?: {
				limit?: number;
				type?: string;
				category?: string;
				tag?: string;
			}) => {
				try {
					const params = new URLSearchParams({ q: query });
					if (options?.limit) params.set("perPage", String(options.limit));
					if (options?.type) params.set("type", options.type);
					if (options?.category) params.set("category", options.category);
					if (options?.tag) params.set("tag", options.tag);

					const url = `${PROMPT_STORE_BASE}/prompts?${params.toString()}`;
					const response = await fetch(url, {
						signal: AbortSignal.timeout(10_000),
					});
					if (!response.ok) {
						throw new Error(`prompts.chat API 返回 ${response.status}`);
					}
					// API 返回原始结构，扁平化为 UI 消费的格式
					const raw = (await response.json()) as PromptStoreSearchResponse;
					const result: PromptStoreSearchResult = {
						query,
						count: raw.total,
						prompts: raw.prompts.map(flattenPromptItem),
					};
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void appLogger.warn("prompt-store", "Search failed", { query, error: message });
					throw new Error(`搜索 prompt 商店失败: ${message}`);
				}
			},
			/** 通过 ID 获取 prompts.chat 单个 prompt 的完整内容 */
			get: async (_event, id: string) => {
				try {
					const url = `${PROMPT_STORE_BASE}/prompts/${encodeURIComponent(id)}`;
					const response = await fetch(url, {
						signal: AbortSignal.timeout(10_000),
					});
					if (!response.ok) {
						throw new Error(`prompts.chat API 返回 ${response.status}`);
					}
					const raw = (await response.json()) as PromptStoreRawItem;
					return flattenPromptItem(raw);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void appLogger.warn("prompt-store", "Get prompt failed", { id, error: message });
					throw new Error(`获取 prompt 详情失败: ${message}`);
				}
			},
			/** 从 prompts.chat 导入 prompt 到本地 ~/.omp/agent/prompts/ */
			import: async (
				_event,
				{
					title,
					description,
					content,
				}: {
					title: string;
					description: string;
					content: string;
				},
			) => {
				try {
					const name = title
						.trim()
						.toLowerCase()
						.replace(/[^\p{L}\p{N}-]+/gu, "-")
						.replace(/-+/g, "-")
						.replace(/^-|-$/g, "");
					if (!name) throw new Error("标题中未提取到有效文件名");

					// 转换变量格式：prompts.chat 的 ${name} → pi 的 $N
					const { converted, argumentHint, varCount } = convertStoreVarsToPiVars(content);

					// 使用 PromptManager.create 来创建，统一命名规范
					// 但如果 create 失败（模板已存在名），加后缀
					const tryCreate = async (tryName: string): Promise<PiPromptTemplateSummary> => {
						try {
							return await promptManager.create({ name: tryName, description });
						} catch {
							// 名称冲突，加数字后缀重试
							const match = tryName.match(/-(\d+)$/);
							const nextNum = match ? parseInt(match[1], 10) + 1 : 2;
							const suffixName = tryName.replace(/-\d+$/, "") + "-" + nextNum;
							return tryCreate(suffixName);
						}
					};

					// 如果有 argument-hint，在 frontmatter 中标注
					const hintLine = argumentHint ? `\nargument-hint: ${argumentHint}` : "";
					const frontmatter = `---\ndescription: ${description.replace(/\n/g, " ")}\nsource: prompts.chat${hintLine}\n---\n\n`;
					const summary = await tryCreate(name);
					await promptManager.writeContent(summary.path, frontmatter + converted);

					void appLogger.info("prompt-store", "Imported prompt from store", {
						title,
						localName: summary.name,
						variables: varCount,
					});
					return summary;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void appLogger.warn("prompt-store", "Import failed", { title, error: message });
					throw new Error(`导入 prompt 失败: ${message}`);
				}
			},
		},

		// ── Skill Store（prompts.chat skills） ─────────────────────────────
		skillStore: {
			/** 搜索 prompts.chat 的公开 skill。复用 prompts 搜索，按 skill 关键词过滤 */
			search: async (_event, query: string) => {
				try {
					const params = new URLSearchParams({ q: query, perPage: "20" });
					const url = `https://prompts.chat/api/prompts?${params.toString()}`;
					const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
					if (!response.ok) throw new Error(`prompts.chat API 返回 ${response.status}`);
					const raw = (await response.json()) as PromptStoreSearchResponse;
					const result: PromptStoreSearchResult = {
						query,
						count: raw.total,
						prompts: raw.prompts.map(flattenPromptItem),
					};
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`搜索 skill 商店失败: ${message}`);
				}
			},
			/** 从 prompts.chat 导入为本地 skill */
			import: async (_event, item: PromptStoreItem, locationId = "pi-global") => {
				try {
					const name = item.title
						.trim()
						.toLowerCase()
						.replace(/[^\p{L}\p{N}-]+/gu, "-")
						.replace(/-+/g, "-")
						.replace(/^-|-$/g, "");
					if (!name) throw new Error("标题中未提取到有效文件名");

					const { writeFile } = await import("node:fs/promises");

					// 运行期输入验证：IPC 契约是宽松 string（渲染层保存位置 4 值联合经
					// 序列化后到达），创建器只接受 4 值枚举；未知值回退默认，
					// 防止任意字符串穿透到 SKILL 落盘路径拼接。
					const resolvedLocation =
						locationId === "pi-global" ||
						locationId === "agents-global" ||
						locationId === "project-pi" ||
						locationId === "project-agents"
							? locationId
							: "pi-global";

					// 用 SkillManager 创建 skill（默认 pi-global，用户可通过 dropdown 切换）
					const summary = await skillManager.create({
						name,
						description: item.description || item.title,
						locationId: resolvedLocation,
					});

					// 覆盖 SKILL.md 为实际内容
					const skillContent = `---\nname: ${name}\ndescription: ${(item.description || item.title).replace(/\n/g, " ")}\nsource: prompts.chat\n---\n\n# ${item.title}\n\n${item.content}`;
					await writeFile(summary.path, skillContent, "utf8");

					void appLogger.info("skill-store", "Imported skill from store", {
						title: item.title,
						localName: name,
					});
					return summary;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void appLogger.warn("skill-store", "Import failed", { title: item.title, error: message });
					throw new Error(`导入 skill 失败: ${message}`);
				}
			},
		},

		// ── Skills.sh（https://www.skills.sh） ─────────────────────────
		skillHub: {
			/** 搜索 Skills.sh 注册中心 */
			search: async (_event, opts: SkillHubSearchPayload) => {
				// pack 只打包 (query, page, pageSize, sortBy, order)；limit 未打包，固定 50
				const { query } = opts;
				const limit = 50;
				try {
					const response = await fetch(
						`https://www.skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
						{ signal: AbortSignal.timeout(15_000) },
					);
					if (!response.ok) throw new Error(`API 返回 ${response.status}`);
					const json = (await response.json()) as {
						skills?: Array<{ id: string; skillId: string; name: string; installs: number; source: string }>;
					};
					const skills = json.skills ?? [];
					// skills.sh 的 id 格式为 "source/skillName"，提取 package 名用于安装
					const items = skills.map((item) => ({
						slug: item.id,
						name: item.name,
						description: "",
						description_zh: "",
						iconUrl: undefined,
						stars: 0,
						downloads: item.installs,
						installs: item.installs,
						category: "",
						version: "",
						ownerName: item.source,
						source: "skills.sh",
					}));
					// 按安装量降序排列
					items.sort((a, b) => b.installs - a.installs);
					return { query, total: items.length, items };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`搜索 Skills.sh 失败: ${message}`);
				}
			},
			/** 获取 Skills.sh skill 详情（直接返回 null，用不到） */
			detail: async () => null,
			/** 安装 Skills.sh skill：npx skills add <package> */
			install: async (_event, slug: string) => {
				// slug 是 "source/skillName" 格式，例如 "anthropics/skills/pdf"
				const lastSlash = slug.lastIndexOf("/");
				const pkg = lastSlash > 0 ? slug.slice(0, lastSlash) : slug;
				const skillName = lastSlash > 0 ? slug.slice(lastSlash + 1) : "";
				try {
					const { exec } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const execAsync = promisify(exec);
					// -g 安装到用户全局目录, -s 指定单个 skill, -y 跳过交互确认
					const cmd = `npx skills add "${pkg}" -g -s "${skillName}" -y`;
					await execAsync(cmd, { encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
					void appLogger.info("skill-hub", "Installed skill", { slug, pkg, skillName });
					return { success: true, slug, installDir: "" };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void appLogger.warn("skill-hub", "Install failed", { slug, error: message });
					return { success: false, slug, installDir: "", error: message };
				}
			},
		},

		// ── Yao Open Prompts（中文提示词精选） ─────────────────────────────
		yaoPrompts: {
			list: async (_event, opts?: {
				category?: string;
				search?: string;
				page?: number;
				pageSize?: number;
				onlyCategories?: boolean;
			}) => {
				try {
					const result = await xuePromptManager.list(opts);
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void appLogger.warn("yao-prompts", "List failed", { error: message });
					throw new Error(`读取中文提示词库失败: ${message}`);
				}
			},
			detail: async (_event, slug: string, category: string) => {
				try {
					const result = await xuePromptManager.detail(slug, category);
					if (!result) throw new Error(`未找到提示词: ${slug}`);
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void appLogger.warn("yao-prompts", "Detail failed", { slug, category, error: message });
					throw new Error(`读取提示词详情失败: ${message}`);
				}
			},
			import: async (_event, slug: string, category: string) => {
				try {
					const result = await xuePromptManager.importToPi(slug, category);
					void appLogger.info("yao-prompts", "Imported to pi templates", {
						slug,
						localName: result.name,
					});
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void appLogger.warn("yao-prompts", "Import failed", { slug, category, error: message });
					throw new Error(`导入提示词失败: ${message}`);
				}
			},
		},
	};
}
