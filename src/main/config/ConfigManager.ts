import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { normalize, join, dirname } from "node:path";
import { dirname as posixDirname, normalize as posixNormalize } from "node:path/posix";
import { homedir } from "node:os";
import { net } from "electron";
import type { AvailableModel } from "../../shared/types";
import type { ConfigFileDiagnostic, ConfigFileReadResult } from "../../shared/types";
import type { OmpModelRole, OmpRolesState } from "../../shared/types/ompRoles";
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
	/** config.yml 专属存取（roles + defaultThinkingLevel），configDir 经 accessor 注入。 */
	private readonly rolesStore: OmpRolesStore;
	/** trust.json 专属存取（信任决策存储/探测/编排），configDir 经 accessor 注入。 */
	private readonly trustStore: TrustStore;

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
				// 同时写一份 models.json 供后续使用
				this.writeJsonFile("models.json", ymlResult.parsed).catch(() => undefined);
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
	 * 解析 OMP models.yml 的简单缩进结构。
	 * 只处理 providers -> providerName -> fields/models 两级嵌套。
	 * 不支持数组嵌套对象以外的复杂 YAML。
	 */
	private parseSimpleYaml(raw: string): PiModelsFile {
		const lines = raw.split("\n");
		const result: PiModelsFile = { providers: {} };
		let currentProvider: string | null = null;
		let currentModel: Partial<PiModelItem> | null = null;
		const models: PiModelItem[] = [];

		for (const line of lines) {
			const trimmed = line.trimEnd();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const indent = line.length - line.trimStart().length;
			// Strip YAML array prefix `- ` at array-item indent levels
			const content = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
			const match = content.match(/^(\S[^:]*):\s*(.*)$/);
			if (!match) continue;

			const key = match[1].trim();
			const value = match[2].trim();

			if (indent === 0 && key === "providers") {
				currentProvider = null;
			} else if (indent === 2 && currentProvider === null) {
				currentProvider = key;
				result.providers[currentProvider] = { models: [] };
			} else if (currentProvider && indent === 4) {
				if (key === "models") {
					// models array starts next line
				} else if (value) {
					(result.providers[currentProvider] as Record<string, unknown>)[key] = this.parseYamlValue(value);
				}
			} else if (currentProvider && indent === 6) {
				if (currentModel) models.push(currentModel as PiModelItem);
				currentModel = { id: key };
				if (value) (currentModel as Record<string, unknown>)[key] = this.parseYamlValue(value);
			} else if (currentProvider && indent === 8 && currentModel) {
				(currentModel as Record<string, unknown>)[key] = this.parseYamlValue(value);
			}
		}
		if (currentModel) models.push(currentModel as PiModelItem);
		if (currentProvider) {
			result.providers[currentProvider].models = models;
		}
		return result;
	}

	private parseYamlValue(value: string): unknown {
		if (value === "true") return true;
		if (value === "false") return false;
		if (/^\d+$/.test(value)) return Number(value);
		if (value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1);
		return value;
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

	async ensureTrustedDirectory(directoryPath: string): Promise<void> {
		await this.trustStore.ensureTrustedDirectory(directoryPath);
	}

	/**
	 * 查询某项目目录的信任决策，沿父目录链查找最近记录（复刻 pi 的 findNearestTrustEntry 语义）。
	 * pi 的信任语义是父目录决策继承到子目录，例如 trust.json 记录 "C:\\Users": true，
	 * 则 C:\\Users\\14012\\project 同样视为已信任。返回 true/false；未记录返回 null。
	 */
	async getProjectTrustDecision(cwd: string): Promise<boolean | null> {
		return this.trustStore.getDecision(cwd);
	}
	/**
	 * 写入某项目目录的信任决策（覆盖该路径既有值）。
	 * 用户在信任弹窗选择“信任并记住”或“不信任”后调用，持久化决策避免重复打扰。
	 */
	async setProjectTrustDecision(cwd: string, decision: boolean): Promise<void> {
		await this.trustStore.setDecision(cwd, decision);
	}

	/** TrustStore 实例（AgentManager 决策编排经此使用：探测/decide 注入 ask）。 */
	getTrustStore(): TrustStore {
		return this.trustStore;
	}


	// ── 保存（可视化表单） ────────────────────────────────
	async saveModelsConfig(data: PiModelsFile): Promise<ConfigValidationResult> {
		const validation = this.validateModels(data);
		if (!validation.valid) return validation;
		// 保存前统一迁移历史别名，确保写入 models.json 的 api 名称能被 pi 官方 registry 识别。
		const normalized = this.normalizeModelsForPi(data);
		await this.writeJsonFile("models.json", normalized);
		// 同步更新 models.yml 保持 OMP 配置一致
		await this.writeModelsYml(normalized).catch(() => undefined);
		return { valid: true };
	}

	/** 将 models 数据写成 OMP models.yml 格式 */
	private async writeModelsYml(data: PiModelsFile): Promise<void> {
		const lines: string[] = ["providers:"];
		for (const [name, provider] of Object.entries(data.providers)) {
			lines.push(`  ${this.escapeYmlKey(name)}:`);
			if (provider.baseUrl) lines.push(`    baseUrl: ${this.escapeYmlValue(provider.baseUrl)}`);
			if (provider.apiKey) lines.push(`    apiKey: ${this.escapeYmlValue(provider.apiKey)}`);
			if (provider.api) lines.push(`    api: ${this.escapeYmlValue(provider.api)}`);
			if (provider.models?.length) {
				lines.push(`    models:`);
				for (const model of provider.models) {
					lines.push(`      - id: ${this.escapeYmlValue(model.id)}`);
					if (model.name) lines.push(`        name: ${this.escapeYmlValue(model.name)}`);
					if (model.reasoning) lines.push(`        reasoning: true`);
					if (model.contextWindow) lines.push(`        contextWindow: ${model.contextWindow}`);
					if (model.maxTokens) lines.push(`        maxTokens: ${model.maxTokens}`);
				}
			}
		}
		await writeFile(join(this.configDir, "models.yml"), lines.join("\n") + "\n", "utf-8");
	}

	private escapeYmlKey(key: string): string {
		return /[:\[\]{}#]|^\s/.test(key) ? `"${key}"` : key;
	}

	private escapeYmlValue(value: string | number | boolean): string {
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (/[:\[\]{}#"']|\s|^$/.test(value)) return JSON.stringify(value);
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
				if (changed) await writeFile(modelsPath, JSON.stringify(models, null, 2), "utf-8");
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
	// 收敛于 OmpRolesStore（原两次串行全文件 RMW 的撕裂窗口在此关闭），本类只
	// 做委托；configureWsl 切换 home 时经 accessor 现取 configDir，指针跟随。

	/** 读取 config.yml 的 modelRoles 全部角色当前值（委托 OmpRolesStore）。 */
	async readOmpModelRoles(): Promise<OmpRolesState> {
		return this.rolesStore.readRolesState();
	}

	/** 默认模型角色（modelRoles.default，顶层 defaultThinkingLevel 作无后缀回退）。 */
	async readOmpDefaultModel(): Promise<{
		selector?: string;
		provider?: string;
		model?: string;
		thinkingLevel?: string;
	}> {
		return this.rolesStore.readDefaultModel();
	}

	/** 顶层 defaultThinkingLevel（桌面端 post-ready 强推与设置展示的数据源）。 */
	async getOmpDefaultThinkingLevel(): Promise<string | undefined> {
		return this.rolesStore.readDefaultThinkingLevel();
	}

	/** 设置某个模型角色（config.yml modelRoles.<role>；default 走 applyOmpDefault）。 */
	async updateOmpModelRole(
		role: OmpModelRole,
		selector: string,
		thinkingLevel?: string,
	): Promise<ConfigValidationResult> {
		return this.rolesStore.applyRole(role, selector, thinkingLevel);
	}

	/** 清除某个模型角色（default 联动清顶层 defaultThinkingLevel）。 */
	async clearOmpModelRole(role: OmpModelRole): Promise<ConfigValidationResult> {
		return this.rolesStore.clearRole(role);
	}

	/**
	 * 原子设置 OMP 默认（模型 + 可选思考档）：单次文档变更写 modelRoles.default
	 * 与顶层 defaultThinkingLevel（含后缀与顶层键两个 schema 槽位，见 OmpRolesStore）。
	 */
	async applyOmpDefault(
		selector: string,
		thinkingLevel?: string,
	): Promise<ConfigValidationResult> {
		return this.rolesStore.applyDefault(selector, thinkingLevel);
	}

	/** 清除 OMP 默认（modelRoles.default + 顶层 defaultThinkingLevel 一次清）。 */
	async clearOmpDefault(): Promise<ConfigValidationResult> {
		return this.rolesStore.clearDefault();
	}

	/** 一次性 legacy 迁移：settings.json 的 defaultThinkingLevel 只填空写进 config.yml。 */
	async migrateOmpLegacyDefaultThinkingLevel(): Promise<void> {
		await this.rolesStore.migrateLegacyDefaultThinkingLevel();
	}

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
		// models.json 原始编辑后同步更新 models.yml
		if (fileName === "models.json") {
			try {
				const data = JSON.parse(rawJson) as PiModelsFile;
				await this.writeModelsYml(data);
			} catch {
				// YAML 同步失败不影响 JSON 保存
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

	private async readJsonFile<T>(
		fileName: string,
		fallback: T,
	): Promise<ConfigFileReadResult<T>> {
		const filePath = join(this.configDir, fileName);
		try {
			const raw = await readFile(filePath, "utf8");
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
		} catch {
			return { raw: JSON.stringify(fallback, null, 2), parsed: fallback };
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
		await mkdir(this.configDir, { recursive: true });
		const filePath = join(this.configDir, fileName);
		const json =
			typeof content === "string" ? content : JSON.stringify(content, null, 2);
		await writeFile(filePath, json, "utf8");
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
		const roles = await this.readOmpModelRoles();
		const defaultLevel = await this.getOmpDefaultThinkingLevel();
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
