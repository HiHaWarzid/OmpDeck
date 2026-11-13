import { showNotice } from "./utils/notice";
import { isAgentActiveOrIdle } from "./utils/agentRuntimeState";
import { Component, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import type { PiDesktopApi } from "../../shared/api";
import type { ConfigSaveWarning } from "../../shared/types";
import { AuthTab } from "./config/AuthTab";
import { ModelsTab } from "./config/ModelsTab";
import { RawTab } from "./config/RawTab";
import { TrustTab } from "./config/TrustTab";
import { SettingsTab } from "./config/SettingsTab";
import { PromptsTab } from "./config/PromptsTab";
import { SkillsTab } from "./config/SkillsTab";
import { ExtensionsTab } from "./config/ExtensionsTab";
import { EditorsTab } from "./config/EditorsTab";
import { LogsTab } from "./config/LogsTab";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { ModalSurface } from "./components/ui/ModalSurface";
import { t } from "./i18n";
import { LazyMonacoEditor } from "./components/ui/LazyMonacoEditor";
import { translateBuiltinPromptDescription } from "./composerBehavior";
import type {
	AuthFile,
	ConfigTab,
	ModelItem,
	ModelsFile,
} from "./config/configTypes";
import type { ConfigFileDiagnostic, CreatePiPromptTemplateInput, PiExtensionListResult, PiExtensionSummary, PiPromptTemplateListResult, PiPromptTemplateSummary, PiSkillListResult, PiSkillLocation, PiSkillSummary } from "../../shared/types";
import { getProviderHeaders, KNOWN_PROVIDER_ENDPOINTS } from "./config/providerHeaders";
import { lookupBuiltinApiRoute } from "../../shared/providerApiRoutes";
import { OMP_SETTINGS_PATHS, configValuesEqual, writeOmpPath } from "../../shared/ompConfigSettings";
import {
	commitDraft,
	createDraft,
	draftPatch,
	hasDraftChanges,
	rebaseDraft,
	setDraftValue,
	type Draft,
} from "./utils/configDraft";

const api: PiDesktopApi = (window as unknown as { piDesktop: PiDesktopApi })
	.piDesktop;
const DEFAULT_MODEL_CONFIG: Pick<
	ModelItem,
	"contextWindow" | "maxTokens" | "reasoning" | "input"
> = {
	contextWindow: 1000000,
	maxTokens: 128000,
	reasoning: true,
	input: ["text", "image"],
};

/**
 * 配置页必须能打开用户手写/旧版本生成的非标准 models.json。
 * pi 自身对配置较宽松，但 UI 会访问 provider.models.length / map；这里先把缺失或异常字段归一化，
 * 避免单个 provider 配置错误导致整个 renderer 白屏。
 */
function normalizeModelsFile(value: unknown): ModelsFile {
	const rawProviders =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as { providers?: unknown }).providers
			: undefined;
	const providers: ModelsFile["providers"] = {};
	if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
		return { providers };
	}
	for (const [name, rawProvider] of Object.entries(rawProviders)) {
		const provider =
			rawProvider && typeof rawProvider === "object" && !Array.isArray(rawProvider)
				? (rawProvider as Record<string, unknown>)
				: {};
		const rawModels = provider.models;
		providers[name] = {
			...provider,
			models: Array.isArray(rawModels)
				? rawModels
					.filter((model): model is ModelItem | string =>
						Boolean(model) &&
						(typeof model === "object" && !Array.isArray(model) || typeof model === "string"),
					)
					.map((model) =>
						typeof model === "string" ? { id: model } : model,
					)
				: [],
		};
	}
	return { providers };
}

function ConfigDiagnosticCard(props: {
	diagnostic: ConfigFileDiagnostic;
	onOpenDocs: () => void;
	onOpenRaw: () => void;
}) {
	const { diagnostic } = props;
	return (
		<div className="config-diagnostic-card">
			<div>
				<strong>{t("config.diagnosticLoadFailed", { fileName: diagnostic.fileName })}</strong>
				<span>
					{diagnostic.line && diagnostic.column
						? t("config.diagnosticLocation", {
								line: diagnostic.line,
								column: diagnostic.column,
								message: diagnostic.message,
							})
						: diagnostic.message}
				</span>
				<small>
					{t("config.diagnosticHelp")}{" "}
					<a href={diagnostic.docsUrl} target="_blank" rel="noreferrer">
						{t("config.openOfficialDocs")}
					</a>
				</small>
			</div>
			{diagnostic.snippet && <pre>{diagnostic.snippet}</pre>}
			<div className="config-diagnostic-actions">
				<button className="config-btn primary" onClick={props.onOpenRaw}>{t("config.openRawFile")}</button>
				<button className="config-btn" onClick={props.onOpenDocs}>{t("config.openOfficialDocs")}</button>
			</div>
		</div>
	);
}

type ConfigModalProps = {
	open: boolean;
	onClose: () => void;
	onSaved: () => void;
};

class ConfigModalErrorBoundary extends Component<
	{ open: boolean; onClose: () => void; children: ReactNode },
	{ error: Error | null }
> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidUpdate(prevProps: { open: boolean }) {
		if (prevProps.open !== this.props.open && this.state.error) {
			this.setState({ error: null });
		}
	}

	override render() {
		if (!this.state.error) return this.props.children;
		if (!this.props.open) return null;
		return (
			<ModalSurface
				open={this.props.open}
				onRequestClose={this.props.onClose}
				title={t("config.loadFailed")}
				className="config-modal"
				>
				<div className="config-content">
					<div className="config-diagnostic-card">
						<div>
							<strong>{t("config.renderCrashed")}</strong>
							<span>{this.state.error.message}</span>
							<small>
								{t("config.renderCrashedHelpPrefix")}
								<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">{t("config.docsModels")}</a>
								{" / "}
								<a href="https://pi.dev/docs/latest/settings" target="_blank" rel="noreferrer">{t("config.docsSettings")}</a>
								{t("config.renderCrashedHelpSuffix")}
							</small>
						</div>
						<pre>{this.state.error.stack ?? this.state.error.message}</pre>
					</div>
				</div>
			</ModalSurface>
		);
	}
}

/** 配置管理弹窗：支持 models/auth/settings 三个 tab 的可视化编辑和源文件编辑 */
export function ConfigModal(props: ConfigModalProps) {
	return (
		<ConfigModalErrorBoundary open={props.open} onClose={props.onClose}>
			<ConfigModalContent {...props} />
		</ConfigModalErrorBoundary>
	);
}

