import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, type Document } from "yaml";
import {
	isValidOmpModelPresetName,
	isValidOmpRoleSelector,
	OMP_MODEL_ROLES,
	isOmpModelRole,
	parseRoleSelector,
	stripRoleThinkingSuffix,
	type OmpFallbackChains,
	type OmpModelPreset,
	type OmpModelPresets,
	type OmpModelRole,
	type OmpModelRoleStorage,
	type OmpRolesState,
} from "../../shared/types/ompRoles";
import { JsonFileStore } from "../storage/JsonFileStore";
import { resolveOmpConfigFileName } from "./OmpConfigFile";
import type { ConfigValidationResult } from "./ConfigManager";

/**
 * OmpRolesStore —— omp config.yml（modelRoles + defaultThinkingLevel）的专属存取模块。
 *
 * 领域语义（scout 实锤 @oh-my-pi/pi-coding-agent 18.1.13 + 本机 config.yml）：
 * - omp 只把 config.yml/config.yaml 当全局 settings 权威源；settings.json 仅当
 *   config.yml 缺失时一次性迁移（改名 settings.json.bak），OmpDeck 不再反向写它；
 * - modelRoles.<role> 值 = "provider/modelId[:thinkingLevel]"，后缀是显式档，
 *   该角色生效时优先于顶层 defaultThinkingLevel（default 无后缀才回退顶层）；
 * - 因此「设置 OMP 默认（模型+思考档）」= 一次文档变更写两个槽位（selector 后缀
 *   是 omp 的角色级档位，顶层键是其它角色/回退的档位）——两者不是冗余，是 schema
 *   的两个槽位，见 ConfigManager 原双写窗口缺陷（两次全文件 RMW）的收敛。
 *
 * 不变式：
 * 1. 一次用户意图 = 一次 parse-mutate-write（原 setDefaultModel 两次串行全文件
 *    RMW 的撕裂写窗口在此关闭）；
 * 2. yaml round-trip 保留注释与无关键；
 * 3. 全部动作返回 {valid, error?}，不抛错（与 ConfigManager 校验风格一致）；
 * 4. 写前 mkdir configDir；default 角色清空时同步清顶层 defaultThinkingLevel
 *    （与原 writeOmpModelRole 语义一致），避免残留旧默认档。
 *
 * configDir 通过 accessor 注入：ConfigManager.configureWsl 可切换 WSL home，
 * 每次调用现取，保证指针跟随。
 */
export interface OmpRolesStoreDeps {
	resolveConfigDir: () => string;
}

export type DefaultModelInfo = {
	selector?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
};

function emptyRoles(): OmpRolesState {
	const empty: OmpRolesState = {} as OmpRolesState;
	for (const role of OMP_MODEL_ROLES) empty[role] = { selector: "" };
	return empty;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** 读取 `Record<string, string>`，丢弃空值/非字符串项（手编 config.yml 容错）。 */
function readStringRecord(value: unknown): Record<string, string> {
	const record = asRecord(value);
	const result: Record<string, string> = {};
	if (!record) return result;
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry === "string" && entry.trim()) result[key] = entry.trim();
	}
	return result;
}

/** 读取 `Record<string, string[]>`，丢弃空数组/非字符串项。 */
function readStringArrayRecord(value: unknown): OmpFallbackChains {
	const record = asRecord(value);
	const result: OmpFallbackChains = {};
	if (!record) return result;
	for (const [key, entry] of Object.entries(record)) {
		if (!Array.isArray(entry)) continue;
		const chain = entry.filter(
			(item): item is string => typeof item === "string" && item.trim().length > 0,
		).map((item) => item.trim());
		if (chain.length > 0) result[key] = chain;
	}
	return result;
}

/**
 * 解析单个 `modelPresets.<name>`。与 omp `parseModelPreset` 同口径：
 * `modelRoles` 必须是映射，每个值必须是非空字符串；`defaultThinkingLevel`
 * 只接受字符串（档位合法性交给 omp 运行时校验）。
 */
