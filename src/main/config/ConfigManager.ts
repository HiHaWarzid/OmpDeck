import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { normalize, join, dirname } from "node:path";
import { dirname as posixDirname, normalize as posixNormalize } from "node:path/posix";
import { homedir } from "node:os";
import { net } from "electron";
import type { AvailableModel } from "../../shared/types";
import type { ConfigFileDiagnostic, ConfigFileReadResult } from "../../shared/types";
import type { ConfigSaveWarning } from "../../shared/types";
import {
	buildModelsRequest,
	buildTestRequest,
	connectionErrorMessage,
	extractHttpErrorDetail,
	normalizeApiType,
	parseModelsResponse,
	parseTestResponse,
	redactDiagnostics,
	sessionBaseUrlHint,
} from "./providerProbe";
import { OmpRolesStore } from "./OmpRolesStore";
import { TrustStore } from "./TrustStore";
import { JsonFileStore } from "../storage/JsonFileStore";
import { parseDocument } from "yaml";
import type { WslEnvironment } from "../wsl/WslPaths";

/** pi 全局配置目录：~/.omp/agent/ */
const PI_AGENT_DIR = join(homedir(), ".omp", "agent");

// ── models.json 结构 ──────────────────────────────────
// { providers: { [providerName]: { baseUrl, api, apiKey, models: [...] } } }

// Provider 连接测试面对的是第三方网关和 reasoning 模型，首包可能慢于普通模型；
// 放宽超时并在错误文案中说明“超时不等于兼容模式不支持”，避免误导用户改错配置。
const PROVIDER_TEST_TIMEOUT_MS = 45_000;
const PROVIDER_TEST_TIMEOUT_SECONDS = PROVIDER_TEST_TIMEOUT_MS / 1000;

export type PiModelItem = {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	[key: string]: unknown;
};

export type PiProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models: PiModelItem[];
	[key: string]: unknown;
};

export type PiModelsFile = {
	providers: Record<string, PiProviderConfig>;
};

// ── auth.json 结构 ────────────────────────────────────
// { [providerName]: { type: "api_key", key: "..." } }

export type PiAuthItem = {
	type?: string;
	key?: string;
	[key: string]: unknown;
};

export type PiAuthFile = Record<string, PiAuthItem>;

// ── settings.json ─────────────────────────────────────

export type PiSettings = Record<string, unknown>;

export type ConfigValidationResult = {
	valid: boolean;
	error?: string;
	/**
	 * 「已保存，但有降级」：例如 models.json 写成功而 pi 侧的 models.yml 镜像失败。
	 * 调用方（渲染层）据此提示用户，而不是把成功当失败、或把失败当成功。
	 */
	warnings?: ConfigSaveWarning[];
};

type TestRequest = {
	url: string;
	headers: Record<string, string>;
	body?: string;
	method?: "GET" | "POST";
};

/**
 * 管理 omp 全局配置文件（~/.omp/agent/ 下的 models.json、auth.json、settings.json）。
 * 按照 pi 实际文件格式解析：models.json 是嵌套 providers 结构，auth.json 是对象映射。
 */
export class ConfigManager {
	private configDir: string;
	/**
	 * config.yml 专属存取（roles + defaultThinkingLevel），configDir 经 accessor 注入。
	 * 公开只读：角色读写是 store 自身的能力，消费方（IPC/AgentManager）直取，
	 * 本类不再逐方法转发（接口与实现等宽 = 浅模块）。
	 */
	readonly rolesStore: OmpRolesStore;
	/** trust.json 专属存取（信任决策存储/探测/编排），configDir 经 accessor 注入。 */
	readonly trustStore: TrustStore;
	/** models/auth/settings.json 的原子写与读指纹 store（原文）；configDir 可切换，按完整路径缓存。 */
	private readonly jsonFiles = new Map<string, JsonFileStore<string>>();

	constructor(configDir?: string) {
		this.configDir = configDir ?? PI_AGENT_DIR;
		this.rolesStore = new OmpRolesStore({ resolveConfigDir: () => this.configDir });
		this.trustStore = new TrustStore({ resolveConfigDir: () => this.configDir });
	}