function ConfigModalContent(props: ConfigModalProps) {
	const { open, onClose, onSaved } = props;
	const [section, setSection] = useState<"config" | "skills" | "prompts" | "extensions" | "editors" | "logs">("config");
	const [tab, setTab] = useState<ConfigTab>("models");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [configDiagnostic, setConfigDiagnostic] = useState<ConfigFileDiagnostic | null>(null);
	/* toast 已改用 sonner 实现 */

	// 各 tab 的数据
	const [modelsData, setModelsData] = useState<ModelsFile>({ providers: {} });
	/**
	 * models.json 的磁盘基线。
	 *
	 * 关闭守卫的判据是「value 与基线是否相等」而不是「有没有点过保存」：只有基线在
	 * **每次真正回读磁盘**时一起更新，未保存改动才不会被后续 tab 切换洗成「干净」。
	 * 同理适用于 auth。
	 */
	const [modelsBaseline, setModelsBaseline] = useState<ModelsFile>({ providers: {} });
	const [authData, setAuthData] = useState<AuthFile>({});
	const [authBaseline, setAuthBaseline] = useState<AuthFile>({});
	/** omp 全局设置权威源 config.yml 的草稿（base = 载入/最后落盘值，value = 编辑中） */
	const [settingsDraft, setSettingsDraft] = useState<Draft<Record<string, unknown>>>(() =>
		createDraft({}),
	);
	const settingsData = settingsDraft.value;
	/**
	 * 当前 omp config.yml 的默认模型配置（modelRoles.default + defaultThinkingLevel），
	 * 供 ModelsTab 提供商卡片标记与快速设定默认。
	 */
	const [ompDefault, setOmpDefault] = useState<{
		provider?: string;
		model?: string;
		thinkingLevel?: string;
	}>({});
	/** 自动发现的模型：auth-only 供应商通过已知端点获取的模型列表 */
	const [discoveredModels, setDiscoveredModels] = useState<
		Record<string, Array<{ id: string; name?: string }>>
	>({});
	const [skillsData, setSkillsData] = useState<PiSkillListResult>({
		locations: [],
		skills: [],
	});
	const [extensionsData, setExtensionsData] = useState<PiExtensionListResult>({
		extensions: [],
		raw: "",
	});
	const [extensionsLoading, setExtensionsLoading] = useState(false);
	const [creatingSkill, setCreatingSkill] = useState(false);
	const [uninstallingExtensionSource, setUninstallingExtensionSource] = useState<string | null>(null);
	const [newSkillName, setNewSkillName] = useState("");
	const [newSkillDescription, setNewSkillDescription] = useState("");
	const [newSkillLocationId, setNewSkillLocationId] = useState<PiSkillLocation["id"]>("pi-global");
	const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<PiSkillSummary | null>(null);
	const [editingGlobalSkill, setEditingGlobalSkill] = useState<PiSkillSummary | null>(null);
	const [editGlobalContent, setEditGlobalContent] = useState("");
	const [editGlobalLoading, setEditGlobalLoading] = useState(false);
	const [editGlobalSaving, setEditGlobalSaving] = useState(false);
	const [editGlobalSaved, setEditGlobalSaved] = useState(false);
	const [promptsData, setPromptsData] = useState<PiPromptTemplateListResult>({
		templates: [],
		globalDir: "",
	});
	const [creatingPrompt, setCreatingPrompt] = useState(false);
	const [newPromptName, setNewPromptName] = useState("");
	const [newPromptDescription, setNewPromptDescription] = useState("");
	const [editingPrompt, setEditingPrompt] = useState<PiPromptTemplateSummary | null>(null);
	const [editPromptContent, setEditPromptContent] = useState("");
	const [editPromptLoading, setEditPromptLoading] = useState(false);
	const [editPromptSaving, setEditPromptSaving] = useState(false);
	/** 用户已删除的内置模板名称（仅当前会话有效） */
	const [deletedBuiltinNames, setDeletedBuiltinNames] = useState<Set<string>>(new Set());
	const [uninstallExtensionConfirm, setUninstallExtensionConfirm] = useState<PiExtensionSummary | null>(null);
	/**
	 * 源文件 tab 的编辑草稿与基线。
	 *
	 * 只有 `raw` tab 的载入路径会写它们：settings/models/trust 分支以前也顺手写
	 * `setRawContent`，结果「编辑源文件 → 切到别的 tab」会被那次载入静默覆盖。
	 * 现在这四个状态只属于 raw tab，切换 tab 不再互相踩。
	 */
	const [rawContent, setRawContent] = useState("");
	const [rawBaseline, setRawBaseline] = useState("");
	const [rawFileName, setRawFileName] = useState("config.yml");
	/** trust tab 的草稿与基线（同样只由 trust 载入路径写）。 */
	const [trustData, setTrustData] = useState<Record<string, boolean>>({});
	const [trustBaseline, setTrustBaseline] = useState<Record<string, boolean>>({});

	/**
	 * 各 tab「当前值 vs 基线」的最新快照。
	 *
	 * loadConfig 是 useCallback：把草稿塞进依赖数组会让「数据变化」反过来触发载入，形成回读
	 * 循环；不塞又只能看到挂载那一刻的旧值。载入路径需要判断「这个 tab 是否还有未保存编辑
	 * （有就不能覆盖）」，所以用 ref 读取最新值，依赖表仍只保留回调。
	 */
	const draftsRef = useRef({
		models: { value: modelsData, baseline: modelsBaseline },
		auth: { value: authData, baseline: authBaseline },
		trust: { value: trustData, baseline: trustBaseline },
		raw: { value: rawContent, baseline: rawBaseline, fileName: rawFileName },
		settings: { value: settingsDraft },
	});
	draftsRef.current = {
		models: { value: modelsData, baseline: modelsBaseline },
		auth: { value: authData, baseline: authBaseline },
		trust: { value: trustData, baseline: trustBaseline },
		raw: { value: rawContent, baseline: rawBaseline, fileName: rawFileName },
		settings: { value: settingsDraft },
	};

	// 展开的 provider / auth 项
	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	const [expandedAuth, setExpandedAuth] = useState<string | null>(null);
	// 新增 provider
	const [addingProvider, setAddingProvider] = useState(false);
	const [newProviderName, setNewProviderName] = useState("");
	// 重命名 provider
	const [renamingProvider, setRenamingProvider] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	// 新增 auth
	const [addingAuth, setAddingAuth] = useState(false);
	const [newAuthName, setNewAuthName] = useState("");
	// 远程拉取模型列表
	const [fetchingProvider, setFetchingProvider] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<
		Record<string, Array<{ id: string; name?: string }>>
	>({});

	/**
	 * 根据 API 类型返回对应的获取模型提示。
	 * 不同服务对 /models 端点的支持不同，提供针对性的指导。
	 */
	function getFetchModelsHintByApi(api: string | undefined, baseUrl: string): string {
		switch (api) {
			case "openai-completions":
				return t("config.fetchModelsHintOpenaiCompletions", { baseUrl });
			case "openai-responses":
				return t("config.fetchModelsHintOpenai", { baseUrl });
			case "openai-codex-responses":
				return t("config.fetchModelsHintOpenaiCodex");
			case "anthropic-messages":
				return t("config.fetchModelsHintAnthropic");
			case "google-generative-ai":
				return t("config.fetchModelsHintGoogle");
			case "mistral-conversations":
				return t("config.fetchModelsHintMistral");
			default:
				// 未知 API 类型时使用通用提示
				return t("config.fetchModelsHint");
		}
	}

	// 每个 provider 独立的模型拉取错误状态，避免全局 setError 相互覆盖
	const [fetchModelsErrorByProvider, setFetchModelsErrorByProvider] = useState<
		Record<string, string | undefined>
	>({});
	// 快速测试连接
	const [testingProvider, setTestingProvider] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<{
		providerName: string;
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
		requestUrl?: string;
		requestBody?: string;
	} | null>(null);
	const [testModelIdByProvider, setTestModelIdByProvider] = useState<
		Record<string, string>
	>({});
	// 删除确认对话框
	const [deleteConfirm, setDeleteConfirm] = useState<{
		type: "provider" | "model" | "auth" | "batch";
		title: string;
		message: string;
		onConfirm: () => void;
	} | null>(null);

	/**
	 * 源文件 tab 的载入：内容与基线一起换。
	 *
	 * 「重新载入 = 丢弃该文件草稿」是本 tab 的唯一语义；只换内容不换基线会让刚读到的
	 * 磁盘文本立刻被算成未保存改动，关闭弹层时凭空弹出保存确认。
	 */
	const loadRawFile = useCallback(async (fileName: string, options: { force?: boolean } = {}) => {
		// 同一文件已有未保存编辑时不回读：切到别的 tab 再切回来不该把草稿洗成磁盘值。
		// 换文件（下拉切换）与保存后回读是明确意图，走 force 直接重置草稿。
		const liveRaw = draftsRef.current.raw;
		if (!options.force && fileName === liveRaw.fileName && liveRaw.value !== liveRaw.baseline) {
			return;
		}
		const res =
			fileName === "models.json"
				? await api.config.getModels()
				: fileName === "trust.json"
					? await api.config.getTrust()
					: await api.config.getOmpConfig();
		setRawFileName(fileName);
		setRawContent(res.raw);
		setRawBaseline(res.raw);
		setConfigDiagnostic(res.diagnostic ?? null);
	}, []);

	const loadConfig = useCallback(
		async (
			target: ConfigTab,
			/**
			 * 设置 tab 的回读选项。
			 * `rebasePaths`：只把这些已落盘的路径对齐到磁盘真值，其余未提交编辑原样保留。
			 * 不传则整份重建（打开弹层、切换 tab、点「重新载入」语义都是丢弃草稿）。
			 *
			 * `force`：保存后的回读。该 tab 刚落盘，内存里的 value 与 base 在本次渲染前
			 * 还是旧的（setState 尚未提交），dirty 判据会把这次回读误拦；而回读要读的正是
			 * 磁盘规范化后的真值，必须无条件覆盖。
			 */
			options: { rebasePaths?: readonly string[]; force?: boolean } = {},
		) => {
			setLoading(true);
			setError(null);
			setConfigDiagnostic(null);
			try {
				if (target === "models") {
					// 并行读取 omp 权威全局配置（config.yml）中的默认模型，
					// 供提供商卡片展示"当前是否为 OMP 默认"与快速设定。
					const [res, ompDefaultRes] = await Promise.all([
						api.config.getModels(),
						api.config.getOmpDefault(),
					]);
					// 该 tab 还有未保存编辑时不回读：切走再切回来不该把草稿洗成磁盘值。
					const live = draftsRef.current;
					if (options.force || configValuesEqual(live.models.value, live.models.baseline)) {
						const parsed = normalizeModelsFile(res.parsed);
						setModelsData(parsed);
						setModelsBaseline(parsed);
					}
					setConfigDiagnostic(res.diagnostic ?? null);
					setOmpDefault(ompDefaultRes);
				} else if (target === "auth") {
					const res = await api.config.getAuth();
					const live = draftsRef.current;
					if (options.force || configValuesEqual(live.auth.value, live.auth.baseline)) {
						const parsed = res.parsed as AuthFile;
						setAuthData(parsed);
						setAuthBaseline(parsed);
					}
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "settings") {
					// 设置页数据源 = omp 权威设置 config.yml；auth/models 仅用于 enabledModels 候选
					const [settingsRes, authRes, modelsRes] = await Promise.all([
						api.config.getOmpConfig(),
						api.config.getAuth(),
						api.config.getModels(),
					]);
					// 保存后的回读只校准刚落盘的路径：同一时间用户可能还在改别的字段，
					// 整份重建会把那些尚未提交的编辑静默清空。其余情况（打开弹层、
					// 切换 tab、重新载入）仍是「重新载入 = 丢弃草稿」。
					const rebasePaths = options.rebasePaths;
					if (rebasePaths && rebasePaths.length > 0) {
						setSettingsDraft((prev) => rebaseDraft(prev, settingsRes.parsed, rebasePaths));
					} else if (
						// 该 tab 还有未提交的编辑：切走再切回来不该把草稿洗成磁盘值
						options.force ||
						!hasDraftChanges(draftsRef.current.settings.value, OMP_SETTINGS_PATHS)
					) {
						setSettingsDraft(createDraft(settingsRes.parsed));
					}
					// auth/models 在这里只是 enabledModels 候选来源，同样来自磁盘。
					// 已有未保存编辑时不覆盖：切到设置页不该吞掉另一个 tab 的草稿，
					// 内存里的值本身仍是可用于候选列表的比较新的那一份。
					const live = draftsRef.current;
					if (configValuesEqual(live.auth.value, live.auth.baseline)) {
						const authParsed = authRes.parsed as AuthFile;
						setAuthData(authParsed);
						setAuthBaseline(authParsed);
					}
					if (configValuesEqual(live.models.value, live.models.baseline)) {
						const modelsParsed = normalizeModelsFile(modelsRes.parsed);
						setModelsData(modelsParsed);
						setModelsBaseline(modelsParsed);
					}
					setConfigDiagnostic(settingsRes.diagnostic ?? null);
					// 默认模型权威源同样是 config.yml（modelRoles.default）
					setOmpDefault(await api.config.getOmpDefault());

					// 对于 auth 中有但 models 中没有模型的供应商，自动尝试获取模型列表
					const authProviders = authRes.parsed as AuthFile;
					const modelsProviders = normalizeModelsFile(modelsRes.parsed).providers;
					const discovered: Record<string, Array<{ id: string; name?: string }>> = {};
					const fetchPromises: Array<Promise<void>> = [];

					for (const [providerName, authEntry] of Object.entries(authProviders)) {
						// 跳过已有模型的供应商
						if (modelsProviders[providerName]?.models?.length) continue;
						const apiKey =
							typeof authEntry.key === "string" ? authEntry.key : "";
						if (!apiKey) continue;

						// 情况1：从 KNOWN_PROVIDER_ENDPOINTS 获知该供应商的 API 端点
						const knownEndpoint = KNOWN_PROVIDER_ENDPOINTS[providerName];
						// 情况2：从 models.json 中该供应商的配置获知 baseUrl
						const modelsProvider = modelsProviders[providerName];
						const modelsBaseUrl =
							modelsProvider && typeof modelsProvider.baseUrl === "string"
								? modelsProvider.baseUrl
								: undefined;
						const baseUrl = knownEndpoint?.baseUrl ?? modelsBaseUrl;
						if (!baseUrl) continue;

						const apiType =
							knownEndpoint?.apiType ??
							(typeof modelsProvider?.api === "string"
								? modelsProvider.api
								: undefined);

						fetchPromises.push(
							api.config
								.fetchModels(baseUrl, apiKey, apiType)
								.then((result) => {
									if (result.success && result.models) {
										discovered[providerName] = result.models;
									}
								})
								.catch(() => {
									// 静默失败，不阻塞 UI
								}),
						);
					}

					if (fetchPromises.length > 0) {
						// 不 await，在后台获取后更新状态即可
						void Promise.allSettled(fetchPromises).then(() => {
							if (Object.keys(discovered).length > 0) {
								setDiscoveredModels(discovered);
							}
						});
					}
				} else if (target === "trust") {
					const res = await api.config.getTrust();
					const live = draftsRef.current;
					if (options.force || configValuesEqual(live.trust.value, live.trust.baseline)) {
						const parsed = res.parsed as Record<string, boolean>;
						setTrustData(parsed);
						setTrustBaseline(parsed);
					}
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "raw") {
					// 保持当前选中的文件（首次进入是 omp 设置权威源 config.yml），
					// 切走再切回来不该把下拉选择重置成默认文件。
					await loadRawFile(draftsRef.current.raw.fileName);
					return;
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[loadRawFile],
	);

	useEffect(() => {
		if (!open) return;
		if (section === "skills") {
			void refreshSkills();
			return;
		}
		if (section === "prompts") {
			void refreshPrompts();
			return;
		}
		if (section === "extensions") {
			// 切到扩展页默认吃缓存；只有点刷新按钮才 forceRefresh。
			void refreshExtensions(false);
			return;
		}
		if (section === "editors") return;
		if (section === "logs") return;
		void loadConfig(tab);
	}, [open, section, tab, loadConfig]);

	const showToast = (msg: string) => {
		showNotice(msg, 2500);
	};

	/** invoke 失败经失败契约解包后 message 已是干净业务错误（不再有 Electron 的包装前缀），可直接展示。 */
	const formatIpcError = (error: unknown): string =>
		(error instanceof Error ? error.message : String(error)).trim();

	/**
	 * 模型配置保存后，通知所有运行中的 Agent 尝试刷新模型配置。
	 *
	 * 当前仅尝试 reload_config RPC（策略 1），pi 0.80.10 尚未支持此命令，
	 * 因此实际为 no-op。进程重启方案（策略 2）已注释，原因：
	 *   - 运行中重启会打断用户对话/工具执行
	 *   - 涉及 exit 事件竞态、模型恢复等复杂边界
	 *
	 * pi 合并 https://github.com/earendil-works/pi/issues/6890 后自动生效。
	 */
	const refreshRunningAgents = async () => {
		try {
			const agents = await api.agents.list();
			// 只刷新状态为 running 或 idle 的活跃 Agent（排除 closed/error/starting）
			const activeAgents = agents.filter(isAgentActiveOrIdle);
			if (activeAgents.length === 0) return;

			let refreshed = 0;
			let failed = 0;
			for (const agent of activeAgents) {
				try {
					await api.agents.refreshModels(agent.id);
					refreshed++;
				} catch {
					failed++;
				}
			}

			// pi 官方尚未支持 reload_config RPC，刷新实际为 no-op，先注释提示避免误导
			// if (refreshed > 0 && failed === 0) {
			// 	showToast(t("config.modelsRefreshed", { count: refreshed }));
			// } else if (refreshed > 0) {
			// 	showToast(t("config.modelsRefreshedPartial", { refreshed, failed }));
			// }
		} catch {
			// 获取 agent 列表失败时静默忽略，模型配置已保存，下次启动 agent 生效
		}

	};

	/**
	 * 保存并提示。返回是否真正落盘：调用方必须据此决定是否 reload，
	 * 否则失败时随后的 loadConfig 会 setError(null) 并覆盖用户草稿。
	 *
	 * `quiet`：批量保存（关闭守卫「保存并关闭」）里每个 tab 各调一次，成功提示由调用方
	 * 合并成一条，否则一次关闭会连弹 5 个 toast。失败提示与降级告警不受影响。
	 */
	const saveAndReload = async (
		saveFn: () => Promise<{
			valid: boolean;
			error?: string;
			warnings?: ConfigSaveWarning[];
		}>,
		successMessage?: string,
		options: { quiet?: boolean } = {},
	): Promise<boolean> => {
		setSaving(true);
		setError(null);
		try {
			const result = await saveFn();
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return false;
			}
			onSaved();
			// 「已保存但有降级」必须说出来：例如 models.yml 镜像写失败时，
			// 只报「已保存」会让用户以为 pi 侧也生效了，而实际仍在用旧配置。
			const warning = result.warnings?.[0];
			if (warning) {
				showNotice(
					warning.code === "models-yml-mirror-failed"
						? t("config.modelsMirrorFailed", { detail: warning.detail })
						: warning.code === "models-json-mirror-failed"
							? t("config.modelsJsonMirrorFailed", { detail: warning.detail })
							: warning.detail,
					6000,
					"warning",
				);
				return true;
			}
			if (options.quiet) return true;
			showToast(successMessage ?? t("config.saved"));
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	};

	// ── Models 操作 ──────────────────────────────────────

	/**
	 * 设置 omp 默认供应商/模型（含可选思考等级）：经主进程原子写 settings.json，
	 * 成功后同步本地 ompDefault 供卡片高亮，无需整页刷新。
	 */
	const handleSetOmpDefault = async (
		provider: string,
		model: string,
		thinkingLevel?: string,
	) => {
		setSaving(true);
		try {
			const result = await api.config.setDefaultModel(provider, model, thinkingLevel);
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return;
			}
			setOmpDefault((current) => ({
				...current,
				provider,
				model,
				thinkingLevel:
					thinkingLevel !== undefined ? thinkingLevel : current.thinkingLevel,
			}));
			onSaved();
			showToast(t("config.ompDefaultSetToast", { provider, model }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	/** 清除 omp 默认模型角色与默认思考等级（config.yml 中的 modelRoles.default）。 */
	const handleClearOmpDefault = async () => {
		setSaving(true);
		try {
			const result = await api.config.clearOmpDefault();
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return;
			}
			setOmpDefault({});
			onSaved();
			showToast(t("config.ompDefaultCleared"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	const handleAddProvider = () => {
		const providerName = newProviderName.trim();
		if (!providerName) return;
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				// 默认不写入 headers，保持和手写 models.json 一致；需要兼容特定代理时再由用户显式选择 User-Agent。
				[providerName]: { models: [] },
			},
		};
		setModelsData(updated);
		setExpandedProvider(providerName);
		setAddingProvider(false);
		setNewProviderName("");
	};

	// 重命名 provider：保留所有配置和模型，仅修改 key 名称
	const handleStartRename = (name: string) => {
		setRenamingProvider(name);
		setRenameValue(name);
	};

	const handleConfirmRename = (oldName: string) => {
		const newName = renameValue.trim();
		if (!newName || newName === oldName || modelsData.providers[newName]) {
			// 名称未变、为空或已存在则不操作
			setRenamingProvider(null);
			setRenameValue("");
			return;
		}
		const providers = { ...modelsData.providers };
		providers[newName] = providers[oldName];
		delete providers[oldName];
		setModelsData({ ...modelsData, providers });
		if (expandedProvider === oldName) setExpandedProvider(newName);
		setRenamingProvider(null);
		setRenameValue("");
	};

	const handleCancelRename = () => {
		setRenamingProvider(null);
		setRenameValue("");
	};

	const handleDeleteProvider = (name: string) => {
		setDeleteConfirm({
			type: "provider",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				delete providers[name];
				setModelsData({ ...modelsData, providers });
				if (expandedProvider === name) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateProvider = (name: string) => {
		const sourceProvider = modelsData.providers[name];
		if (!sourceProvider) return;
		
		// 生成新名称：原名称 + " copy" 或 " copy 2" 依此类推
		let newName = `${name} copy`;
		let counter = 2;
		while (modelsData.providers[newName]) {
			newName = `${name} copy ${counter}`;
			counter++;
		}
		
		// 深拷贝 provider 配置，包括 models 数组
		const duplicatedProvider = JSON.parse(JSON.stringify(sourceProvider));
		
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[newName]: duplicatedProvider,
			},
		});
		
		// 展开新复制的 provider
		setExpandedProvider(newName);
	};

	/**
	 * 检测成功且实际走通 /v1（或 /v1beta）时，把表单里的 baseUrl 自动改成带版本路径。
	 * 原因：检测侧会兼容补路径，但 pi 会话会原样读 models.json；不改写则「测试正常、会话 404」。
	 * 仅改内存表单，需用户点保存后才写入磁盘。
	 * 后端仅在确实需要改写时返回 suggestedBaseUrl，前端直接应用即可。
	 */
	const applySuggestedBaseUrl = useCallback(
		(providerName: string, suggestedBaseUrl?: string) => {
			if (!suggestedBaseUrl) return false;
			const next = suggestedBaseUrl.replace(/\/+$/, "");
			if (!next) return false;
			// 函数式更新，避免 async 返回时闭包拿到旧 modelsData。
			setModelsData((prev) => {
				const provider = prev.providers[providerName];
				if (!provider) return prev;
				const current = (provider.baseUrl ?? "").replace(/\/+$/, "");
				if (current === next) return prev;
				return {
					...prev,
					providers: {
						...prev.providers,
						[providerName]: { ...provider, baseUrl: next },
					},
				};
			});
			return true;
		},
		[],
	);

	// 从 provider 的 baseUrl + apiKey 拉取可用模型列表
	const handleFetchModels = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: t("config.missingBaseUrlApiKey"),
			}));
			return;
		}
		setFetchingProvider(providerName);
		setFetchModelsErrorByProvider((prev) => ({
			...prev,
			[providerName]: undefined,
		}));
		try {
			const result = await api.config.fetchModels(
				provider.baseUrl,
				provider.apiKey,
				provider.api as string | undefined,
				getProviderHeaders(provider.headers),
			);
			if (result.success && result.models) {
				setFetchedModels((prev) => ({
					...prev,
					[providerName]: result.models!,
				}));
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: undefined,
				}));
				const normalized = applySuggestedBaseUrl(
					providerName,
					result.suggestedBaseUrl,
				);
				if (normalized && result.suggestedBaseUrl) {
					showToast(
						t("config.baseUrlAutoNormalized", {
							url: result.suggestedBaseUrl,
						}),
					);
				} else {
					showToast(t("config.fetchedModels", { count: result.models.length }));
				}
			} else {
				// 根据 API 类型提供不同的错误提示
				const apiTypeHint = getFetchModelsHintByApi(provider.api as string | undefined, provider.baseUrl);
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: (result.error ?? t("config.fetchModelsFailed")) + "\n" + apiTypeHint,
				}));
			}
		} catch (e) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: e instanceof Error ? e.message : String(e),
			}));
		} finally {
			setFetchingProvider(null);
		}
	};

	// 快速测试 provider 连接
	const handleTestProvider = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setError(t("config.missingBaseUrlApiKey"));
			return;
		}
		// 确定测试用的模型：优先用户指定的 testModelId，否则取第一个模型 id
		const modelId =
			(testModelIdByProvider[providerName] ?? "").trim() ||
			provider.models[0]?.id ||
			"";
		if (!modelId) {
			setError(t("config.missingTestModel"));
			return;
		}
		setTestingProvider(providerName);
		setTestResult(null);
		setError(null);
		try {
			// pi 内置 provider（如 commandcode）按 model id 选端点，provider 级别 `api`
			// 字段被忽略。如果只按用户写的 api 测试，会与实际会话打不同端点：测试 200、
			// 会话 400/404。先查内置路由表，覆盖真实会话路径。
			const builtinApi = lookupBuiltinApiRoute(providerName, modelId);
			const effectiveApi = builtinApi ?? (provider.api as string | undefined);
			const result = await api.config.testProvider(
				provider.baseUrl,
				provider.apiKey,
				modelId,
				effectiveApi,
				getProviderHeaders(provider.headers),
			);
			setTestResult({ providerName, ...result });
			// 测试成功且走通版本路径时，自动把根路径 baseUrl 改成 /v1 等，避免会话侧失败。
			if (result.success && result.suggestedBaseUrl) {
				const normalized = applySuggestedBaseUrl(
					providerName,
					result.suggestedBaseUrl,
				);
				if (normalized) {
					showToast(
						t("config.baseUrlAutoNormalized", {
							url: result.suggestedBaseUrl,
						}),
					);
				}
			}
		} catch (e) {
			setTestResult({
				providerName,
				success: false,
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setTestingProvider(null);
		}
	};

	const handleAddModel = (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const newModel: ModelItem = {
			id: "",
			name: "",
			...DEFAULT_MODEL_CONFIG,
		};
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models: [...provider.models, newModel] },
			},
		};
		setModelsData(updated);
	};

	const handleUpdateModel = (
		providerName: string,
		index: number,
		field: string,
		value: unknown,
	) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const models = [...provider.models];
		models[index] = { ...models[index], [field]: value };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models },
			},
		});
	};

	const handleUpdateModelXhigh = (
		providerName: string,
		index: number,
		value: "" | "xhigh" | "max",
	) => {
		const provider = modelsData.providers[providerName];
		const currentModel = provider?.models[index];
		if (!provider || !currentModel) return;
		const models = [...provider.models];
		const nextThinkingLevelMap = {
			...(currentModel.thinkingLevelMap ?? {}),
		};
		if (value) nextThinkingLevelMap.xhigh = value;
		else delete nextThinkingLevelMap.xhigh;
		const nextModel = {
			...currentModel,
			// xhigh 只有 reasoning 模型才有意义；打开映射时同步开启，避免保存后 UI 看似配置成功但 pi 仍不展示思考档位。
			reasoning: value ? true : currentModel.reasoning,
		};
		if (Object.keys(nextThinkingLevelMap).length > 0) {
			nextModel.thinkingLevelMap = nextThinkingLevelMap;
		} else {
			delete nextModel.thinkingLevelMap;
		}
		models[index] = nextModel;

		const nextProvider = value
			? {
				...provider,
				compat: {
					supportsDeveloperRole: false,
					...(provider.compat ?? {}),
					// xhigh 映射必须最终发送给上游；自动打开可减少用户遗漏 provider 兼容开关导致回退 high。
					supportsReasoningEffort: true,
				},
			}
			: { ...provider };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...nextProvider, models },
			},
		});
	};

	const handleDeleteModel = (providerName: string, index: number) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const model = provider.models[index];
		if (!model) return;
		setDeleteConfirm({
			type: "model",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: `${providerName}/${model.id}` }),
			onConfirm: () => {
				const models = provider.models.filter((_, i) => i !== index);
				setModelsData({
					...modelsData,
					providers: {
						...modelsData.providers,
						[providerName]: { ...provider, models },
					},
				});
				setDeleteConfirm(null);
			},
		});
	};

	/**
	 * 落盘 models.json（含 compat 归一化），成功后把基线与界面值一起推进到写入值。
	 *
	 * 拆出「只落盘、不回读」的版本，是因为关闭守卫可能在别的 tab 上触发保存：
	 * 那边不能顺手 reload，否则会把当前 tab 闪成 loading 并重建无关草稿。
	 */
	const persistModels = async (quiet = false): Promise<boolean> => {
		// 保存前规范化所有供应商的 compat 字段，确保布尔值显式写入而不依赖后端默认值
		const normalizedData = {
			...modelsData,
			providers: Object.fromEntries(
				Object.entries(modelsData.providers).map(([name, provider]) => [
					name,
					{
						...provider,
						compat: {
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
							...(provider.compat as Record<string, unknown> | undefined),
						},
					},
				]),
			),
		};
		const saved = await saveAndReload(
			() => api.config.saveModels(normalizedData),
			t("config.modelsSaved"),
			{ quiet },
		);
		if (!saved) return false;
		// 基线取自「刚写出去的那份值」而不是界面旧值：compat 默认字段是保存时才补的，
		// 拿旧值当基线会让同一份内容保存后仍显示为未保存改动。
		setModelsData(normalizedData);
		setModelsBaseline(normalizedData);
		return true;
	};

	const handleSaveModels = async () => {
		if (!(await persistModels())) return;
		await loadConfig("models", { force: true });

		// 保存后自动刷新所有运行中的 Agent，使模型配置实时生效
		// pi 官方尚未支持，先注释
		// void refreshRunningAgents();
	};

	// ── Auth 操作 ────────────────────────────────────────

	const handleUpdateAuth = (provider: string, field: "key", value: string) => {
		setAuthData({
			...authData,
			[provider]: { ...authData[provider], [field]: value },
		});
	};

	/**
	 * 添加认证条目。
	 * name 和 key 从 AuthTab 供应商选择弹窗直接传入，
	 * 避免 React 闭包中状态尚未刷新的问题，且支持弹窗内直接填写 API Key。
	 */
	const handleAddAuth = (name?: string, key?: string) => {
		const finalName = name ?? newAuthName.trim();
		if (!finalName) return;
		// 重复添加已配置 provider 且没填新 key 时必须保留原 key：保存时缺席/空 key
		// 会被后端解释为“清空该 provider 的 apiKey”，否则点一下添加就静默删掉凭据。
		const existingKey = authData[finalName]?.key;
		setAuthData({
			...authData,
			[finalName]: { key: key?.trim() ? key : existingKey ?? "" },
		});
		setExpandedAuth(finalName);
		setAddingAuth(false);
		setNewAuthName("");
	};

	const handleDeleteAuth = (provider: string) => {
		setDeleteConfirm({
			type: "auth",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: provider }),
			onConfirm: () => {
				const updated = { ...authData };
				delete updated[provider];
				setAuthData(updated);
				if (expandedAuth === provider) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDeleteProviders = (names: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: names.length }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				for (const name of names) delete providers[name];
				setModelsData({ ...modelsData, providers });
				if (names.includes(expandedProvider ?? "")) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDeleteAuths = (providers: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: providers.length }),
			onConfirm: () => {
				const updated = { ...authData };
				for (const provider of providers) delete updated[provider];
				setAuthData(updated);
				if (providers.includes(expandedAuth ?? "")) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const persistAuth = async (quiet = false): Promise<boolean> => {
		const saved = await saveAndReload(() => api.config.saveAuth(authData), undefined, { quiet });
		if (!saved) return false;
		setAuthBaseline(authData);
		return true;
	};

	const handleSaveAuth = async () => {
		if (!(await persistAuth())) return;
		await loadConfig("auth", { force: true });
	};

	// ── Settings 操作 ────────────────────────────────────

	/**
	 * 保存设置草稿：只提交真正改动过的点路径。
	 * 返回是否「已干净」（空补丁或落盘成功）——ModalSurface 的未保存守卫用它决定是否放行关闭。
	 */
	const handleSaveSettings = async (quiet = false): Promise<boolean> => {
		const patch = draftPatch(settingsDraft, OMP_SETTINGS_PATHS);
		// 本次真正要落盘的路径：commit 只推进这些，保存期间新动的键继续留在草稿里
		const landedPaths = [
			...(patch.set ?? []).map((entry) => entry.path),
			...(patch.unset ?? []),
		];
		// 基线只能推进「刚提交出去的那份值」：patch 在这里定型，而 commit 发生在 await 之后，
		// 此间用户可能继续输入。若让 commit 从当时的 draft.value 取值，那些从未发送的文本
		// 会被标成已保存，关闭弹层时静默丢失。
		let persisted: Record<string, unknown> = {};
		for (const entry of patch.set ?? []) persisted = writeOmpPath(persisted, entry.path, entry.value);
		for (const path of patch.unset ?? []) persisted = writeOmpPath(persisted, path, undefined);
		// 没有改动就不落盘（避免把空补丁写成一次无意义写入）
		if ((patch.set?.length ?? 0) === 0 && (patch.unset?.length ?? 0) === 0) {
			if (tab === "settings" && !quiet) await loadConfig("settings");
			return true;
		}
		if (!(await saveAndReload(() => api.config.patchOmpConfig(patch), undefined, { quiet })))
			return false;
		// 落盘成功才推进基线；失败时草稿与 dirty 原样保留
		setSettingsDraft((prev) => commitDraft(prev, landedPaths, persisted));
		// 回读一次磁盘真值（omp 可能规范化写入值）。带上 landedPaths，让回读只校准
		// 刚提交的字段——保存期间用户可能已经改了别的字段，整份重建会吞掉那些编辑。
		// 不在设置 tab 时不重载：关闭守卫可能在别的 tab 上触发保存，
		// 重载会把 loading 态闪到当前 tab 上。
		if (tab === "settings" && !quiet) await loadConfig("settings", { rebasePaths: landedPaths });
		return true;
	};

	// ── Trust 操作 ────────────────────────────────────────

	const persistTrust = async (quiet = false): Promise<boolean> => {
		const saved = await saveAndReload(
			() => api.config.saveRaw("trust.json", JSON.stringify(trustData, null, 2)),
			undefined,
			{ quiet },
		);
		if (!saved) return false;
		setTrustBaseline(trustData);
		return true;
	};

	const handleSaveTrust = async () => {
		if (!(await persistTrust())) return;
		await loadConfig("trust", { force: true });
	};

	// ── Raw 操作 ─────────────────────────────────────────

	const persistRaw = async (quiet = false): Promise<boolean> => {
		const isModelsFile = rawFileName === "models.json";
		const saved = await saveAndReload(
			() =>
				rawFileName === "config.yml"
					? api.config.saveOmpConfigRaw(rawContent)
					: api.config.saveRaw(rawFileName, rawContent),
			isModelsFile ? t("config.modelsSaved") : undefined,
			{ quiet },
		);
		if (!saved) return false;
		setRawBaseline(rawContent);
		return true;
	};

	const handleSaveRaw = async () => {
		const isModelsFile = rawFileName === "models.json";
		if (!(await persistRaw())) return;
		if (isModelsFile) {
			await loadConfig("models", { force: true });
			// Raw 保存也触发模型刷新，确保运行中的 Agent 实时生效
			// pi 官方尚未支持，先注释
			// void refreshRunningAgents();
		} else if (rawFileName === "trust.json") await loadConfig("trust", { force: true });
		else await loadConfig("settings", { force: true });
	};

	// 切换源文件时重新加载对应文件内容
	const handleRawFileChange = async (fileName: string) => {
		setLoading(true);
		setError(null);
		try {
			await loadRawFile(fileName, { force: true });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	// ── 导出 / 导入 ─────────────────────────────────────

	/** 将三个配置文件打包为 JSON 并触发浏览器下载。 */
	const handleExport = async () => {
		try {
			const json = await api.config.export();
			const blob = new Blob([json], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			// 文件名含时间戳，便于用户区分多次备份
			a.download = `pideck-config-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
			showToast(t("config.exported"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	/** 刷新 prompt templates 列表 */
	const refreshPrompts = async () => {
		const res = await api.prompts.list();
		// 过滤掉用户已删除的内置模板，同时翻译内置模板的 description
		res.templates = res.templates
			.filter((t) => t.userCreated || !deletedBuiltinNames.has(t.name))
			.map((tpl) => ({
				...tpl,
				description: translateBuiltinPromptDescription(tpl),
			}));
		setPromptsData(res);
	};

	/** 创建新 prompt template */
	const handleCreatePrompt = async () => {
		setCreatingPrompt(true);
		setError(null);
		try {
			await api.prompts.create({
				name: newPromptName,
				description: newPromptDescription,
			});
			setNewPromptName("");
			setNewPromptDescription("");
			await refreshPrompts();
			showToast(t("config.promptCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingPrompt(false);
		}
	};

	/** 确认删除 prompt template */
	const confirmDeletePrompt = async (target: PiPromptTemplateSummary) => {
		setError(null);
		if (target.userCreated) {
			try {
				await api.prompts.delete(target.path);
				await refreshPrompts();
				showToast(t("config.promptDeletedToast"));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		} else {
			// 内置模板：从显示列表中移除
			setDeletedBuiltinNames((prev) => new Set(prev).add(target.name));
			showToast(t("config.promptDeletedToast"));
		}
	};

	/** 打开 prompt template 编辑器 */
	const handleEditPrompt = async (template: PiPromptTemplateSummary) => {
		// 内置模板直接使用预加载的 content，无需从文件读取
		if (!template.userCreated) {
			setEditingPrompt(template);
			setEditPromptContent(template.content);
			setEditPromptLoading(false);
			setError(null);
			return;
		}
		setEditingPrompt(template);
		setEditPromptContent("");
		setEditPromptLoading(true);
		setError(null);
		try {
			const content = await api.prompts.edit(template.path);
			setEditPromptContent(content as string);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingPrompt(null);
		} finally {
			setEditPromptLoading(false);
		}
	};

	/** 取消编辑 prompt template */
	const handleCancelEditPrompt = () => {
		setEditingPrompt(null);
		setEditPromptContent("");
	};

	/** 保存 prompt template 编辑器内容 */
	const handleSaveEditPrompt = async () => {
		if (!editingPrompt || editPromptSaving) return;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				// 内置模板：先创建用户副本，再写入编辑内容
				const created = await api.prompts.create({
					name: editingPrompt.name,
					description: editingPrompt.description,
				});
				await api.prompts.edit(created.path, editPromptContent);
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent);
			}
			showToast(t("config.promptSavedToast"));
			setEditingPrompt(null);
			await refreshPrompts();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** Ctrl+S 快速保存：保存但不关闭弹框、不弹提示 */
	const handleRenamePrompt = async (template: { name: string; path: string }, newName: string) => {
		setError(null);
		try {
			await api.prompts.rename(template.name, newName);
			await refreshPrompts();
			showToast(t("config.promptRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleQuickSavePrompt = async () => {
		if (!editingPrompt || editPromptSaving) return;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				const created = await api.prompts.create({
					name: editingPrompt.name,
					description: editingPrompt.description,
				});
				await api.prompts.edit(created.path, editPromptContent);
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent);
			}
			await refreshPrompts();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** 从用户选择的 JSON 文件导入配置，成功后刷新当前 tab。 */
	const refreshSkills = async () => {
		const res = await api.skills.list();
		setSkillsData(res);
		if (res.locations[0] && !res.locations.some((item) => item.id === newSkillLocationId)) {
			setNewSkillLocationId(res.locations[0].id);
		}
	};

	const handleCreateSkill = async () => {
		setCreatingSkill(true);
		setError(null);
		try {
			await api.skills.create({
				name: newSkillName,
				description: newSkillDescription,
				locationId: newSkillLocationId,
			});
			setNewSkillName("");
			setNewSkillDescription("");
			await refreshSkills();
			showToast(t("config.skillCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingSkill(false);
		}
	};

	const handleToggleSkill = async (path: string, enabled: boolean) => {
		setError(null);
		try {
			await api.skills.toggle(path, enabled);
			await refreshSkills();
			showToast(enabled ? t("config.skillEnabledToast") : t("config.skillDisabledToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const confirmDeleteSkill = async () => {
		if (!deleteSkillConfirm) return;
		const target = deleteSkillConfirm;
		setDeleteSkillConfirm(null);
		setError(null);
		try {
			await api.skills.delete(target.path);
			await refreshSkills();
			showToast(t("config.skillDeletedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleRenameGlobalSkill = async (skill: PiSkillSummary, newName: string) => {
		setError(null);
		try {
			await api.skills.rename(skill.path, newName);
			await refreshSkills();
			showToast(t("config.skillRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleEditGlobalSkill = async (skill: PiSkillSummary) => {
		setEditingGlobalSkill(skill);
		setEditGlobalContent("");
		setEditGlobalLoading(true);
		setError(null);
		try {
			const { content, truncated } = await window.piDesktop.files.readContent(skill.path);
			if (truncated) showNotice(t("editor.truncatedNotice"), 4000, "warning");
			setEditGlobalContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingGlobalSkill(null);
		} finally {
			setEditGlobalLoading(false);
		}
	};

	// Ctrl+S / Cmd+S 快捷键保存 skill 编辑器
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s" && editingGlobalSkill && !editGlobalSaving) {
				e.preventDefault();
				void saveGlobalSkillEditor();
			}
		};
		if (editingGlobalSkill) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [editingGlobalSkill, editGlobalSaving]);

	const saveGlobalSkillEditor = async () => {
		if (!editingGlobalSkill || editGlobalSaving) return;
		setEditGlobalSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingGlobalSkill.path, editGlobalContent);
			setEditGlobalSaved(true);
			window.setTimeout(() => setEditGlobalSaved(false), 2000);
			await refreshSkills();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditGlobalSaving(false);
		}
	};

	/**
	 * 加载扩展列表。
	 * - forceRefresh=false：优先用主进程缓存（启动预热后通常秒开）
	 * - forceRefresh=true：手动刷新时强制重扫，并查询 npm 更新信息
	 */
	const refreshExtensions = async (forceRefresh = false) => {
		setExtensionsLoading(true);
		setError(null);
		try {
			const res = await api.extensions.list(forceRefresh);
			setExtensionsData(res);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExtensionsLoading(false);
		}
	};

	const confirmUninstallExtension = async () => {
		if (!uninstallExtensionConfirm) return;
		const target = uninstallExtensionConfirm;
		// 防御性检查：内置扩展不应出现在确认弹窗中
		if (target.builtIn) {
			setUninstallExtensionConfirm(null);
			return;
		}
		setUninstallExtensionConfirm(null);
		// 立刻进入卸载态以触发卡片退场动画，同时发起真实卸载；两者并行，避免“删完才闪一下”。
		setUninstallingExtensionSource(target.source);
		const exitAnimation = new Promise<void>((resolve) => {
			window.setTimeout(resolve, 280);
		});
		try {
			await Promise.all([
				api.extensions.uninstall(target.source, target.scope),
				exitAnimation,
			]);
			// 与禁用/手动刷新一致：强制重扫并跳过可能残留的 in-flight 缓存结果。
			await refreshExtensions(true);
			showToast(t("config.extensionUninstalledToast"));
		} catch (e) {
			// 配置页顶部红字容易被滚出视口；卸载失败用 error toast，用户能立刻看到。
			showNotice(
				t("config.extensionUninstallFailed", { error: formatIpcError(e) }),
				4500,
				"error",
			);
		} finally {
			setUninstallingExtensionSource(null);
		}
	};

	const handleImport = async () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const result = await api.config.import(text);
				if (!result.valid) {
					setError(result.error ?? t("config.importFailed"));
					return;
				}
				onSaved();
				// 导入已整体重写三份配置：必须当场丢弃全部草稿。否则旧 base 与旧 value
				// 会让 dirty 继续为真，关闭时「保存并关闭」把导入前的值写回去，
				// 恰好覆盖刚导入的内容 —— 而提示语还写着「保存」，用户看不出丢数据。
				discardAllDrafts();
				await loadConfig(tab, { force: true });
				showToast(t("config.imported"));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		};
		input.click();
	};

	const configNavItems: Array<{ id: ConfigTab; label: string }> = [
		{ id: "models", label: t("config.nav.models") },
		{ id: "auth", label: t("config.nav.auth") },
		{ id: "settings", label: t("config.nav.settings") },
		{ id: "trust", label: t("config.nav.trust") },
		{ id: "raw", label: t("config.nav.raw") },
	];

	/**
	 * 关闭守卫的 dirty 判据：每个 tab 都用「当前值与磁盘基线是否相等」，
	 * 而不是「有没有点过保存」。基线只在载入与真正落盘成功时推进（见各 persist*），
	 * 所以切 tab、Esc、点关闭的行为在所有 tab 上一致：有未保存内容就拦一次。
	 *
	 * 源文件 tab 是全文编辑：内容逐字比较即可，不需要结构化相等。
	 */
	const modelsDirty = !configValuesEqual(modelsData, modelsBaseline);
	const authDirty = !configValuesEqual(authData, authBaseline);
	const trustDirty = !configValuesEqual(trustData, trustBaseline);
	const rawDirty = rawContent !== rawBaseline;
	const settingsDirty = hasDraftChanges(settingsDraft, OMP_SETTINGS_PATHS);
	const configDirty = settingsDirty || modelsDirty || authDirty || trustDirty || rawDirty;

	/**
	 * 「保存并关闭」：逐个 tab 落盘，任一失败即停在弹层里。
	 *
	 * 顺序是**先全文、后结构化**：源文件 tab 写的是整个文件，先落它，结构化保存再叠在上面
	 * 才不会被全文覆盖。结构化写盘分两种：config.yml 走路径补丁（只动自己的键，全文里其它
	 * 编辑原样保留），models.json / trust.json 是整文件写（同一文件的全文编辑因此以结构化
	 * tab 为准 —— 那个 tab 上显示的就是用户最后设定的值）。
	 *
	 * 这里不调用 loadConfig：关闭后弹层就重载，回读只会把 loading 闪到当前 tab 上。
	 */
	const handleSaveAll = async (): Promise<boolean> => {
		// 每份都静默，成功提示在全部落盘后合并成一条
		if (rawDirty && !(await persistRaw(true))) return false;
		if (trustDirty && !(await persistTrust(true))) return false;
		if (authDirty && !(await persistAuth(true))) return false;
		if (modelsDirty && !(await persistModels(true))) return false;
		if (settingsDirty && !(await handleSaveSettings(true))) return false;
		showToast(t("config.saved"));
		return true;
	};

	/**
	 * 丢弃全部 tab 的未保存草稿：把各基线对齐到当前值（不改显示），设置草稿重建。
	 *
	 * 只在两个地方用：弹层关闭（草稿不该活过本次会话）、导入成功（磁盘三份文件已被
	 * 整体重写，旧草稿再落盘就会覆盖刚导入的内容）。其它 tab 的数据不必在这里清空——
	 * 切过去时 loadConfig 会重新回读并把基线一起换掉。
	 */
	const discardAllDrafts = () => {
		setSettingsDraft(createDraft({}));
		setModelsBaseline(modelsData);
		setAuthBaseline(authData);
		setTrustBaseline(trustData);
		setRawBaseline(rawContent);
	};

	// 弹层关闭时组件并不卸载（App 常驻渲染 <ConfigModal open=…>），草稿会活过本次会话。
	// 不主动丢弃的话：「放弃更改」只是关窗，遗留 dirty 草稿下次打开就变成幽灵拦截，
	// 并被「保存并关闭」重新写回磁盘。
	useEffect(() => {
		if (open) return;
		discardAllDrafts();
		// 只在关闭那一刻对齐，不随数据变化重跑
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	if (!open) return null;

	return (
		<ModalSurface
			open={open}
			onRequestClose={onClose}
			title={t("config.title")}
			className="config-modal"
			dirty={configDirty}
			onSaveBeforeClose={handleSaveAll}
			saving={saving}
			headerActions={
			section === "config" ? (
				<>
					<button className="config-btn primary" onClick={handleExport}>
						{t("common.export")}
					</button>
					<button className="config-btn blue" onClick={handleImport}>
						{t("common.import")}
					</button>
				</>
			) : undefined
			}
		>

			<div className="config-layout">
				<aside className="config-sidebar" aria-label={t("config.title")}>
					<div className="config-sidebar-group">
						<span>{t("config.group.config")}</span>
						{configNavItems.map((item) => (
							<button
								key={item.id}
								className={
									section === "config" && tab === item.id ? "active" : ""
								}
								onClick={() => {
									setSection("config");
									setTab(item.id);
								}}
							>
								{item.label}
							</button>
						))}
					</div>
					<div className="config-sidebar-group">
						<span>{t("config.group.agent")}</span>
						<button
							className={section === "extensions" ? "active" : ""}
							onClick={() => setSection("extensions")}
						>
							{t("config.nav.extensions")}
						</button>
						<button
							className={section === "skills" ? "active" : ""}
							onClick={() => setSection("skills")}
						>
							{t("config.nav.skills")}
						</button>
						<button
							className={section === "prompts" ? "active" : ""}
							onClick={() => setSection("prompts")}
						>
							{t("config.nav.prompts")}
						</button>
					</div>
					<div className="config-sidebar-group">
						<span>{t("config.group.other")}</span>
						<button
							className={section === "editors" ? "active" : ""}
							onClick={() => setSection("editors")}
						>
							{t("config.nav.editors")}
						</button>
					</div>
					<div className="config-sidebar-group">
						<span>{t("config.group.diagnostics")}</span>
						<button
							className={section === "logs" ? "active" : ""}
							onClick={() => setSection("logs")}
						>
							{t("config.nav.logs")}
						</button>
					</div>
				</aside>

				<main className="config-main">
					<div className="config-content">
				{loading && <div className="config-loading">{t("common.loading")}</div>}
				{error && <div className="config-error">{error}</div>}
				{section === "config" && configDiagnostic && (
					<ConfigDiagnosticCard
						diagnostic={configDiagnostic}
						onOpenDocs={() => api.app.openExternal(configDiagnostic.docsUrl)}
						onOpenRaw={() => setTab("raw")}
					/>
				)}

				{section === "config" && !loading && tab === "models" && (
					<ModelsTab
						data={modelsData}
						expandedProvider={expandedProvider}
						addingProvider={addingProvider}
						newProviderName={newProviderName}
						renamingProvider={renamingProvider}
						renameValue={renameValue}
						fetchingProvider={fetchingProvider}
						fetchedModels={fetchedModels}
						fetchModelsErrorByProvider={fetchModelsErrorByProvider}
						testingProvider={testingProvider}
						testResult={testResult}
						testModelIdByProvider={testModelIdByProvider}
						saving={saving}
						ompDefault={ompDefault}
						onSetOmpDefault={handleSetOmpDefault}
						onClearOmpDefault={handleClearOmpDefault}
						onToggleProvider={(name) =>
							setExpandedProvider(expandedProvider === name ? null : name)
						}
						onStartAddProvider={() => {
							setAddingProvider(true);
							setNewProviderName("");
						}}
						onCancelAddProvider={() => setAddingProvider(false)}
						onChangeNewProviderName={setNewProviderName}
						onConfirmAddProvider={handleAddProvider}
						onStartRename={handleStartRename}
						onChangeRenameValue={setRenameValue}
						onConfirmRename={handleConfirmRename}
						onCancelRename={handleCancelRename}
						onDeleteProvider={handleDeleteProvider}
						onDuplicateProvider={handleDuplicateProvider}
						onDeleteProviders={handleDeleteProviders}
						onAddModel={handleAddModel}
						onUpdateModel={handleUpdateModel}
						onUpdateModelXhigh={handleUpdateModelXhigh}
						onDeleteModel={handleDeleteModel}
						onFetchModels={handleFetchModels}
						onTestProvider={handleTestProvider}
						onChangeTestModelId={(providerName, modelId) =>
							setTestModelIdByProvider((current) => ({
								...current,
								[providerName]: modelId,
							}))
						}
						onClearTestResult={() => setTestResult(null)}
						onSave={handleSaveModels}
						onChangeProvider={(name, field, value) => {
							const provider = modelsData.providers[name];
							if (!provider) return;
							setModelsData({
								...modelsData,
								providers: {
									...modelsData.providers,
									[name]: { ...provider, [field]: value },
								},
							});
						}}
					/>
				)}

				{section === "config" && !loading && tab === "auth" && (
					<AuthTab
						data={authData}
						expandedAuth={expandedAuth}
						addingAuth={addingAuth}
						newAuthName={newAuthName}
						saving={saving}
						modelsData={modelsData}
						onToggleAuth={(name) =>
							setExpandedAuth(expandedAuth === name ? null : name)
						}
						onStartAddAuth={() => {
							setAddingAuth(true);
							setNewAuthName("");
						}}
						onCancelAddAuth={() => setAddingAuth(false)}
						onChangeNewAuthName={setNewAuthName}
						onConfirmAddAuth={(name, key) => handleAddAuth(name, key)}
					onDeleteAuths={handleDeleteAuths}
					onDeleteAuth={handleDeleteAuth}
					onUpdate={handleUpdateAuth}
					onSave={handleSaveAuth}
				/>
				)}

				{section === "config" && !loading && tab === "settings" && (
					<SettingsTab
						data={settingsData}
						saving={saving}
						modelsData={modelsData}
						discoveredModels={discoveredModels}
						// SettingsTab 用 writeOmpPath 返回新的根对象，这里整体换掉草稿 value
						onChange={(next) => setSettingsDraft((prev) => setDraftValue(prev, next))}
						onSave={handleSaveSettings}
					/>
				)}

				{section === "logs" && !loading && (
					<LogsTab />
				)}

				{section === "skills" && !loading && (
					editingGlobalSkill ? (
						<ModalSurface
							open
							onRequestClose={() => setEditingGlobalSkill(null)}
							size="medium"
							title={`${editingGlobalSkill.name} · SKILL.md`}
							className="prompts-editor-modal"
						elevated
						>
							{editGlobalLoading ? (
								<div className="config-empty">{t("common.loading")}</div>
							) : (
								<div className="prompts-monaco-wrap">
									<LazyMonacoEditor
										value={editGlobalContent}
										onChange={setEditGlobalContent}
									/>
							</div>
							)}
							{editGlobalSaved && <span className="file-diff-hint saved">{t("config.promptSavedHint")}</span>}
						</ModalSurface>
				) : (
						<SkillsTab
						data={skillsData}
						loading={loading}
						creating={creatingSkill}
						newName={newSkillName}
						newDescription={newSkillDescription}
						newLocationId={newSkillLocationId}
						onRefresh={refreshSkills}
						onOpenRoot={() => api.skills.openFolder()}
						onChangeNewName={setNewSkillName}
						onChangeNewDescription={setNewSkillDescription}
						onChangeNewLocation={setNewSkillLocationId}
						onCreate={handleCreateSkill}
						onToggle={(skill, enabled) => handleToggleSkill(skill.path, enabled)}
						onDelete={setDeleteSkillConfirm}
						onEdit={handleEditGlobalSkill}
						onRename={handleRenameGlobalSkill}
					/>
					)
				)}

				{section === "prompts" && !loading && (
					<PromptsTab
						data={promptsData}
						loading={loading}
						creating={creatingPrompt}
						newName={newPromptName}
						newDescription={newPromptDescription}
						editingTemplate={editingPrompt}
						editContent={editPromptContent}
						editLoading={editPromptLoading}
						editSaving={editPromptSaving}
						onRefresh={refreshPrompts}
						onOpenRoot={() => api.prompts.openFolder()}
						onChangeNewName={setNewPromptName}
						onChangeNewDescription={setNewPromptDescription}
						onCreate={handleCreatePrompt}
						onDelete={confirmDeletePrompt}
						onEdit={handleEditPrompt}
						onRename={handleRenamePrompt}
						onQuickSave={handleQuickSavePrompt}
						onCancelEdit={handleCancelEditPrompt}
						onChangeEditContent={setEditPromptContent}
						onSaveEdit={handleSaveEditPrompt}
					/>
				)}

				{section === "extensions" && (
					<ExtensionsTab
						data={extensionsData}
						loading={extensionsLoading}
						uninstallingSource={uninstallingExtensionSource}
						onRefresh={() => void refreshExtensions(true)}
						onUninstall={setUninstallExtensionConfirm}
					/>
				)}

				{section === "editors" && !loading && (
					<EditorsTab />
				)}

				{section === "config" && !loading && tab === "trust" && (
					<TrustTab
						data={trustData}
						saving={saving}
						onChange={setTrustData}
						onSave={handleSaveTrust}
					/>
				)}

				{section === "config" && !loading && tab === "raw" && (
					<RawTab
						fileName={rawFileName}
						content={rawContent}
						saving={saving}
						onChangeFileName={handleRawFileChange}
						onChangeContent={setRawContent}
						onSave={handleSaveRaw}
					/>
				)}
					</div>
				</main>
			</div>

			{deleteSkillConfirm && (
				<ConfirmDialog
					title={t("config.deleteSkillConfirmTitle")}
					message={t("config.deleteSkillConfirmBody", {
						name: deleteSkillConfirm.name,
					})}
					danger
					confirmLabel={t("common.delete")}
					onConfirm={() => void confirmDeleteSkill()}
					onCancel={() => setDeleteSkillConfirm(null)}
				>
					<small className="modal-radix-confirm-detail">{deleteSkillConfirm.path}</small>
				</ConfirmDialog>
			)}

			{uninstallExtensionConfirm && (
				<ConfirmDialog
					title={t("config.uninstallExtensionTitle")}
					message={t("config.uninstallExtensionBody", {
						source: uninstallExtensionConfirm.source,
					})}
					danger
					confirmLabel={t("config.uninstall")}
					onConfirm={confirmUninstallExtension}
					onCancel={() => setUninstallExtensionConfirm(null)}
				>
					{uninstallExtensionConfirm.path ? (
						<small className="modal-radix-confirm-detail">{uninstallExtensionConfirm.path}</small>
					) : null}
				</ConfirmDialog>
			)}

			{/* toast 已改用 sonner */}
			{deleteConfirm && (
				<ConfirmDialog
					title={deleteConfirm.title}
					message={deleteConfirm.message}
					danger
					confirmLabel={t("common.delete")}
					onConfirm={deleteConfirm.onConfirm}
					onCancel={() => setDeleteConfirm(null)}
				/>
			)}
		</ModalSurface>
	);
}