function parseModelPreset(value: unknown): OmpModelPreset | undefined {
	const record = asRecord(value);
	const roles = asRecord(record?.modelRoles);
	if (!record || !roles) return undefined;
	const modelRoles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(roles)) {
		if (typeof selector !== "string" || !selector.trim()) return undefined;
		modelRoles[role] = selector.trim();
	}
	const level = record.defaultThinkingLevel;
	if (level !== undefined && typeof level !== "string") return undefined;
	return {
		modelRoles,
		...(typeof level === "string" && level.trim()
			? { defaultThinkingLevel: level.trim() }
			: {}),
	};
}

export class OmpRolesStore {
	private readonly deps: OmpRolesStoreDeps;

	constructor(deps: OmpRolesStoreDeps) {
		this.deps = deps;
	}

	/** 进程内一次性 legacy 迁移守卫（避免多次启动重复写）。 */
	private legacyMigrated = false;

	private get configDir(): string {
		return this.deps.resolveConfigDir();
	}

	/** config.yml/yaml 的原子/串行 store（原文；YAML 解析与变更由本类负责）。 */
	private readonly configFiles = new Map<string, JsonFileStore<string>>();

	private yamlFile(filePath: string): JsonFileStore<string> {
		const existing = this.configFiles.get(filePath);
		if (existing) return existing;
		const created = JsonFileStore.text(filePath);
		this.configFiles.set(filePath, created);
		return created;
	}

	/** 读取当前生效的 config.yml(config.yaml) 原文；不存在返回 null。 */
	private async readRawConfigYaml(): Promise<string | null> {
		try {
			return await this.yamlFile(
				join(this.configDir, this.ompConfigYamlName()),
			).readRaw();
		} catch {
			// 读取失败按缺失处理：不基于不可读内容做迁移/合并
			return null;
		}
	}

	/** 写入文件名与读取文件保持一致（见 resolveOmpConfigFileName 的优先级说明）。 */
	private ompConfigYamlName(): string {
		return resolveOmpConfigFileName(this.configDir);
	}

	private async parseDoc(): Promise<Record<string, unknown> | null> {
		const raw = await this.readRawConfigYaml();
		if (raw === null) return null;
		try {
			const value = parseDocument(raw).toJS() as Record<string, unknown> | null;
			return value && typeof value === "object" && !Array.isArray(value) ? value : null;
		} catch {
			return null; // 解析失败按空处理（与原 readOmpModelRoles catch 语义一致）
		}
	}

	/** 读取全部角色的当前值（未配置角色返回空 assignment）。 */
	async readRolesState(): Promise<OmpRolesState> {
		const rolesState = emptyRoles();
		const parsed = await this.parseDoc();
		if (!parsed) return rolesState;
		const roles =
			parsed.modelRoles && typeof parsed.modelRoles === "object" && !Array.isArray(parsed.modelRoles)
				? (parsed.modelRoles as Record<string, unknown>)
				: {};
		for (const role of OMP_MODEL_ROLES) {
			const selector = typeof roles[role] === "string" ? roles[role] : "";
			if (selector) rolesState[role] = parseRoleSelector(selector);
		}
		return rolesState;
	}

	/** 默认模型角色（config.yml modelRoles.default），附顶层 defaultThinkingLevel 回退。 */
	async readDefaultModel(): Promise<DefaultModelInfo> {
		const parsed = await this.parseDoc();
		if (!parsed) return {};
		const topLevel =
			typeof parsed.defaultThinkingLevel === "string"
				? parsed.defaultThinkingLevel
				: undefined;
		const defaultSelector =
			parsed.modelRoles &&
			typeof parsed.modelRoles === "object" &&
			!Array.isArray(parsed.modelRoles) &&
			typeof (parsed.modelRoles as Record<string, unknown>).default === "string"
				? ((parsed.modelRoles as Record<string, unknown>).default as string)
				: "";
		if (!defaultSelector) return {};
		const parsedSelector = parseRoleSelector(defaultSelector);
		return {
			selector: parsedSelector.selector,
			provider: parsedSelector.provider,
			model: parsedSelector.modelId,
			thinkingLevel: parsedSelector.thinkingLevel ?? topLevel,
		};
	}

