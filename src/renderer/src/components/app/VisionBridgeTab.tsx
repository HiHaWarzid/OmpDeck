import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AppSettings } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";

/**
 * 视觉桥设置 tab：给非视觉模型"眼睛"。
 * 发送带图片的消息时，主进程经 OpenAI 兼容端点把图片转成文本描述注入上下文。
 * 配置项直接写入 draftSettings.visionBridge（嵌套对象整体替换），保存时随设置弹框统一提交。
 * 结构与其余设置 tab 一致：settings-section 分区 + TextField/Button 共享组件。
 *
 * 便捷选择：读 ~/.omp/agent 的 models.json（provider 级 apiKey 兜底 auth.json），
 * 只列出「OpenAI 兼容 chat completions 协议 + 用户在模型配置页勾选了图片输入
 * （model.input 含 "image"）」的模型——勾选即是用户对"支持图片输入"的确认，
 * 未勾选/未标注 input（如自动拉取添加）的模型一律不列。
 * 选中即回填 baseUrl / apiKey / model 三个字段（快照，不与 models.json 联动）。
 * 手动 TextField 入口保留，作为自定义端点（非 OpenAI 兼容 / 未在 models.json 配置）的兜底。
 */

type PresetEntry = {
	provider: string;
	modelId: string;
	baseUrl: string;
	apiKey: string;
};

/** "自定义（手动填写）" 选项 key：与模型 value（provider/modelId）区分 */
const CUSTOM_KEY = "__custom__";

type PresetLoadState =
	| { status: "loading" }
	| { status: "ready"; presets: PresetEntry[] }
	| { status: "error" };

