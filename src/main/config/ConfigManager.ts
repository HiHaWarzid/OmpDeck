import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { normalize, join, dirname } from "node:path";
import { dirname as posixDirname, normalize as posixNormalize } from "node:path/posix";
import { homedir } from "node:os";
import { net } from "electron";
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
import { OmpConfigFile } from "./OmpConfigFile";
import { OmpRolesStore } from "./OmpRolesStore";
import { TrustStore } from "./TrustStore";
import { JsonFileStore } from "../storage/JsonFileStore";
import { ompSettingsPatchFromPackage, pickOmpSettings } from "../../shared/ompConfigSettings";
import { isMap, isScalar, parseDocument } from "yaml";
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

// ── Auth 视图结构 ─────────────────────────────────────
// Auth 页的唯一落盘目标是 models.yml 的 providers.<name>.apiKey（omp 凭据解析的
// 第一优先级）。这里只给渲染层一个扁平的 { provider: { key } } 视图，不再模拟
// omp 18 已废弃的 auth.json type/oauth 字段。

export type PiAuthItem = {
	key?: string;
};

export type PiAuthFile = Record<string, PiAuthItem>;

// ── config.yml ────────────────────────────────────────
// omp 的全局设置权威源；读写收敛在 OmpConfigFile（原文/点路径补丁）与
// OmpRolesStore（modelRoles）。settings.json 只是历史迁移残留，本类不再写它。

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
 * 管理 omp 全局配置文件（~/.omp/agent/ 下的 models.yml、models.json、trust.json、
 * config.yml）。models.yml 是含凭据的权威模型配置，models.json 是其兼容镜像；
 * config.yml 是 YAML 设置权威源（见 OmpConfigFile）。
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
	/**
	 * config.yml 通用读写（原文 + 点路径补丁），configDir 经 accessor 注入。
	 * 公开只读：设置页的键级写入由 OmpConfigFile 承担（与 rolesStore 共享路径队列）。
	 */
	readonly ompConfig: OmpConfigFile;
	/** models.json 的原子写与读指纹 store（原文）；configDir 可切换，按完整路径缓存。 */
	private readonly jsonFiles = new Map<string, JsonFileStore<string>>();

	constructor(configDir?: string) {
		this.configDir = configDir ?? PI_AGENT_DIR;
		this.rolesStore = new OmpRolesStore({ resolveConfigDir: () => this.configDir });
		this.trustStore = new TrustStore({ resolveConfigDir: () => this.configDir });
		this.ompConfig = new OmpConfigFile({ resolveConfigDir: () => this.configDir });
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
				// 「用户手编 yml 暂不可读」固化成永久空配置（孤儿化）。有解析诊断时
				// 同样不迁移：部分恢复的数据写进 json 后会在 yml 修好前抢先成为读源。
				if (!ymlResult.diagnostic && Object.keys(ymlResult.parsed.providers).length > 0) {
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
	 * 读取 omp 真正生效的模型配置。
	 *
	 * omp 18 的 models.yml 是权威源，models.json 只是 OmpDeck 的镜像。Auth 编辑和
	 * 导出必须基于 yml，否则会拿旧的 json 覆盖用户刚在 yml 里改过的 key/字段。
	 * yml 缺失时才回退 json（首次安装/旧版本迁移）。
	 */
	private async readAuthoritativeModels(): Promise<ConfigFileReadResult<PiModelsFile>> {
		if (existsSync(join(this.configDir, "models.yml"))) {
			return this.readModelsYml();
		}
		return this.readJsonFile<PiModelsFile>("models.json", { providers: {} });
	}

	/** 读取 models.yml 并解析；解析/读取失败只降级为空配置，但必须把原因交给调用方展示。 */
	private async readModelsYml(): Promise<ConfigFileReadResult<PiModelsFile>> {
		try {
			const ymlPath = join(this.configDir, "models.yml");
			const raw = await readFile(ymlPath, "utf-8");
			const parsed = this.parseSimpleYaml(raw);
			const errors = parseDocument(raw).errors;
			return errors.length > 0
				? {
						raw,
						parsed,
						diagnostic: {
							fileName: "models.yml",
							message: `models.yml 解析失败：${errors[0].message}`,
							docsUrl: "",
						},
					}
				: { raw, parsed };
		} catch (error) {
			return {
				raw: "",
				parsed: { providers: {} },
				diagnostic: {
					fileName: "models.yml",
					message: `models.yml 读取失败：${error instanceof Error ? error.message : String(error)}`,
					docsUrl: "",
				},
			};
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
		const models = await this.readAuthoritativeModels();
		const auth: PiAuthFile = {};
		for (const [provider, config] of Object.entries(models.parsed.providers ?? {})) {
			// models.json 可能是用户手编的；provider 值不是对象时跳过，不能让坏数据
			// 把整个 Auth 页读崩（yml 路径的 parseSimpleYaml 已过滤，json 路径没有）。
			if (!config || typeof config !== "object") continue;
			if (typeof config.apiKey === "string" && config.apiKey.trim()) {
				auth[provider] = { key: config.apiKey };
			}
		}
		return {
			raw: models.raw,
			parsed: auth,
			...(models.diagnostic ? { diagnostic: models.diagnostic } : {}),
		};
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


	/**
	 * 自愈：上游明确拒绝 OpenAI 的 `developer` 角色时，把指定 provider 的
	 * `compat.supportsDeveloperRole` 显式写成 false（json + yml 一起），
	 * 让下一次进程启动不再发送该角色。
	 *
	 * 只在该 provider 存在且当前值不是 false 时写盘；yml 解析有诊断时拒绝写，
	 * 避免用一份不完整的数据覆盖用户手写配置。
	 */
	async disableDeveloperRole(providerName: string): Promise<boolean> {
		if (!providerName) return false;
		const models = await this.readAuthoritativeModels();
		if (models.diagnostic) return false;
		const provider = models.parsed.providers?.[providerName];
		if (!provider || typeof provider !== "object") return false;
		const compat =
			provider.compat && typeof provider.compat === "object"
				? (provider.compat as Record<string, unknown>)
				: {};
		if (compat.supportsDeveloperRole === false) return false;

		const result = await this.saveModelsConfig({
			...models.parsed,
			providers: {
				...models.parsed.providers,
				[providerName]: {
					...provider,
					compat: { ...compat, supportsDeveloperRole: false },
				},
			},
		});
		if (!result.valid) {
			throw new Error(result.error ?? "保存 supportsDeveloperRole=false 失败");
		}
		return true;
	}

	// ── 保存（可视化表单） ────────────────────────────────
	async saveModelsConfig(data: PiModelsFile): Promise<ConfigValidationResult> {
		const validation = this.validateModels(data);
		if (!validation.valid) return validation;
		// 保存前统一迁移历史别名，确保写入 models.json 的 api 名称能被 pi 官方 registry 识别。
		const normalized = this.normalizeModelsForPi(data);
		await this.writeJsonFile("models.json", normalized);
		const warnings: ConfigSaveWarning[] = [];
		// 同步更新 models.yml 保持 OMP 配置一致。
		// 镜像失败不能吞：models.json 已落盘（OmpDeck 读它），而 pi 读的是 models.yml，
		// 静默失败会让两份表示分叉、pi 继续用旧配置。这里返回结构化提示让界面告知用户。
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


	/**
	 * Auth 页保存：只改 providers.<name>.apiKey，落盘目标是 omp 的 models.yml。
	 *
	 * 三个关键约束：
	 * 1. 读-改-写基于 models.yml 而不是 models.json：omp 18 只认 yml，json 可能是旧镜像。
	 * 2. yml 存在时用 YAML Document 原位 patch，保留用户的注释和其它手工字段；解析失败
	 *    直接拒绝保存，避免把损坏文件重写成半份配置。
	 * 3. `apiKey` 可以是环境变量名或 `!command`，原样保存，不做 prefix/类型判断。
	 *
	 * 删除语义：Auth 页展示的是 yml 里所有非空 apiKey，因此提交数据中缺席的 provider
	 * 视为“清空该 provider 的 key”（provider 本身及 models/baseUrl 保留），因此
	 * models.json 镜像里的 apiKey 也会同步消失。
	 */
	async saveAuthConfig(data: PiAuthFile): Promise<ConfigValidationResult> {
		const ymlPath = join(this.configDir, "models.yml");
		const ymlExists = existsSync(ymlPath);
		let ymlText: string | null = null;
		let base: PiModelsFile;
		if (ymlExists) {
			try {
				ymlText = await readFile(ymlPath, "utf-8");
			} catch (error) {
				return {
					valid: false,
					error: `读取 models.yml 失败：${error instanceof Error ? error.message : String(error)}`,
				};
			}
			base = this.parseSimpleYaml(ymlText);
		} else {
			base = (await this.getModelsConfig()).parsed;
		}

		// 以 yml 当前内容为基线，构建下一版 providers；只动 apiKey，不碰 models/compat。
		const providers: Record<string, PiProviderConfig> = { ...(base.providers ?? {}) };
		const requested = new Set<string>();
		for (const [name, entry] of Object.entries(data)) {
			const key = typeof entry?.key === "string" ? entry.key : "";
			if (!key.trim()) continue;
			requested.add(name);
			const existing = providers[name];
			providers[name] = {
				...(existing && typeof existing === "object" && !Array.isArray(existing)
					? existing
					: { models: [] }),
				apiKey: key,
			};
		}
		for (const [name, provider] of Object.entries(providers)) {
			if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
			if (requested.has(name) || typeof provider.apiKey !== "string") continue;
			const nextProvider = { ...provider };
			delete nextProvider.apiKey;
			providers[name] = nextProvider;
		}

		try {
			if (ymlText !== null) {
				const doc = parseDocument(ymlText);
				if (doc.errors.length > 0) {
					return {
						valid: false,
						error: `models.yml 解析失败：${doc.errors[0].message}。请先在原始文件页修复后重试。`,
					};
				}
				// `providers:`（显式 null）或空文件是合法的 omp 初始状态；不先补成映射，
				// setIn 会抛 “Expected YAML collection at providers”。反过来，providers
				// 已是标量/数组时不能静默替换，否则会抹掉用户文件内容。
				const providersNode = doc.get("providers", true);
				// 显式 `providers:` / `providers: null` 会被 yaml 解析成 value=null 的
				// Scalar 节点，而不是 undefined；两者都按空映射处理。
				if (providersNode === undefined || (isScalar(providersNode) && providersNode.value == null)) {
					doc.set("providers", doc.createNode({}));
				} else if (!isMap(providersNode)) {
					return {
						valid: false,
						error: "models.yml 的 providers 必须是映射，请先在原始文件页修复后重试。",
					};
				}
				for (const [name, provider] of Object.entries(providers)) {
					const key = typeof provider.apiKey === "string" ? provider.apiKey : undefined;
					// `openai:` / `openai: null` 是合法的空 provider 声明，yaml 解析为
					// Scalar(null)，直接 setIn 会抛 “Expected YAML collection”。补成映射再写。
					const providerNode = doc.getIn(["providers", name], true);
					if (
						providerNode === undefined ||
						(isScalar(providerNode) && providerNode.value == null)
					) {
						doc.setIn(["providers", name], doc.createNode({}));
					} else if (!isMap(providerNode)) {
						return {
							valid: false,
							error: `models.yml 的 providers.${name} 必须是映射，请先在原始文件页修复后重试。`,
						};
					}
					if (key !== undefined) {
						doc.setIn(["providers", name, "apiKey"], key);
					} else if (doc.hasIn(["providers", name, "apiKey"])) {
						doc.deleteIn(["providers", name, "apiKey"]);
					}
				}
				const nextText = doc.toString();
				await this.jsonFile("models.yml").write(
					nextText.endsWith("\n") ? nextText : `${nextText}\n`,
				);
			} else {
				await this.writeModelsYml({ providers });
			}
		} catch (error) {
			return {
				valid: false,
				error: `保存 models.yml 失败：${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const warnings: ConfigSaveWarning[] = [];
		try {
			// models.json 是 OmpDeck 的读镜像：整份写成 yml 的视图，避免旧 key/旧字段
			// 在 Models 页继续出现，之后整表保存又把过期内容盖回 yml。
			await this.writeJsonFile("models.json", { providers });
		} catch (error) {
			warnings.push({
				code: "models-json-mirror-failed",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
		return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
	}

	// ── omp 权威全局配置 config.yml ─────────────────────
	// 当前 omp 以 ~/.omp/agent/config.yml（YAML）为全局 settings 权威源，
	// settings.json 只是历史迁移遗留、不再被读取。config.yml 的读写收敛于
	// this.ompConfig（原文 / 点路径补丁）与 this.rolesStore（modelRoles），
	// 两者共享 JsonFileStore 的按路径队列，不会互相覆盖。本类保留的
	// config.yml 相关逻辑只有 export/import 的打包（见下方）。

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

		// config.yml 不在此列：它是 YAML，走 config.saveOmpConfigRaw（校验映射后原子写）
		const allowed = ["models.json", "trust.json"];
		if (!allowed.includes(fileName)) {
			return { valid: false, error: `不允许编辑的文件：${fileName}` };
		}

		await this.writeJsonFile(fileName, rawJson);
		// models.json 原始编辑后同步更新 models.yml（与表单保存同一处理：失败要可见）
		if (fileName === "models.json") {
			const warnings: ConfigSaveWarning[] = [];
			// JSON.parse 提到 try 外：避免重复解析同一份字符串，且只在这一个
			// 失败点返回错误——后续 yml 同步的因果就清晰了。
			let data: PiModelsFile;
			try {
				data = JSON.parse(rawJson) as PiModelsFile;
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					valid: true,
					warnings: [{ code: "models-yml-mirror-failed", detail }],
				};
			}
			try {
				await this.writeModelsYml(data);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				warnings.push({ code: "models-yml-mirror-failed", detail });
			}
			return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
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

	/**
	 * 导出包不携带任何明文凭据。
	 *
	 * `apiKey` 可能是用户直接粘贴的密钥，把它塞进可分享/可上传的 JSON 包是明确的
	 * 泄露路径；环境变量名和 `!command` 引用虽然不敏感，但一并省略能让导出格式
	 * 规则简单（导入时保留目标机器已有的 key）。
	 */
	private withoutModelCredentials(data: PiModelsFile): PiModelsFile {
		return {
			...data,
			providers: Object.fromEntries(
				Object.entries(data.providers ?? {}).map(([name, provider]) => {
					if (!provider || typeof provider !== "object") return [name, provider];
					const { apiKey: _apiKey, ...rest } = provider;
					return [name, rest as PiProviderConfig];
				}),
			),
		};
	}

	/** 将配置文件打包为单个 JSON 对象，便于用户备份和迁移（含信任决策与模型角色）。 */
	async exportConfig(): Promise<string> {
		// 以 omp 实际读取的 models.yml 为准，避免把旧 models.json 镜像导出。
		const models = await this.readAuthoritativeModels();
		const trust = await this.getTrustConfig();
		const roles = await this.rolesStore.readRolesState();
		const defaultLevel = await this.rolesStore.readDefaultThinkingLevel();
		const presets = await this.rolesStore.readModelPresets();
		const cycleOrder = await this.rolesStore.readCycleOrder();
		const fallbackChains = await this.rolesStore.readFallbackChains();
		const providerOrder = await this.rolesStore.readProviderOrder();
		const roleStorage = await this.rolesStore.readRoleStorage();
		const ompConfig = await this.ompConfig.read();
		const settings = pickOmpSettings(ompConfig.parsed);
		const existingRetry =
			settings.retry && typeof settings.retry === "object" && !Array.isArray(settings.retry)
				? (settings.retry as Record<string, unknown>)
				: {};
		const exportedRetry = {
			...existingRetry,
			...(Object.keys(fallbackChains).length > 0 ? { fallbackChains } : {}),
		};
		return JSON.stringify(
			{
				version: 1,
				exportedAt: new Date().toISOString(),
				files: {
					"models.json": this.withoutModelCredentials(models.parsed),
					// 设置权威源是 config.yml；settings.json 已不被 omp 读取，不再进包。
					"trust.json": trust.parsed,
					// config.yml 只取设置页可编辑键 + modelRoles/modelPresets/cycleOrder/
					// fallbackChains/defaultThinkingLevel，omp 自有键（含可能带凭据的
					// auth.broker.*）不动、不入包。
					"config.yml": {
						...settings,
						modelRoles: Object.fromEntries(
							Object.entries(roles)
								.filter(([, assignment]) => assignment.selector)
								.map(([role, assignment]) => [role, assignment.selector]),
						),
						...(defaultLevel ? { defaultThinkingLevel: defaultLevel } : {}),
						...(Object.keys(presets).length > 0 ? { modelPresets: presets } : {}),
						...(cycleOrder.length > 0 ? { cycleOrder } : {}),
						...(providerOrder.length > 0 ? { modelProviderOrder: providerOrder } : {}),
						...(roleStorage === "project" ? { modelRoleStorage: roleStorage } : {}),
						...(Object.keys(exportedRetry).length > 0
							? { retry: exportedRetry }
							: {}),
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

		const rawOmpConfig = files["config.yml"];
		const ompConfig =
			rawOmpConfig && typeof rawOmpConfig === "object" && !Array.isArray(rawOmpConfig)
				? (rawOmpConfig as Record<string, unknown>)
				: undefined;
		// 预检现有 config.yml：角色与设置键是两次文档写入，文件已损坏时第二次写入
		// 会在第一次成功后才失败，用户看到「导入失败」但配置只落了一半。这里在
		// 任何写入（含 models/auth/trust）之前先确认现有文件可解析，损坏则整包放弃。
		if (ompConfig) {
			const existing = await this.ompConfig.read();
			if (existing.diagnostic) {
				return { valid: false, error: existing.diagnostic.message };
			}
		}

		// 只处理已知文件名，忽略其他 key（旧包里的 settings.json 不再恢复：
		// omp 不读它，写回反而会在 config.yml 缺失时被当成设置迁移过去）。
		// 旧包里的 auth.json 同样忽略：凭据只认 models.yml，避免恢复成无效文件。
		const warnings: ConfigSaveWarning[] = [];
		const rawModels = files["models.json"];
		if (rawModels !== undefined) {
			if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
				return { valid: false, error: "导入包的 models.json 格式无效" };
			}
			const incoming = rawModels as PiModelsFile;
			if (
				!incoming.providers ||
				typeof incoming.providers !== "object" ||
				Array.isArray(incoming.providers)
			) {
				return { valid: false, error: "导入包的 models.json 缺少 providers 对象" };
			}
			const existing = await this.readAuthoritativeModels();
			// 损坏的 models.yml 不能作为合并基线：继续写会先静默丢掉文件里恢复不了的
			// 字段/注释，再覆盖掉用户本可手工修复的内容。
			if (existing.diagnostic) {
				return { valid: false, error: existing.diagnostic.message };
			}
			const localProviders = existing.parsed;
			const mergedProviders: Record<string, PiProviderConfig> = {};
			for (const [name, provider] of Object.entries(incoming.providers)) {
				if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
					return { valid: false, error: `导入包的 provider "${name}" 格式无效` };
				}
				const merged = { ...provider };
				const localKey = localProviders.providers?.[name]?.apiKey;
				// 新导出包故意不带 apiKey；旧包也可能带空字符串（用户清空后导出）。
				// 这两种情况都保留目标机器已有的 key，避免“恢复配置后所有 provider 变 401”。
				// 只有包内显式提供非空 key 时才以包内为准。
				if (
					(merged.apiKey === undefined || merged.apiKey === "") &&
					typeof localKey === "string" &&
					localKey.trim()
				) {
					merged.apiKey = localKey;
				}
				mergedProviders[name] = merged;
			}
			const merged: PiModelsFile = { ...incoming, providers: mergedProviders };
			const validation = this.validateModels(merged);
			if (!validation.valid) return validation;
			const normalized = this.normalizeModelsForPi(merged);
			await this.writeJsonFile("models.json", normalized);
			try {
				await this.writeModelsYml(normalized);
			} catch (error) {
				warnings.push({
					code: "models-yml-mirror-failed",
					detail: error instanceof Error ? error.message : String(error),
				});
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
		if (ompConfig) {
			const result = await this.rolesStore.importPackage(ompConfig);
			if (!result.valid) return result;
			// 设置页可编辑键单独走点路径补丁：rolesStore 只认角色槽位，不碰其它键。
			const patch = ompSettingsPatchFromPackage(ompConfig);
			const patchResult = await this.ompConfig.patch(patch);
			if (!patchResult.valid) return patchResult;
		}
		return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
	}
}