	/** 顶层 defaultThinkingLevel（桌面端 post-ready 强推与 SettingsTab 展示的数据源）。 */
	async readDefaultThinkingLevel(): Promise<string | undefined> {
		const parsed = await this.parseDoc();
		return parsed && typeof parsed.defaultThinkingLevel === "string"
			? parsed.defaultThinkingLevel
			: undefined;
	}

	/**
	 * config.yml `modelPresets`：只返回结构合法的条目。名字非法或角色值损坏的
	 * 条目仍保留在文件里（raw 编辑器可修），但不会出现在应用/删除 UI 中。
	 */
	async readModelPresets(): Promise<OmpModelPresets> {
		const parsed = await this.parseDoc();
		const presets = asRecord(parsed?.modelPresets);
		const result: OmpModelPresets = {};
		if (!presets) return result;
		for (const [name, value] of Object.entries(presets)) {
			if (!isValidOmpModelPresetName(name)) continue;
			const preset = parseModelPreset(value);
			if (preset) result[name] = preset;
		}
		return result;
	}

	/** `cycleOrder`：未配置返回空数组（UI 展示 omp 默认顺序）。 */
	async readCycleOrder(): Promise<string[]> {
		const parsed = await this.parseDoc();
		const raw = parsed?.cycleOrder;
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			.map((item) => item.trim());
	}

	/**
	 * `modelProviderOrder`：omp 解析裸模型 id/选择器时的供应商优先级。
	 * 未配置返回空数组（omp 内置顺序）。
	 */
	async readProviderOrder(): Promise<string[]> {
		const parsed = await this.parseDoc();
		const raw = parsed?.modelProviderOrder;
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
			.map((item) => item.trim());
	}

	/** 写入 `modelProviderOrder`；空数组删除该键回到 omp 内置顺序。 */
	async setProviderOrder(order: readonly string[]): Promise<ConfigValidationResult> {
		const normalized: string[] = [];
		for (const provider of order) {
			const trimmed = provider.trim();
			if (trimmed && !normalized.includes(trimmed)) normalized.push(trimmed);
		}
		return this.writeDoc((doc) => {
			if (normalized.length === 0) doc.delete("modelProviderOrder");
			else doc.set("modelProviderOrder", normalized);
		});
	}

	/** `modelRoleStorage`：决定 omp 把角色写入全局还是项目 config.yml。 */
	async readRoleStorage(): Promise<OmpModelRoleStorage> {
		const parsed = await this.parseDoc();
		return parsed?.modelRoleStorage === "project" ? "project" : "global";
	}

	/** 写入 `modelRoleStorage`；global 是 omp 默认值，删除键即回归默认。 */
	async setRoleStorage(value: OmpModelRoleStorage): Promise<ConfigValidationResult> {
		return this.writeDoc((doc) => {
			if (value === "global") doc.delete("modelRoleStorage");
			else doc.set("modelRoleStorage", "project");
		});
	}

	/** `retry.fallbackChains`（缺失/损坏按空处理）。 */
	async readFallbackChains(): Promise<OmpFallbackChains> {
		const parsed = await this.parseDoc();
		return readStringArrayRecord(asRecord(parsed?.retry)?.fallbackChains);
	}

	/** 把当前 modelRoles + defaultThinkingLevel 快照保存为预设（覆盖同名）。 */
	async saveModelPreset(name: string): Promise<ConfigValidationResult> {
		const trimmed = name.trim();
		if (!isValidOmpModelPresetName(trimmed)) {
			return {
				valid: false,
				error: "预设名需以字母开头，只能包含字母、数字、下划线和连字符",
			};
		}
		return this.writeDoc((doc) => {
			const snapshot = asRecord(doc.toJS());
			const modelRoles = readStringRecord(snapshot?.modelRoles);
			const level = snapshot?.defaultThinkingLevel;
			const preset: OmpModelPreset = {
				modelRoles,
				...(typeof level === "string" && level.trim()
					? { defaultThinkingLevel: level.trim() }
					: {}),
			};
			doc.setIn(["modelPresets", trimmed], preset);
		});
	}

