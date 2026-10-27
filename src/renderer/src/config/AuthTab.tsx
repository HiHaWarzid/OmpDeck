import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { IconButton } from "../components/ui/IconButton";
import type { OmpLoginProvider, OmpLogoutAccount } from "../../../shared/types";
import type { AuthFile, ModelsFile } from "./configTypes";
import { SecretInput } from "./ConfigShared";
import { showNotice } from "../utils/notice";

// 内置供应商预设；凭据写入 models.yml 的 providers.<name>.apiKey，
// 参考 omp models 文档（不是已废弃的 auth.json）。
const PRESET_PROVIDERS = [
	{ value: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY", url: "https://console.anthropic.com/" },
	{ value: "openai", label: "OpenAI", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys" },
	{ value: "google", label: "Google Gemini", env: "GEMINI_API_KEY", url: "https://aistudio.google.com/apikey" },
	{ value: "deepseek", label: "DeepSeek", env: "DEEPSEEK_API_KEY", url: "https://platform.deepseek.com/api_keys" },
	{ value: "mistral", label: "Mistral", env: "MISTRAL_API_KEY", url: "https://console.mistral.ai/api-keys/" },
	{ value: "nvidia", label: "NVIDIA NIM", env: "NVIDIA_API_KEY", url: "https://build.nvidia.com/explore/discover" },
	{ value: "xai", label: "xAI (Grok)", env: "XAI_API_KEY", url: "https://console.x.ai/" },
	{ value: "groq", label: "Groq", env: "GROQ_API_KEY", url: "https://console.groq.com/keys" },
	{ value: "cerebras", label: "Cerebras", env: "CEREBRAS_API_KEY", url: "https://cloud.cerebras.ai/" },
	{ value: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/keys" },
	{ value: "puppyrouter", label: "PuppyRouter", env: "PUPPYROUTER_API_KEY", url: "https://puppyrouter.com" },
	{ value: "together", label: "Together AI", env: "TOGETHER_API_KEY", url: "https://api.together.ai/" },
	{ value: "fireworks", label: "Fireworks AI", env: "FIREWORKS_API_KEY", url: "https://fireworks.ai/api-keys" },
	{ value: "huggingface", label: "Hugging Face", env: "HF_TOKEN", url: "https://huggingface.co/settings/tokens" },
	{ value: "ant-ling", label: "Ant Ling (蚂蚁灵想)", env: "ANT_LING_API_KEY", url: "" },
	{ value: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", env: "CLOUDFLARE_API_KEY", url: "https://dash.cloudflare.com/" },
	{ value: "cloudflare-workers-ai", label: "Cloudflare Workers AI", env: "CLOUDFLARE_API_KEY", url: "https://dash.cloudflare.com/" },
	{ value: "vercel-ai-gateway", label: "Vercel AI Gateway", env: "AI_GATEWAY_API_KEY", url: "https://vercel.com/" },
	{ value: "azure-openai-responses", label: "Azure OpenAI", env: "AZURE_OPENAI_API_KEY", url: "https://portal.azure.com/" },
	{ value: "zai", label: "Z.AI", env: "ZAI_API_KEY", url: "" },
	{ value: "zai-coding-cn", label: "Z.AI Coding (China)", env: "ZAI_CODING_CN_API_KEY", url: "" },
	{ value: "opencode", label: "OpenCode Zen", env: "OPENCODE_API_KEY", url: "" },
	{ value: "opencode-go", label: "OpenCode Go", env: "OPENCODE_API_KEY", url: "" },
	{ value: "kimi-coding", label: "Kimi For Coding", env: "KIMI_API_KEY", url: "" },
	{ value: "minimax", label: "MiniMax", env: "MINIMAX_API_KEY", url: "" },
	{ value: "minimax-cn", label: "MiniMax (China)", env: "MINIMAX_CN_API_KEY", url: "" },
	// Command Code：pi 内置 provider,env 取自 compat/rules/auth/commandcode.kdl。
	// 复数 env 表明 pi 同时接受 COMMAND_CODE_API_KEY 和 COMMANDCODE_API_KEY,展示第一个。
	{ value: "commandcode", label: "Command Code", env: "COMMANDCODE_API_KEY", url: "https://commandcode.ai/studio" },
	{ value: "xiaomi", label: "Xiaomi MiMo", env: "XIAOMI_API_KEY", url: "" },
	{ value: "xiaomi-token-plan-cn", label: "Xiaomi MiMo Token (China)", env: "XIAOMI_TOKEN_PLAN_CN_API_KEY", url: "" },
	{ value: "xiaomi-token-plan-ams", label: "Xiaomi MiMo Token (Amsterdam)", env: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", url: "" },
	{ value: "xiaomi-token-plan-sgp", label: "Xiaomi MiMo Token (Singapore)", env: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", url: "" },
];

export function AuthTab(props: {
	data: AuthFile;
	expandedAuth: string | null;
	addingAuth: boolean;
	newAuthName: string;
	saving: boolean;
	/** 已配置的模型/服务商数据，用于 provider / model 下拉选项 */
	modelsData?: ModelsFile;
	onToggleAuth: (name: string) => void;
	onStartAddAuth: () => void;
	onCancelAddAuth: () => void;
	onChangeNewAuthName: (name: string) => void;
	onConfirmAddAuth: (name?: string, key?: string) => void;
	onDeleteAuth: (provider: string) => void;
	onDeleteAuths: (providers: string[]) => void;
	onUpdate: (provider: string, field: "key", value: string) => void;
	onSave: () => void;
}) {
	const { data, expandedAuth, saving } = props;
	const providers = Object.keys(data);
	const [selectingProvider, setSelectingProvider] = useState(false);
	const [selectedProvider, setSelectedProvider] = useState("");
	const [customProviderName, setCustomProviderName] = useState("");
	const [newAuthKey, setNewAuthKey] = useState("");
	const [showGuide, setShowGuide] = useState(false);
	const [batchMode, setBatchMode] = useState(false);
	const [selectedAuths, setSelectedAuths] = useState(new Set());

	// omp 原生 OAuth：provider 列表和凭据都必须由运行中的 agent 提供，
	// 因此先解析一个可用 agent；没有会话时只展示提示，不发 RPC。
	const [oauthProviders, setOauthProviders] = useState<OmpLoginProvider[] | null>(null);
	const [oauthAgentId, setOauthAgentId] = useState<string | null>(null);
	const [oauthBusy, setOauthBusy] = useState<string | null>(null);
	const [oauthAccounts, setOauthAccounts] = useState<Record<string, OmpLogoutAccount[]>>({});

	const findAgent = async () => {
		const list = await window.piDesktop.agents.list();
		const running = list.find(
			(agent) => agent.status === "idle" || agent.status === "running" || agent.status === "starting",
		);
		return running ?? null;
	};

	const loadOauthProviders = async () => {
		let agent;
		try {
			agent = await findAgent();
		} catch {
			setOauthAgentId(null);
			setOauthProviders([]);
			return;
		}
		if (!agent) {
			setOauthAgentId(null);
			setOauthProviders([]);
			return;
		}
		setOauthAgentId(agent.id);
		try {
			setOauthProviders(await window.piDesktop.agents.getLoginProviders(agent.id));
		} catch {
			// Agent 存在但 RPC 失败（旧版 omp 无该命令）：保留 agentId，提示“不支持”
			// 而不是误报“没有运行中的 Agent”。
			setOauthProviders([]);
		}
	};

	useEffect(() => {
		void loadOauthProviders();
	}, []);

	// 配置弹框可能在启动 Agent 之前就打开过，聚焦时重新探测可避免「明明有会话却提示无 Agent」。
	useEffect(() => {
		const onFocus = () => void loadOauthProviders();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	const startLogin = async (provider: OmpLoginProvider) => {
		if (!oauthAgentId) return;
		setOauthBusy(provider.id);
		try {
			await window.piDesktop.agents.login(oauthAgentId, provider.id);
			await loadOauthProviders();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 6000, "error");
		} finally {
			setOauthBusy(null);
		}
	};

	const loadAccounts = async (providerId: string) => {
		if (!oauthAgentId) return;
		try {
			const accounts = await window.piDesktop.agents.getLogoutAccounts(oauthAgentId, providerId);
			setOauthAccounts((prev) => ({ ...prev, [providerId]: accounts }));
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 5000, "error");
		}
	};

	const logoutAccount = async (providerId: string, account: OmpLogoutAccount) => {
		if (!oauthAgentId) return;
		setOauthBusy(providerId);
		try {
			await window.piDesktop.agents.logout(oauthAgentId, providerId, account.credentialId);
			const accounts = await window.piDesktop.agents.getLogoutAccounts(oauthAgentId, providerId);
			setOauthAccounts((prev) => ({ ...prev, [providerId]: accounts }));
			await loadOauthProviders();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 5000, "error");
		} finally {
			setOauthBusy(null);
		}
	};

	// 从预设列表获取供应商信息
	const presetProvider = selectedProvider ? PRESET_PROVIDERS.find(p => p.value === selectedProvider) : undefined;

	return (
		<div className="config-auth-tab">
			<div className="config-oauth">
				<div className="config-oauth-header">
					<div>
						<strong>{t("config.oauthSection")}</strong>
						<small>{t("config.oauthSectionDesc")}</small>
					</div>
					<IconButton
						label={t("common.refresh")}
						onClick={() => void loadOauthProviders()}
					>
						<RefreshCw size={14} aria-hidden="true" />
					</IconButton>
				</div>
				{oauthProviders === null ? (
					<div className="config-oauth-empty">{t("common.loading")}</div>
				) : oauthProviders.length === 0 ? (
					<div className="config-oauth-empty">
						{oauthAgentId ? t("config.oauthUnsupported") : t("config.oauthNoAgent")}
					</div>
				) : (
					<div className="config-oauth-list">
						{oauthProviders.map((provider) => (
							<div key={provider.id} className="config-oauth-row">
								<div className="config-oauth-info">
									<strong>{provider.name}</strong>
									<small>
										{provider.id}
										{provider.authenticated ? ` · ${t("config.oauthAuthenticated")}` : ""}
										{!provider.available ? ` · ${t("config.oauthUnavailable")}` : ""}
									</small>
								</div>
								<div className="config-oauth-actions">
									{provider.authenticated && (
										<button
											className="config-btn"
											onClick={() => {
												if (oauthAccounts[provider.id]) {
													setOauthAccounts((prev) => {
														const next = { ...prev };
														delete next[provider.id];
														return next;
													});
												} else {
													void loadAccounts(provider.id);
												}
											}}
											disabled={oauthBusy !== null}
										>
											{t("config.oauthManage")}
										</button>
									)}
									<button
										className="config-btn primary"
										onClick={() => void startLogin(provider)}
										disabled={oauthBusy !== null || !provider.available || !oauthAgentId}
									>
										{oauthBusy === provider.id
											? t("common.saving")
											: provider.authenticated
												? t("config.oauthRelogin")
												: t("config.oauthLogin")}
									</button>
								</div>
								{oauthAccounts[provider.id] && (
									<div className="config-oauth-accounts">
										{oauthAccounts[provider.id].length === 0 ? (
											<small>{t("config.oauthNoAccounts")}</small>
										) : (
											oauthAccounts[provider.id].map((account) => (
												<div key={account.credentialId} className="config-oauth-account">
													<span>
														{account.label}
														{account.detail ? ` · ${account.detail}` : ""}
													</span>
													<button
														className="config-btn danger-fill"
														disabled={oauthBusy !== null}
														onClick={() => void logoutAccount(provider.id, account)}
													>
														{t("config.oauthLogout")}
													</button>
												</div>
											))
										)}
									</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>
			<div className="config-toolbar">
				<span className="config-count">
					{t("config.count.auth", { count: providers.length })}
				</span>
				<div className="config-toolbar-actions">
					<button
						className="config-btn"
						onClick={() => {
							setSelectingProvider(true);
							setSelectedProvider("");
							setCustomProviderName("");
							setNewAuthKey("");
						}}
						disabled={saving}
					>
						{t("config.addAuth")}
					</button>
					<button
						className="config-btn"
						onClick={() => setShowGuide(!showGuide)}
						disabled={saving}
					>
						{t("config.authGuide")}
					</button>
					<button
						className="config-btn danger-fill"
						onClick={() => {
							if (batchMode) {
								setBatchMode(false);
								setSelectedAuths(new Set());
							} else {
								setBatchMode(true);
							}
						}}
						disabled={saving || providers.length === 0}
					>
						{batchMode ? t("common.cancel") : t("common.deleteBatch")}
					</button>
					{batchMode && (
						<button
							className="config-btn danger-fill"
							onClick={() => {
								if (selectedAuths.size > 0) {
									props.onDeleteAuths([...selectedAuths] as string[]);
									setSelectedAuths(new Set());
									setBatchMode(false);
								}
							}}
							disabled={selectedAuths.size === 0}
						>
							{t("common.deleteSelected")} ({selectedAuths.size})
						</button>
					)}
					<button
						className="config-btn primary"
						onClick={props.onSave}
						disabled={saving}
					>
						{saving ? t("common.saving") : t("common.save")}
					</button>
				</div>
			</div>

			{/* 使用引导 */}
			{showGuide && (
				<div className="config-auth-guide">
					<div className="config-auth-guide-header">
						<strong>{t("config.authGuideTitle")}</strong>
						<button className="config-icon-btn" onClick={() => setShowGuide(false)}>×</button>
					</div>
					<div className="config-auth-guide-body">
						<p>{t("config.authGuideDesc")}</p>
						<ul>
							<li>{t("config.authGuideStep1")}</li>
							<li>{t("config.authGuideStep2")}</li>
							<li>{t("config.authGuideStep3")}</li>
						</ul>
						<p className="config-auth-guide-note">
							{t("config.authGuideNote")}{" "}
							<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">
								omp docs <ExternalLink size={12} />
							</a>
						</p>
					</div>
				</div>
			)}

			{/* 选择供应商弹窗 */}
			{selectingProvider && (
				<div className="config-auth-selector">
					<div className="config-auth-selector-header">
						<strong>{t("config.authSelectProvider")}</strong>
						<button className="config-icon-btn" onClick={() => setSelectingProvider(false)}>×</button>
					</div>
					<div className="config-auth-selector-list">
						{PRESET_PROVIDERS.map((provider) => {
							const alreadyConfigured = providers.includes(provider.value);
							return (
								<button
									key={provider.value}
									className={`config-auth-selector-item${selectedProvider === provider.value ? " selected" : ""}${alreadyConfigured ? " configured" : ""}`}
									onClick={() => {
										setSelectedProvider(provider.value);
									}}
								>
									<span className="config-auth-selector-name">{provider.label}</span>
									<span className="config-auth-selector-id">{provider.value}</span>
									{alreadyConfigured && (
										<span className="config-auth-selector-badge">{t("config.configured")}</span>
									)}
								</button>
							);
						})}
						{/* 从 models.json 读取已配置的服务商 */}
						{props.modelsData && Object.keys(props.modelsData.providers).length > 0 && (
							<>
								<div className="config-auth-selector-separator">
									<span>{t("config.authFromModels")}</span>
								</div>
								{Object.keys(props.modelsData.providers).map((providerName) => {
									const alreadyConfigured = providers.includes(providerName);
									return (
										<button
											key={providerName}
											className={`config-auth-selector-item${selectedProvider === providerName ? " selected" : ""}${alreadyConfigured ? " configured" : ""}`}
											onClick={() => {
												setSelectedProvider(providerName);
											}}
										>
											<span className="config-auth-selector-name">{providerName}</span>
											<span className="config-auth-selector-id">{t("config.fromModels")}</span>
											{alreadyConfigured && (
												<span className="config-auth-selector-badge">{t("config.configured")}</span>
											)}
										</button>
									);
								})}
							</>
						)}
					</div>
					<div className="config-auth-selector-bottom">
						<p className="config-auth-selector-custom-hint">
							<span className="config-auth-selector-custom-label">{t("config.authCustomHint")}</span>
							<input
								value={customProviderName}
								onChange={(e) => {
									setCustomProviderName(e.target.value);
									if (e.target.value) setSelectedProvider("");
								}}
								placeholder={t("config.authCustomPlaceholder")}
							/>
						</p>
					</div>
					{(selectedProvider || customProviderName.trim()) && (
						<div className="config-auth-selector-key">
							<label>{t("config.field.apiKey")}</label>
							<SecretInput
								value={newAuthKey}
								onChange={setNewAuthKey}
							/>
						</div>
					)}
					<div className="config-auth-selector-actions">
						{selectedProvider && presetProvider && (
							<div className="config-auth-selector-info">
								{t("config.authEnvVar")}: <code>{presetProvider.env}</code>
								{presetProvider.url && (
									<a href={presetProvider.url} target="_blank" rel="noreferrer">
										{t("config.authGetKey")} <ExternalLink size={10} />
									</a>
								)}
							</div>
						)}
						<button
							className="config-btn primary"
							onClick={() => {
								const finalName = customProviderName.trim() || selectedProvider;
								if (!finalName) return;
								// 直接传入 finalName 和 newAuthKey，添加后自动展开，用户只需点顶栏保存
								props.onConfirmAddAuth(finalName, newAuthKey);
								setSelectingProvider(false);
							}}
							disabled={!selectedProvider && !customProviderName.trim()}
						>
							{t("config.authAddSelected")}
						</button>
						<button className="config-btn" onClick={() => setSelectingProvider(false)}>
							{t("common.cancel")}
						</button>
					</div>
				</div>
			)}

			<div className="config-auth-list">
				{providers.map((name) => {
					const auth = data[name];
					const isExpanded = expandedAuth === name;
					return (
						<div
							key={name}
							className={`config-auth-card ${isExpanded ? "editing" : ""}`}
						>
							<div
								className="config-auth-card-header"
								onClick={() => props.onToggleAuth(name)}
							>
						{batchMode && (
							<label className="config-batch-checkbox" onClick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									checked={selectedAuths.has(name)}
									onChange={(e) => {
										e.stopPropagation();
										setSelectedAuths(prev => {
											const next = new Set(prev);
											if (next.has(name)) next.delete(name);
											else next.add(name);
											return next;
										});
									}}
								/>
							</label>
						)}
								<span className="config-auth-provider">{name}</span>
								<span className="config-auth-key-preview">
									{auth.key
										? `${auth.key.slice(0, 10)}••••••${auth.key.slice(-4)}`
										: t("config.authKeyPreviewEmpty")}
								</span>
								<div className="config-provider-actions">
									<button
										className="config-icon-btn danger"
										onClick={(e) => {
											e.stopPropagation();
											props.onDeleteAuth(name);
										}}
										title={t("common.delete")}
									>
										<Trash2 size={14} />
									</button>
									<span className="config-chevron">
										{isExpanded ? (
											<ChevronDown size={14} />
										) : (
											<ChevronRight size={14} />
										)}
									</span>
								</div>
							</div>
							{isExpanded && (
								<div className="config-provider-form">
									<div className="config-form-row">
										<label>{t("config.field.apiKey")}</label>
										<SecretInput
											value={auth.key ?? ""}
											onChange={(v) => props.onUpdate(name, "key", v)}
										/>
										<p className="config-field-hint">{t("config.authKeyHint")}</p>
									</div>
								</div>
							)}
						</div>
					);
				})}
				{providers.length === 0 && (
					<div className="config-empty">{t("config.authEmpty")}</div>
				)}
			</div>
		</div>
	);
}