type ProviderLike = Record<string, unknown> & { models?: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 未知/缺失的 api 按 openai-completions 处理（与 ConfigManager.normalizeApiType 一致）；
 *  responses 系列端点不是 /chat/completions，视觉桥发不出去，必须排除。 */
function isChatCompletionsCompat(api: unknown): boolean {
	const value = typeof api === "string" ? api.trim().toLowerCase() : "";
	return (
		value === "" ||
		value === "openai-completions" ||
		value === "openai-chat-completions"
	);
}

/** 视觉候选的充分条件：用户在模型配置页勾选了图片输入（input 显式含 "image"）。
 *  未勾选/未标注（含自动拉取添加的模型）一律不是视觉桥候选。 */
function isImageInputEnabled(input: unknown): boolean {
	return (
		Array.isArray(input) &&
		input.some((item) => typeof item === "string" && item.trim() === "image")
	);
}

function normalizeBaseUrl(value: unknown): string {
	return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function normalizeModelId(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** 从 models.json / auth.json 聚合候选：
 *  - provider 的 api 需为 chat completions 兼容（未声明按默认）；
 *  - provider 必须给出可用 key（models.json apiKey 优先，auth.json 兜底），
 *    否则选出来也无法请求，只会让"测试连接"失败；
 *  - 模型 input 必须显式含 "image"（用户已在模型配置页确认图片输入）；
 *  - 排序：按 provider/模型 id。 */
function collectPresets(models: unknown, auth: unknown): PresetEntry[] {
	if (!isObject(models) || !isObject(models.providers)) return [];
	const authProviders = isObject(auth) ? auth : {};

	const pickApiKey = (providerName: string, provider: ProviderLike): string => {
		const inline =
			typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";
		if (inline) return inline;
		const authEntry = authProviders[providerName];
		const key = isObject(authEntry) ? authEntry.key : undefined;
		return typeof key === "string" ? key.trim() : "";
	};

	const presets: PresetEntry[] = [];
	for (const [providerName, rawProvider] of Object.entries(models.providers)) {
		if (!isObject(rawProvider)) continue;
		const provider = rawProvider as ProviderLike;
		if (!isChatCompletionsCompat(provider.api)) continue;
		const baseUrl = normalizeBaseUrl(provider.baseUrl);
		const apiKey = pickApiKey(providerName, provider);
		if (!baseUrl || !apiKey) continue;
		const modelsList = Array.isArray(provider.models) ? provider.models : [];
		for (const rawModel of modelsList) {
			// 字符串简写（models.json 手写 "models": ["gpt-4o"]）无 input 标注 → 跳过；
			// 只有对象形态才能带 input 勾选标记
			if (!isObject(rawModel)) continue;
			const model = rawModel as Record<string, unknown>;
			const modelId = normalizeModelId(model.id);
			if (!modelId) continue;
			if (!isImageInputEnabled(model.input)) continue;
			presets.push({ provider: providerName, modelId, baseUrl, apiKey });
		}
	}
	presets.sort((a, b) => {
		const byProvider = a.provider.localeCompare(b.provider);
		if (byProvider !== 0) return byProvider;
		return a.modelId.localeCompare(b.modelId);
	});
	return presets;
}

export function VisionBridgeTab(props: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => void;
}) {
	const vb = props.settings.visionBridge;
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{
		ok: boolean;
		message: string;
	} | null>(null);
	const [presetState, setPresetState] = useState<PresetLoadState>({ status: "loading" });

	const patch = (field: keyof typeof vb, value: string | boolean | number) => {
		props.onChange({ visionBridge: { ...vb, [field]: value } });
	};

	const loadPresets = async () => {
		setPresetState({ status: "loading" });
		try {
			const [modelsRes, authRes] = await Promise.all([
				window.piDesktop.config.getModels(),
				window.piDesktop.config.getAuth(),
			]);
			setPresetState({
				status: "ready",
				presets: collectPresets(modelsRes.parsed, authRes.parsed),
			});
		} catch {
			setPresetState({ status: "error" });
		}
	};

	// 打开 tab 时读一次（每次进入都重新同步 models.json/auth.json 的最新改动）。
	useEffect(() => {
		let cancelled = false;
		(async () => {
			setPresetState({ status: "loading" });
			try {
				const [modelsRes, authRes] = await Promise.all([
					window.piDesktop.config.getModels(),
					window.piDesktop.config.getAuth(),
				]);
				if (cancelled) return;
				setPresetState({
					status: "ready",
					presets: collectPresets(modelsRes.parsed, authRes.parsed),
				});
			} catch {
				if (!cancelled) setPresetState({ status: "error" });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const presets = presetState.status === "ready" ? presetState.presets : [];

	// draft 与某个预设完全一致（端点 + 模型 id）时，下拉显示该预设；否则落到"自定义"，
	// 保证用户手动微调后刷新不会丢。apiKey 不参与匹配（值敏感，改了 key 不算"变自定义"）。
	const trimmedBaseUrl = vb.baseUrl.trim().replace(/\/+$/, "");
	const matchedPreset = presets.find(
		(preset) =>
			preset.baseUrl === trimmedBaseUrl && preset.modelId === vb.model.trim(),
	) ?? null;
	const selectedValue = matchedPreset
		? `${matchedPreset.provider}/${matchedPreset.modelId}`
		: CUSTOM_KEY;

	const applyPreset = (key: string) => {
		if (key === CUSTOM_KEY) return;
		const preset = presets.find(
			(item) => `${item.provider}/${item.modelId}` === key,
		);
		if (!preset) return;
		props.onChange({
			visionBridge: {
				...vb,
				baseUrl: preset.baseUrl,
				apiKey: preset.apiKey,
				model: preset.modelId,
			},
		});
	};

	const presetHint =
		presetState.status === "loading"
			? t("settings.vision.presetLoading")
			: presetState.status === "error"
				? t("settings.vision.presetLoadError")
				: presets.length === 0
					? t("settings.vision.presetEmpty")
					: t("settings.vision.presetDesc");

	const runTest = async () => {
		setTesting(true);
		setTestResult(null);
		try {
			const result = await window.piDesktop.app.visionTest({
				baseUrl: vb.baseUrl,
				apiKey: vb.apiKey,
			});
			if (result.ok) {
				const sample = (result.models ?? []).slice(0, 8).join(", ");
				setTestResult({
					ok: true,
					message: sample
						? t("settings.vision.testSuccess", { models: sample })
						: t("settings.vision.testSuccessEmpty"),
				});
			} else {
				setTestResult({ ok: false, message: result.error ?? t("common.error") });
			}
		} catch (error) {
			setTestResult({
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setTesting(false);
		}
	};

	const presetOptions = [
		{ value: CUSTOM_KEY, label: t("settings.vision.customOption") },
		...presets.map((preset) => ({
			value: `${preset.provider}/${preset.modelId}`,
			label: (
				<span className="vision-model-option">
					<span className="vision-model-id">{preset.modelId}</span>
					<span className="vision-model-provider">{preset.provider}</span>
				</span>
			),
		})),
	];

	return (
		<section className="settings-section">
			<div className="settings-section-header">
				<strong>{t("settings.vision.section")}</strong>
			</div>
			<div className="settings-section-body">
				<label className="setting-switch-row">
					<span>
						<strong>{t("settings.vision.enabled")}</strong>
						<small>{t("settings.vision.enabledDesc")}</small>
					</span>
					<input
						type="checkbox"
						checked={vb.enabled}
						onChange={(event) => patch("enabled", event.target.checked)}
					/>
				</label>

				<div className="setting-field setting-field--after-switch">
					<span style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-control)", fontWeight: 500 }}>
						{t("settings.vision.presetPick")}
					</span>
					<div className="vision-preset-row">
						<div className="vision-preset-field">
							<SelectField
								label=""
								value={selectedValue}
								options={presetOptions}
								disabled={presetState.status !== "ready" || presets.length === 0}
								onChange={applyPreset}
							/>
						</div>
						<IconButton
							label={t("common.refresh")}
							title={t("common.refresh")}
							disabled={presetState.status === "loading"}
							onClick={() => void loadPresets()}
							className="vision-preset-refresh"
						>
							<RefreshCw size={15} strokeWidth={1.8} aria-hidden="true" />
						</IconButton>
					</div>
					<small className="ui-field-description">{presetHint}</small>
				</div>

				{/* 端点/Key/模型 ID 属技术文本，用等宽字体；类名由 .setting-field--mono 提供，其余样式走共享 TextField。
				    选择器选中后自动回填这三项；仍可手动修改（自定义端点兜底）。 */}
				<TextField
					className="setting-field setting-field--mono"
					label={t("settings.vision.baseUrl")}
					description={t("settings.vision.baseUrlDesc")}
					value={vb.baseUrl}
					placeholder="https://api.example.com/v1"
					onChange={(value) => patch("baseUrl", value)}
				/>
				<TextField
					className="setting-field setting-field--mono"
					label={t("settings.vision.apiKey")}
					description={t("settings.vision.apiKeyDesc")}
					value={vb.apiKey}
					type="password"
					onChange={(value) => patch("apiKey", value)}
				/>
				<TextField
					className="setting-field setting-field--mono"
					label={t("settings.vision.model")}
					description={t("settings.vision.modelDesc")}
					value={vb.model}
					placeholder="gpt-4o-mini"
					onChange={(value) => patch("model", value)}
				/>

				{/* 提示词：版式与设置页其他 textarea（SettingTextarea）保持一致 */}
				<div className="setting-field">
					<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
						<strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-control)", fontWeight: 500 }}>
							{t("settings.vision.prompt")}
						</strong>
						<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)", lineHeight: 1.4 }}>
							{t("settings.vision.promptDesc")}
						</small>
					</div>
					<textarea
						value={vb.prompt}
						rows={4}
						onChange={(event) => patch("prompt", event.target.value)}
						style={{
							width: "100%",
							fontFamily: "var(--font-family-mono)",
							fontSize: "var(--font-size-sm)",
							padding: "var(--space-2) var(--space-3)",
							border: "1px solid var(--color-border-subtle)",
							borderRadius: "var(--radius-sm)",
							background: "var(--color-bg-input)",
							color: "var(--color-text-primary)",
							resize: "vertical",
							lineHeight: "var(--line-height-body)",
						}}
					/>
				</div>

				<TextField
					className="setting-field setting-field--mono"
					label={t("settings.vision.timeout")}
					description={t("settings.vision.timeoutDesc")}
					value={String(vb.timeoutMs)}
					type="number"
					min={5000}
					step={1000}
					onChange={(value) => patch("timeoutMs", Math.max(5000, Number(value) || 120000))}
				/>

				<div className="setting-field">
					<Button
						buttonSize="sm"
						loading={testing}
						disabled={!vb.baseUrl.trim() || !vb.apiKey.trim()}
						onClick={runTest}
					>
						{testing ? t("settings.vision.testing") : t("settings.vision.test")}
					</Button>
					{testResult && (
						<small
							className={`setting-status ${testResult.ok ? "success" : "error"}`}
							style={{ wordBreak: "break-all" }}
						>
							{testResult.message}
						</small>
					)}
				</div>
			</div>
		</section>
	);
}