	/** 将配置目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.configDir = environment
			? join(environment.windowsHome, ".omp", "agent")
			: PI_AGENT_DIR;
	}

	// ── 读取 ──────────────────────────────────────────────

	async getModelsConfig(): Promise<ConfigFileReadResult<PiModelsFile>> {
		// 优先读 models.json；不存在时从 models.yml 回退
		const jsonPath = join(this.configDir, "models.json");
		if (!existsSync(jsonPath)) {
			const ymlResult = await this.readModelsYml();
			if (ymlResult.parsed) {
				// 同时写一份 models.json 供后续使用。这里不阻塞读取（迁移是尽力而为，
				// 下次启动会重试），但失败要留痕：否则用户会一直读到 yml 回退路径。
				// 空 providers 不迁移：多半意味着 yml 损坏（或为空），落空配置会把
				// 「用户手编 yml 暂不可读」固化成永久空配置（孤儿化）。
				if (Object.keys(ymlResult.parsed.providers).length > 0) {
					void this.writeJsonFile("models.json", ymlResult.parsed).catch((error: unknown) => {
						console.warn(
							`[ConfigManager] models.json 迁移写入失败，本次仍从 models.yml 读取：${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					});
				}
			}
			return ymlResult;
		}
		return this.readJsonFile<PiModelsFile>("models.json", { providers: {} });
	}

	/**
	 * 只保留 models.json 里显式配置过的模型。
	 * pi 会把「配置了 API Key（含环境变量）的供应商」的完整内置目录也算作可用模型，
	 * 例如设置了 OPENAI_API_KEY 但从未在 models.json 配置 openai 时，模型选择器会
	 * 冒出一整组未配置的 gpt 模型。这里以 models.json 为准做两层收敛：
	 * - 供应商不在配置中 → 整个剔除；
	 * - 供应商配置里显式列出了 models → 再按模型 id 收敛（pi 可能混入发现/缓存的多余模型）。
	 */
	async filterConfiguredModels(models: AvailableModel[]): Promise<AvailableModel[]> {
		const result = await this.getModelsConfig();
		const providers = result.parsed.providers ?? {};
		const allowedProviders = new Set(Object.keys(providers));
		if (allowedProviders.size === 0) return [];
		// 显式列出模型的供应商：仅放行清单内的 id
		const explicitModelIds = new Map<string, Set<string>>();
		for (const [provider, config] of Object.entries(providers)) {
			const ids = (config.models ?? [])
				.map((m) => m.id)
				.filter((id): id is string => typeof id === "string");
			if (ids.length > 0) explicitModelIds.set(provider, new Set(ids));
		}
		return models.filter((model) => {
			if (!allowedProviders.has(model.provider)) return false;
			const ids = explicitModelIds.get(model.provider);
			return !ids || ids.has(model.id);
		});
	}

	/** 回退：从 models.yml 解析为 PiModelsFile（简单缩进 YAML，不支持嵌套数组/对象以外的复杂结构） */
	private async readModelsYml(): Promise<ConfigFileReadResult<PiModelsFile>> {
		try {
			const ymlPath = join(this.configDir, "models.yml");
			const raw = await readFile(ymlPath, "utf-8");
			const parsed = this.parseSimpleYaml(raw);
			return { raw, parsed };
		} catch {
			return { raw: "", parsed: { providers: {} } };
		}
	}