	/**
	 * 应用预设：整块替换 modelRoles（预设里没有的角色会被清掉，与 omp
	 * `writePresetRoles` 的全球作用域语义一致）；预设未记录 thinking 时保留
	 * 当前顶层档位。
	 */
	async applyModelPreset(name: string): Promise<ConfigValidationResult> {
		const trimmed = name.trim();
		if (!trimmed) return { valid: false, error: "预设名不能为空" };
		return this.writeDoc((doc) => {
			const snapshot = asRecord(doc.toJS());
			const preset = parseModelPreset(asRecord(snapshot?.modelPresets)?.[trimmed]);
			if (!preset) throw new Error(`预设 "${trimmed}" 不存在或格式无效`);
			doc.setIn(["modelRoles"], preset.modelRoles);
			if (preset.defaultThinkingLevel !== undefined) {
				doc.set("defaultThinkingLevel", preset.defaultThinkingLevel);
			}
		});
	}

	/** 删除全局预设；项目/overlay 层定义的预设需改对应文件。 */
	async deleteModelPreset(name: string): Promise<ConfigValidationResult> {
		const trimmed = name.trim();
		if (!trimmed) return { valid: false, error: "预设名不能为空" };
		return this.writeDoc((doc) => {
			doc.deleteIn(["modelPresets", trimmed]);
		});
	}

	/** 设置模型循环顺序；空数组回到 omp 默认（删除该键）。 */
	async setCycleOrder(order: readonly string[]): Promise<ConfigValidationResult> {
		const normalized: string[] = [];
		for (const role of order) {
			const trimmed = role.trim();
			if (trimmed && !normalized.includes(trimmed)) normalized.push(trimmed);
		}
		return this.writeDoc((doc) => {
			if (normalized.length === 0) doc.delete("cycleOrder");
			else doc.set("cycleOrder", normalized);
		});
	}

	/** 写入 `retry.fallbackChains`；空映射删除键并修剪空 retry 映射。 */
	async setFallbackChains(chains: OmpFallbackChains): Promise<ConfigValidationResult> {
		const normalized: OmpFallbackChains = {};
		for (const [key, value] of Object.entries(chains)) {
			const trimmedKey = key.trim();
			if (!trimmedKey || !Array.isArray(value)) continue;
			const chain = value
				.map((selector) => (typeof selector === "string" ? selector.trim() : ""))
				.filter(Boolean);
			if (chain.length > 0) normalized[trimmedKey] = chain;
		}
		return this.writeDoc((doc) => {
			if (Object.keys(normalized).length === 0) {
				doc.deleteIn(["retry", "fallbackChains"]);
			} else {
				doc.setIn(["retry", "fallbackChains"], normalized);
			}
		});
	}

	/** 通用写盘：一次 parse-mutate-write（队列内），保留注释与无关键。 */
	private async writeDoc(mutate: (doc: Document) => void): Promise<ConfigValidationResult> {
		try {
			const filePath = join(this.configDir, this.ompConfigYamlName());
			// 队列内 read-modify-write：并发的角色写入基于同一份最新文档变更，不互相覆盖；
			// 写失败时旧文件保持完整（tmp 写完后才 rename 替换）
			await this.yamlFile(filePath).update((current) => {
				const doc = parseDocument(current ?? "", { prettyErrors: true });
				mutate(doc);
				// modelRoles 被清空时删除整块，避免写残留空对象
				const rolesNode: unknown = doc.get("modelRoles");
				if (
					rolesNode &&
					typeof rolesNode === "object" &&
					!Array.isArray(rolesNode) &&
					Object.keys(rolesNode).length === 0
				) {
					doc.delete("modelRoles");
				}
				// 预设/回退链删除后同理，避免 `modelPresets: {}`、`retry: {}` 残壳
				for (const key of ["modelPresets", "retry"] as const) {
					const node: unknown = doc.get(key);
					if (
						node &&
						typeof node === "object" &&
						!Array.isArray(node) &&
						Object.keys(node).length === 0
					) {
						doc.delete(key);
					}
				}
				return doc.toString();
			});
			return { valid: true };
		} catch (e) {
			return {
				valid: false,
				error: `config.yml 写入失败：${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	/**
	 * 设置某个模型角色（含后缀档位）。default 角色走 applyDefault（与顶层键联动）；
	 * 非 default 角色只写 modelRoles.<role>。
	 */
	async applyRole(
		role: OmpModelRole,
		selector: string,
		thinkingLevel?: string,
	): Promise<ConfigValidationResult> {
		const normalized = selector.trim();
		if (!isValidOmpRoleSelector(normalized)) {
			return { valid: false, error: "selector 格式无效" };
		}
		if (role === "default") return this.applyDefault(normalized, thinkingLevel);
		return this.writeDoc((doc) => {
			const trimmed = thinkingLevel?.trim();
			// selector 可自带 `:level`；先剥掉再拼，避免 "a:b" + "b" → "a:b:b"。
			const bare = trimmed ? stripRoleThinkingSuffix(normalized) : normalized;
			doc.setIn(["modelRoles", role], trimmed ? `${bare}:${trimmed}` : bare);
		});
	}
	/** 只写顶层 defaultThinkingLevel（导入恢复用：保留已有档位的兜底项）。 */
	async applyDefaultThinkingLevel(
		level: string,
	): Promise<ConfigValidationResult> {
		return this.writeDoc((doc) => {
			doc.set("defaultThinkingLevel", level.trim());
		});
	}

	/** 清除某个角色；default 联动清顶层 defaultThinkingLevel。 */
	async clearRole(role: OmpModelRole): Promise<ConfigValidationResult> {
		return this.writeDoc((doc) => {
			doc.deleteIn(["modelRoles", role]);
			if (role === "default") doc.delete("defaultThinkingLevel");
		});
	}

	/**
	 * 设置 OMP 默认（模型 + 可选思考档）——单次文档变更写两个槽位：
	 * modelRoles.default = "provider/modelId[:level]"；顶层 defaultThinkingLevel =
	 * level（给了才写；没给且原值在，则删除——与原双写流程的净效果一致，只是原子）。
	 */
	async applyDefault(
		selector: string,
		thinkingLevel?: string,
	): Promise<ConfigValidationResult> {
		const normalized = selector.trim();
		if (!isValidOmpRoleSelector(normalized)) {
			return { valid: false, error: "selector 格式无效" };
		}
		return this.writeDoc((doc) => {
			const trimmed = thinkingLevel?.trim();
			const bare = trimmed ? stripRoleThinkingSuffix(normalized) : normalized;
			doc.setIn(
				["modelRoles", "default"],
				trimmed ? `${bare}:${trimmed}` : bare,
			);
			if (trimmed) doc.set("defaultThinkingLevel", trimmed);
			else doc.delete("defaultThinkingLevel");
		});
	}

	/** 清除 OMP 默认（modelRoles.default + 顶层 defaultThinkingLevel 一次清）。 */
	async clearDefault(): Promise<ConfigValidationResult> {
		return this.clearRole("default");
	}

	/**
	 * 恢复导出的 config.yml 包片段：逐角色校验后原子写入，顶层档位保留。
	 * 无效角色/空 selector/缺 provider 跳过；包赢（同文档一次变更）。
	 */
	async importPackage(ompConfig: unknown): Promise<ConfigValidationResult> {
		if (!ompConfig || typeof ompConfig !== "object" || Array.isArray(ompConfig)) {
			return { valid: true };
		}
		const incoming = ompConfig as Record<string, unknown>;
		const roles = incoming.modelRoles;
		const topLevel = incoming.defaultThinkingLevel;
		const rawPresets = asRecord(incoming.modelPresets);
		const rawCycle = incoming.cycleOrder;
		const rawProviderOrder = incoming.modelProviderOrder;
		const rawRoleStorage = incoming.modelRoleStorage;
		const rawFallback = asRecord(asRecord(incoming.retry)?.fallbackChains);
		return this.writeDoc((doc) => {
			if (roles && typeof roles === "object" && !Array.isArray(roles)) {
				for (const [role, selector] of Object.entries(roles)) {
					if (!isOmpModelRole(role) || typeof selector !== "string") continue;
					// 导出包必须原样保留别名/候选列表（`@slow`、`a/b,c/d`）：
					// 旧实现重建 provider/model 会把它们静默丢弃。
					const normalized = selector.trim();
					if (!isValidOmpRoleSelector(normalized)) continue;
					doc.setIn(["modelRoles", role], normalized);
				}
			}
			if (typeof topLevel === "string" && topLevel) {
				doc.set("defaultThinkingLevel", topLevel);
			}
			if (rawPresets) {
				for (const [name, value] of Object.entries(rawPresets)) {
					if (!isValidOmpModelPresetName(name)) continue;
					const preset = parseModelPreset(value);
					if (preset) doc.setIn(["modelPresets", name], preset);
				}
			}
			if (Array.isArray(rawCycle)) {
				const order = rawCycle
					.filter((item): item is string => typeof item === "string")
					.map((item) => item.trim())
					.filter((item, index, all) => item && all.indexOf(item) === index);
				if (order.length > 0) doc.set("cycleOrder", order);
			}
			if (Array.isArray(rawProviderOrder)) {
				const order = rawProviderOrder
					.filter((item): item is string => typeof item === "string")
					.map((item) => item.trim())
					.filter((item, index, all) => item && all.indexOf(item) === index);
				// 空数组在 omp 语义里等价于未配置（内置顺序），导入时删键而不是留空列表。
				if (order.length > 0) doc.set("modelProviderOrder", order);
				else doc.delete("modelProviderOrder");
			}
			if (rawRoleStorage === "project") doc.set("modelRoleStorage", "project");
			else if (rawRoleStorage === "global") doc.delete("modelRoleStorage");
			if (rawFallback) {
				const chains = readStringArrayRecord(rawFallback);
				if (Object.keys(chains).length > 0) {
					doc.setIn(["retry", "fallbackChains"], chains);
				}
			}
		});
	}

	/**
	 * 一次性 legacy 迁移（Q20a 语义）：settings.json 的 defaultThinkingLevel 只填空、
	 * 不覆盖——仅当 config.yml 顶层缺该键且 settings.json 有值时写入。omp 本身只在
	 * config.yml 缺失时消费 settings.json，此处不改变 omp 的迁移边界，只把 OmpDeck
	 * 旧写入的档位搬进权威源。进程内只跑一次；多数机器 settings.json 无此键，空操作。
	 */
	async migrateLegacyDefaultThinkingLevel(): Promise<void> {
		if (this.legacyMigrated) return;
		this.legacyMigrated = true;
		try {
			const parsed = await this.parseDoc();
			if (parsed && typeof parsed.defaultThinkingLevel === "string") return; // 权威源已有
			const settingsPath = join(this.configDir, "settings.json");
			if (!existsSync(settingsPath)) return;
			const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
				defaultThinkingLevel?: unknown;
			};
			if (typeof settings.defaultThinkingLevel !== "string") return;
			await this.writeDoc((doc) => {
				doc.set("defaultThinkingLevel", settings.defaultThinkingLevel as string);
			});
		} catch {
			// 迁移失败不阻塞启动；下次进程启动再试（守卫按进程计，非按文件）
		}
	}
}