	/**
	 * 解析 OMP models.yml（回退路径，仅 models.json 缺失时走）。
	 * 用真正的 YAML 解析器而非手写缩进解析：镜像现在包含 compat/thinking 等任意
	 * 深度的嵌套块，旧的两级缩进解析器会把嵌套字段误读成模型条目（例如 compat 下的
	 * `supportsReasoningEffort: true` 会被当成一个 id 叫这个名字的模型）。
	 * 解析失败按空配置处理（与旧实现 catch 后返回空的语义一致），绝不因 yml 异常
	 * 阻塞启动；脏数据逐条剔除而不是让整个文件读失败。
	 */
	private parseSimpleYaml(raw: string): PiModelsFile {
		const result: PiModelsFile = { providers: {} };
		try {
			const doc = parseDocument(raw);
			// yaml 的 parseDocument 有错误恢复能力：部分损坏的文件 toJS() 仍能给出未损坏
			// 部分。全有或全无地丢弃会让「手编 yml 手滑 + models.json 缺失」变成配置孤儿化
			// （迁移写会把空 providers 落进 models.json，此后永远读 json）。因此即使有解析
			// 错误也先尝试恢复内容，完全不可用才返回空。
			const js = doc.toJS() as unknown;
			const providers = (js as { providers?: unknown } | null)?.providers;
			if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
				return result;
			}
			for (const [name, providerValue] of Object.entries(providers as Record<string, unknown>)) {
				if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) {
					continue;
				}
				const provider = { ...(providerValue as Record<string, unknown>) };
				const models = Array.isArray(provider.models) ? provider.models : [];
				provider.models = models.filter(
					(model): model is PiModelItem =>
						!!model &&
						typeof model === "object" &&
						typeof (model as { id?: unknown }).id === "string",
					);
				result.providers[name] = provider as PiProviderConfig;
			}
			return result;
		} catch {
			return result;
		}
	}

	async getAuthConfig(): Promise<ConfigFileReadResult<PiAuthFile>> {
		const jsonPath = join(this.configDir, "auth.json");
		if (!existsSync(jsonPath)) {
			// 从 models.yml 提取 apiKey 回退
			const modelsResult = await this.readModelsYml();
			if (modelsResult.parsed.providers && Object.keys(modelsResult.parsed.providers).length > 0) {
				const auth: PiAuthFile = {};
				for (const [provider, config] of Object.entries(modelsResult.parsed.providers)) {
					if (config.apiKey) {
						auth[provider] = { type: "api_key", key: config.apiKey };
					}
				}
				return { raw: modelsResult.raw, parsed: auth };
			}
		}
		return this.readJsonFile<PiAuthFile>("auth.json", {});
	}

	async getSettingsConfig(): Promise<ConfigFileReadResult<PiSettings>> {
		return this.readJsonFile<PiSettings>("settings.json", {});
	}

	async getTrustConfig(): Promise<ConfigFileReadResult<Record<string, boolean>>> {
		const { entries, raw, ok } = await this.trustStore.readTrust();
		return ok
			? { raw, parsed: entries }
			: {
					raw,
					parsed: entries,
					diagnostic: {
						fileName: "trust.json",
						message: "trust.json 读取失败",
						docsUrl: "",
					},
				};
	}

	// ── 信任决策 / OMP 角色：直取 store ──────────────────
	// 原先在此逐个转发 trustStore/rolesStore 的方法（getTrustStore/getProjectTrustDecision/
	// readOmpModelRoles/...）：接口与实现等宽。现由消费方直取 this.trustStore / this.rolesStore；
	// 本类只保留有加工的逻辑（getTrustConfig 的读结果整形、export/import 打包）。


	// ── 保存（可视化表单） ────────────────────────────────
	async saveModelsConfig(data: PiModelsFile): Promise<ConfigValidationResult> {
		const validation = this.validateModels(data);
		if (!validation.valid) return validation;
		// 保存前统一迁移历史别名，确保写入 models.json 的 api 名称能被 pi 官方 registry 识别。
		const normalized = this.normalizeModelsForPi(data);
		await this.writeJsonFile("models.json", normalized);
		// 同步更新 models.yml 保持 OMP 配置一致。
		// 镜像失败不能吞：models.json 已落盘（OmpDeck 读它），而 pi 读的是 models.yml，
		// 静默失败会让两份表示分叉、pi 继续用旧配置。这里返回结构化提示让界面告知用户。
		const warnings: ConfigSaveWarning[] = [];
		try {
			await this.writeModelsYml(normalized);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			warnings.push({ code: "models-yml-mirror-failed", detail });
		}
		return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
	}

	/**
	 * 将 models 数据写成 OMP models.yml 格式。
	 *
	 * 必须是无损镜像：omp 运行时读的是这份 yml，models.json 只是 OmpDeck 侧的权威源。
	 * 只镜像标量字段的话，compat（含手工加的 reasoningEffortMap）、模型级 thinking、
	 * thinkingLevelMap、input 等扩展字段会在每次保存后从 yml 消失，用户在 omp 侧
	 * 生效的兼容配置被静默清掉（历史缺陷：MiniMax-M3 的 reasoning_effort 映射丢失后
	 * 会话 400）。因此除 models 数组外，所有字段都原样镜像。
	 */
	private async writeModelsYml(data: PiModelsFile): Promise<void> {
		const lines: string[] = ["providers:"];
		for (const [name, provider] of Object.entries(data.providers)) {
			if (!provider || typeof provider !== "object") continue;
			lines.push(`  ${this.escapeYmlKey(name)}:`);
			// 已知标量字段固定顺序在前（保证历史镜像 diff 稳定），扩展字段按对象键序随后
			this.pushYmlFields(lines, provider as Record<string, unknown>, "    ", ["baseUrl", "apiKey", "api"], ["models"]);
			const models = Array.isArray(provider.models) ? provider.models : [];
			if (models.length > 0) {
				lines.push(`    models:`);
				for (const model of models) {
					if (!model || typeof model !== "object" || typeof model.id !== "string") continue;
					lines.push(`      - id: ${this.escapeYmlValue(model.id)}`);
					this.pushYmlFields(
						lines,
						model as Record<string, unknown>,
						"        ",
						["id", "name", "reasoning", "contextWindow", "maxTokens"],
						["id"],
					);
				}
			}
		}
		// 原子替换：models.yml 是 omp 读取的镜像文件，截断的半个 YAML 会被 omp 当成损坏配置；
		// 失败语义不变（调用方 catch 后忽略）
		await this.jsonFile("models.yml").write(lines.join("\n") + "\n");
	}

	/**
	 * 按固定顺序输出对象字段：knownOrder 里的已知字段在前（与历史镜像逐字节一致），
	 * 其余扩展字段按对象键序跟在后面。skip 的字段由调用方专门处理（如 models 数组）。
	 */
	private pushYmlFields(
		lines: string[],
		source: Record<string, unknown>,
		indent: string,
		knownOrder: readonly string[],
		skip: readonly string[] = [],
	): void {
		const keys = Object.keys(source).filter((key) => !skip.includes(key));
		const ordered = [
			...knownOrder.filter((key) => keys.includes(key)),
			...keys.filter((key) => !knownOrder.includes(key)),
		];
		for (const key of ordered) {
			this.pushYmlEntry(lines, key, source[key], indent, false);
		}
	}

	/**
	 * 递归输出单个键值对。
	 *
	 * 顶层字段（nested=false）沿用历史 skip 规则：undefined/null/空串及空集合不落盘
	 * （比旧实现更无损的一点是 false/0 现在会落盘，UI 勾选框提交 reasoning:false 时
	 * 不再丢失）。嵌套字段（nested=true，如 compat/thinkingLevelMap 内部）只跳过
	 * undefined：false/0/null 都有语义——compat 布尔开关必须显式落盘，thinkingLevelMap 的
	 * null 表示「禁用该档位映射」。
	 * 数组一律用 JSON flow 风格：JSON 是 YAML 1.2 flow 的子集，转义交给
	 * JSON.stringify，避免手写数组转义漏掉逗号/引号。
	 */
	private pushYmlEntry(
		lines: string[],
		key: string,
		value: unknown,
		indent: string,
		nested: boolean,
	): void {
		if (value === undefined) return;
		if (!nested && (value === null || value === "")) return;
		if (Array.isArray(value)) {
			if (value.length === 0) return;
			lines.push(`${indent}${this.escapeYmlKey(key)}: ${JSON.stringify(value)}`);
			return;
		}
		if (value !== null && typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>).filter(
				([, childValue]) => childValue !== undefined,
			);
			if (entries.length === 0) return;
			lines.push(`${indent}${this.escapeYmlKey(key)}:`);
			for (const [childKey, childValue] of entries) {
				this.pushYmlEntry(lines, childKey, childValue, `${indent}  `, true);
			}
			return;
		}
		if (value === null) {
			lines.push(`${indent}${this.escapeYmlKey(key)}: null`);
			return;
		}
		lines.push(`${indent}${this.escapeYmlKey(key)}: ${this.escapeYmlValue(value as string | number | boolean)}`);
	}

	private escapeYmlKey(key: string): string {
		// 与 escapeYmlValue 同规则并用 JSON.stringify 包裹：递归镜像后任意用户键（compat
		// 子键、扩展字段名）都会流经这里，键名以 YAML 指示符开头（如 `*weird`、`- item`）
		// 会让整份 yml 解析报错甚至静默结构腐蚀；顺带修复内嵌引号/换行
		return /[:\[\]{}#"']|\s|^$|^[-?&*!%@`|>,]/.test(key) ? JSON.stringify(key) : key;
	}

	private escapeYmlValue(value: string | number | boolean): string {
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		// YAML 指示符开头（含 flow 指示符 `,`）的裸标量会被解析成别名/锚点/块标量等，
		// 一律加引号；其余沿用历史规则（含冒号/括号/引号/空白才转义）
		if (/[:\[\]{}#"']|\s|^$|^[-?&*!%@`|>,]/.test(value)) return JSON.stringify(value);
		// YAML 1.2 core schema 会把 null/布尔/数字样式的裸标量解析成非字符串；不引号的话
		// 字符串 id "20250101" 回读变成 number，会被 parseSimpleYaml 的字符串 id 过滤
		// 剔除，经 models.json 迁移写后模型被永久丢失
		if (/^(~|null|true|false)$/i.test(value)) return JSON.stringify(value);
		if (/^[-+]?\.?\d/.test(value) && !Number.isNaN(Number(value))) return JSON.stringify(value);
		return value;
	}

	private normalizeModelsForPi(data: PiModelsFile): PiModelsFile {
		return {
			...data,
			providers: Object.fromEntries(
				Object.entries(data.providers).map(([name, provider]) => [
					name,
					{
						...provider,
						api: normalizeApiType(provider.api),
						models: provider.models.map((model) => ({
							...model,
							api: typeof model.api === "string"
								? normalizeApiType(model.api)
								: model.api,
						})),
					},
				]),
			),
		};
	}


	async saveAuthConfig(data: PiAuthFile): Promise<ConfigValidationResult> {
		await this.writeJsonFile("auth.json", data);
		// 同步更新 models.json 中的 apiKey，确保 OMP models.yml 与 auth 一致
		try {
			const modelsPath = join(this.configDir, "models.json");
			if (existsSync(modelsPath)) {
				const modelsRaw = await readFile(modelsPath, "utf-8");
				const models = JSON.parse(modelsRaw) as PiModelsFile;
				let changed = false;
				for (const [provider, authEntry] of Object.entries(data)) {
					if (models.providers[provider] && authEntry.key) {
						models.providers[provider].apiKey = authEntry.key;
						changed = true;
					}
				}
				if (changed) await this.writeJsonFile("models.json", models);
			}
		} catch {
			// 同步失败不影响 auth 保存
		}
		return { valid: true };
	}

	async saveSettingsConfig(
		settings: PiSettings,
	): Promise<ConfigValidationResult> {
		await this.writeJsonFile("settings.json", settings);
		return { valid: true };
	}

	// ── omp 权威全局配置 config.yml ─────────────────────
	// 当前 omp 以 ~/.omp/agent/config.yml（YAML）为全局 settings 权威源，
	// settings.json 只是历史迁移遗留、不再被读取；模型角色（modelRoles）与
	// 默认思考等级必须写 config.yml 才会生效。config.yml 的读写与原子单文档写
	// 收敛于 OmpRolesStore（原两次串行全文件 RMW 的撕裂窗口在此关闭）；消费方
	// 直取 this.rolesStore（configureWsl 切换 home 时经 accessor 现取 configDir，指针跟随）。
	// 本类保留的唯一角色相关逻辑是 export/import 的打包（见下方）。

	// ── 保存（源文件编辑） ────────────────────────────────

	async saveRawConfig(
		fileName: string,
		rawJson: string,
	): Promise<ConfigValidationResult> {
		try {
			JSON.parse(rawJson);
		} catch (e) {
			return {
				valid: false,
				error: `JSON 格式错误：${e instanceof Error ? e.message : String(e)}`,
			};
		}

		const allowed = ["models.json", "auth.json", "settings.json", "trust.json"];
		if (!allowed.includes(fileName)) {
			return { valid: false, error: `不允许编辑的文件：${fileName}` };
		}

		await this.writeJsonFile(fileName, rawJson);
		// models.json 原始编辑后同步更新 models.yml（与表单保存同一处理：失败要可见）
		if (fileName === "models.json") {
			try {
				const data = JSON.parse(rawJson) as PiModelsFile;
				await this.writeModelsYml(data);
			} catch (error) {
				return {
					valid: true,
					warnings: [
						{
							code: "models-yml-mirror-failed",
							detail: error instanceof Error ? error.message : String(error),
						},
					],
				};
			}
		}
		return { valid: true };
	}

	// ── 校验 ──────────────────────────────────────────────

	private validateModels(data: PiModelsFile): ConfigValidationResult {
		if (!data.providers || typeof data.providers !== "object") {
			return { valid: false, error: "models.json 缺少 providers 字段" };
		}
		for (const [providerName, config] of Object.entries(data.providers)) {
			if (!config.models || !Array.isArray(config.models)) {
				return {
					valid: false,
					error: `provider "${providerName}" 缺少 models 数组`,
				};
			}
			for (let i = 0; i < config.models.length; i++) {
				const m = config.models[i];
				if (!m.id || typeof m.id !== "string") {
					return {
						valid: false,
						error: `provider "${providerName}" 的模型 #${i + 1} 缺少有效的 id`,
					};
				}
			}
		}
		return { valid: true };
	}

	// ── 文件 IO ───────────────────────────────────────────

	/** JSON 文件的原文 store（惰性按路径缓存：configureWsl 切换 home 后指针跟随）。 */
	private jsonFile(fileName: string): JsonFileStore<string> {
		const filePath = join(this.configDir, fileName);
		const existing = this.jsonFiles.get(filePath);
		if (existing) return existing;
		const created = JsonFileStore.text(filePath);
		this.jsonFiles.set(filePath, created);
		return created;
	}

	private async readJsonFile<T>(
		fileName: string,
		fallback: T,
	): Promise<ConfigFileReadResult<T>> {
		let raw: string | null;
		try {
			raw = await this.jsonFile(fileName).readRaw();
		} catch {
			// 读失败（权限等）按文件缺失处理：与原 catch 语义一致
			return { raw: JSON.stringify(fallback, null, 2), parsed: fallback };
		}
		if (raw === null) {
			return { raw: JSON.stringify(fallback, null, 2), parsed: fallback };
		}
		try {
			const parsed = JSON.parse(raw) as T;
			return { raw, parsed };
		} catch (error) {
			// 配置 JSON 写错时，配置弹窗仍要能打开 Raw 页让用户修复；同时返回精确诊断用于 UI 提示。
			return {
				raw,
				parsed: fallback,
				diagnostic: this.createJsonDiagnostic(fileName, raw, error),
			};
		}
	}

	private createJsonDiagnostic(
		fileName: string,
		raw: string,
		error: unknown,
	): ConfigFileDiagnostic {
		const message = error instanceof Error ? error.message : String(error);
		const positionMatch = message.match(/position\s+(\d+)/i);
		const position = positionMatch ? Number(positionMatch[1]) : undefined;
		let line: number | undefined;
		let column: number | undefined;
		let snippet: string | undefined;
		if (Number.isFinite(position)) {
			const before = raw.slice(0, position);
			const lines = before.split(/\r?\n/);
			line = lines.length;
			column = lines[lines.length - 1].length + 1;
			const rawLines = raw.split(/\r?\n/);
			const start = Math.max(0, line - 2);
			const end = Math.min(rawLines.length, line + 1);
			snippet = rawLines
				.slice(start, end)
				.map((text, index) => `${start + index + 1}: ${text}`)
				.join("\n");
		}
		return {
			fileName,
			message,
			line,
			column,
			snippet,
			docsUrl: this.docsUrlForFile(fileName),
		};
	}

	private docsUrlForFile(fileName: string) {
		if (fileName === "models.json") return "https://pi.dev/docs/latest/models";
		if (fileName === "settings.json") return "https://pi.dev/docs/latest/settings";
		return "https://pi.dev/docs/latest/providers";
	}

	private async writeJsonFile(
		fileName: string,
		content: unknown,
	): Promise<void> {
		const json =
			typeof content === "string" ? content : JSON.stringify(content, null, 2);
		// 原子替换：写一半失败/并发保存不会让 Raw 页读到截断的 JSON
		await this.jsonFile(fileName).write(json);
	}

	// ── 远程拉取模型列表 ─────────────────────────────────

	/**
	 * 向 provider 拉取可用模型列表。
	 * 对优先路径尝试失败后自动回退到备选路径，提升对各厂商端点格式差异的容错。
	 */
	async fetchProviderModels(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
		requestHeaders?: Record<string, string>,
	): Promise<{
		success: boolean;
		models?: Array<{ id: string; name?: string }>;
		error?: string;
		/** 实际成功/最后一次请求的 URL（脱敏），用于 UI 对比会话侧路径 */
		requestUrl?: string;
		/** 检测侧补了版本路径，而配置 baseUrl 仍是根路径 → 会话可能 404 */
		sessionBaseUrlNeedsVersion?: boolean;
		/** 建议写入配置的 baseUrl（含 /v1 等）；UI 可自动改写 */
		suggestedBaseUrl?: string;
	}> {
		const requests = buildModelsRequest(baseUrl, apiKey, apiType, requestHeaders);
		let lastError: string | undefined;
		let lastRequestUrl: string | undefined;

		for (const request of requests) {
			lastRequestUrl = redactDiagnostics(request.url, apiKey);
			try {
				const controller = new AbortController();
				// 10 秒超时，避免网络不通时长时间卡住
				const timeout = setTimeout(() => controller.abort(), 10_000);

				try {
					// 桌面端配置检测属于 Electron 主进程自身请求；使用 net.fetch 才能走 defaultSession 的代理配置。
					const res = await net.fetch(request.url, {
						method: request.method ?? "GET",
						headers: request.headers,
						signal: controller.signal,
					});

					if (!res.ok) {
						lastError = `HTTP ${res.status}: ${res.statusText}`;
						continue;
					}

					const body = (await res.json()) as Record<string, unknown>;
					const models = parseModelsResponse(body, apiType);

					if (models.length === 0) {
						lastError = "接口返回了空的模型列表";
						continue;
					}

					// 成功路径若依赖检测侧自动补 /v1，而用户配置仍是根路径，
					// 会话侧会原样用 baseUrl → 返回建议 baseUrl 供 UI 自动改写。
					const { needsVersion: sessionBaseUrlNeedsVersion, suggestedBaseUrl } =
						sessionBaseUrlHint(baseUrl, request.url, apiType ?? "");
					return {
						success: true,
						models,
						requestUrl: lastRequestUrl,
						sessionBaseUrlNeedsVersion,
						suggestedBaseUrl,
					};
				} finally {
					clearTimeout(timeout);
				}
			} catch (e) {
				lastError = redactDiagnostics(
					e instanceof Error
						? e.name === "AbortError"
							? "请求超时，请检查网络或 baseUrl"
							: e.message
						: String(e),
					apiKey,
				);
			}
		}

		return {
			success: false,
			error: lastError ?? "获取模型列表失败",
			requestUrl: lastRequestUrl,
			sessionBaseUrlNeedsVersion: sessionBaseUrlHint(baseUrl, lastRequestUrl ?? "", apiType ?? "")
				.needsVersion,
		};
	}


	// ── 快速测试连接 ─────────────────────────────────────


	async testProviderConnection(
		baseUrl: string,
		apiKey: string,
		modelId: string,
		apiType?: string,
		requestHeaders?: Record<string, string>,
	): Promise<{
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
		requestUrl?: string;
		requestBody?: string;
		/** 检测侧补了 /v1，配置仍是根路径 → 会话侧可能失败 */
		sessionBaseUrlNeedsVersion?: boolean;
		/** 建议写入配置的 baseUrl；仅 success 时由 UI 自动改写 */
		suggestedBaseUrl?: string;
	}> {
		const startedAt = Date.now();
		const api = normalizeApiType(apiType);
		const { url: requestUrl, headers, body: requestBody } = buildTestRequest(
			baseUrl,
			apiKey,
			modelId,
			api,
			requestHeaders,
		);
		const safeRequestUrl = redactDiagnostics(requestUrl, apiKey);
		const safeRequestBody = redactDiagnostics(requestBody, apiKey);
		// 与 fetch 一致：检测用了补齐路径、配置仍是根路径时给出建议 baseUrl。
		const { needsVersion: sessionBaseUrlNeedsVersion, suggestedBaseUrl } =
			sessionBaseUrlHint(baseUrl, requestUrl, api);

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);

			let res: Awaited<ReturnType<typeof net.fetch>>;
			try {
				res = await net.fetch(requestUrl, {
					method: "POST",
					headers,
					body: requestBody,
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			const latencyMs = Date.now() - startedAt;

			if (!res.ok) {
				let detail = `${res.status} ${res.statusText}`;
				try {
					const errBody = (await res.json()) as Record<string, unknown>;
					detail += extractHttpErrorDetail(errBody);
				} catch {
					/* 忽略解析错误 */
				}
				// 失败时不自动改写 baseUrl，只保留诊断字段。
				return {
					success: false,
					error: redactDiagnostics(detail, apiKey),
					latencyMs,
					requestUrl: safeRequestUrl,
					requestBody: safeRequestBody,
					sessionBaseUrlNeedsVersion,
				};
			}

			const body = (await res.json()) as Record<string, unknown>;
			const parsed = parseTestResponse(body, modelId, api);

			return {
				success: true,
				...parsed,
				latencyMs,
				requestUrl: safeRequestUrl,
				requestBody: safeRequestBody,
				sessionBaseUrlNeedsVersion,
				suggestedBaseUrl,
			};
		} catch (e) {
			const latencyMs = Date.now() - startedAt;
			const msg = connectionErrorMessage(e, PROVIDER_TEST_TIMEOUT_SECONDS);
			return {
				success: false,
				error: redactDiagnostics(msg, apiKey),
				latencyMs,
				requestUrl: safeRequestUrl,
				requestBody: safeRequestBody,
				sessionBaseUrlNeedsVersion,
			};
		}
	}

	// ── 导出 / 导入 ───────────────────────────────────────

	/** 将配置文件打包为单个 JSON 对象，便于用户备份和迁移（含信任决策与模型角色）。 */
	async exportConfig(): Promise<string> {
		const [models, auth, settings] = await Promise.all([
			this.readJsonFile<PiModelsFile>("models.json", { providers: {} }),
			this.readJsonFile<PiAuthFile>("auth.json", {}),
			this.readJsonFile<PiSettings>("settings.json", {}),
		]);
		const trust = await this.getTrustConfig();
		const roles = await this.rolesStore.readRolesState();
		const defaultLevel = await this.rolesStore.readDefaultThinkingLevel();
		return JSON.stringify(
			{
				version: 1,
				exportedAt: new Date().toISOString(),
				files: {
					"models.json": models.parsed,
					"auth.json": auth.parsed,
					"settings.json": settings.parsed,
					// Q31：导出无声丢失的信任决策与 OMP 角色补上。config.yml 只取两个
					// schema 槽位（modelRoles/defaultThinkingLevel），omp 自有键不动。
					"trust.json": trust.parsed,
					"config.yml": {
						modelRoles: Object.fromEntries(
							Object.entries(roles)
								.filter(([, assignment]) => assignment.selector)
								.map(([role, assignment]) => [role, assignment.selector]),
						),
						...(defaultLevel ? { defaultThinkingLevel: defaultLevel } : {}),
					},
				},
			},
			null,
			2,
		);
	}
	async importConfig(
		packageJson: string,
	): Promise<ConfigValidationResult> {
		let pkg: unknown;
		try {
			pkg = JSON.parse(packageJson);
		} catch (e) {
			return {
				valid: false,
				error: `JSON 格式错误：${e instanceof Error ? e.message : String(e)}`,
			};
		}
		const data = pkg as Record<string, unknown>;
		const files = data.files as Record<string, unknown> | undefined;
		if (!files || typeof files !== "object") {
			return { valid: false, error: "导入文件缺少 files 字段，请确认是 OmpDeck 导出的配置包" };
		}

		// 按需写入，只处理已知文件名，忽略其他 key（旧包无新键 = 原样恢复三 JSON）
		const allowed: Array<[string, string]> = [
			["models.json", "models.json"],
			["auth.json", "auth.json"],
			["settings.json", "settings.json"],
		];
		for (const [key, fileName] of allowed) {
			if (files[key] != null) {
				await this.writeJsonFile(fileName, files[key]);
			}
		}
		const trustEntries = files["trust.json"];
		if (trustEntries && typeof trustEntries === "object" && !Array.isArray(trustEntries)) {
			const validEntries: Record<string, boolean> = {};
			for (const [pathKey, decision] of Object.entries(trustEntries)) {
				if (typeof pathKey === "string" && (decision === true || decision === false)) {
					validEntries[pathKey] = decision;
				}
			}
			if (Object.keys(validEntries).length > 0) {
				await this.trustStore.importEntries(validEntries);
			}
		}
		const ompConfig = files["config.yml"];
		if (ompConfig && typeof ompConfig === "object" && !Array.isArray(ompConfig)) {
			const result = await this.rolesStore.importPackage(ompConfig);
			if (!result.valid) return result;
		}
		return { valid: true };
	}
}
