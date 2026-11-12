import { useState, useRef, useEffect } from "react";
import { X, Check } from "lucide-react";
import type { ModelsFile } from "./configTypes";
import {
	readOmpPath,
	setEnabledModelSelected,
	writeOmpPath,
} from "../../../shared/ompConfigSettings";
import type { OmpSettingsPath } from "../../../shared/ompConfigSettings";
import { t } from "../i18n";

// ── 可用模型列表聚合（含供应商信息,供 enabledModels 多选用） --
interface ModelRecord {
	id: string;
	provider: string;
	name?: string;
}

function collectModels(
	modelsData?: ModelsFile,
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>,
): ModelRecord[] {
	const map = new Map<string, ModelRecord>();
	if (modelsData) {
		for (const [provider, cfg] of Object.entries(modelsData.providers)) {
			for (const m of cfg.models) {
				const key = `${provider}/${m.id}`;
				if (!map.has(key)) {
					map.set(key, { id: m.id, provider, name: m.name });
				}
			}
		}
	}
	if (discoveredModels) {
		for (const [provider, models] of Object.entries(discoveredModels)) {
			for (const m of models) {
				const key = `${provider}/${m.id}`;
				if (!map.has(key)) {
					map.set(key, { id: m.id, provider, name: m.name });
				}
			}
		}
	}
	return [...map.values()];
}

// ── config.yml 草稿的点路径读写 ────────────────────────
// 设置页只编辑 OMP_SETTINGS_PATHS 里列出的键；保存时由 ConfigModal 按
// 「草稿 vs 载入基线」生成点路径补丁，主进程只写改动过的键（保留注释与其它键）。
// 读写实现与主进程共用 shared/ompConfigSettings，避免两套剪枝/遍历语义漂移。

/** 有限非负整数（token 数/重试次数），非法输入返回 undefined = 不写该键。 */
function nonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;
}

// ── Settings Tab ----------------------------------------
export function SettingsTab(props: {
	/** config.yml 解析后的映射（草稿） */
	data: Record<string, unknown>;
	saving: boolean;
	modelsData?: ModelsFile;
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>;
	onChange: (data: Record<string, unknown>) => void;
	onSave: () => void;
}) {
	const { data } = props;
	const update = (path: OmpSettingsPath, value: unknown) =>
		props.onChange(writeOmpPath(data, path, value));

	// 保留原始数组：enabledModels 允许 path-scoped 对象条目（{ path, models }），
	// 只把字符串当作可勾选的模型 id；对象条目在写回时原样保留，不能被 UI 过滤掉。
	const enabledModels = Array.isArray(data.enabledModels) ? data.enabledModels : undefined;
	const retryMaxRetries = readOmpPath(data, "retry.maxRetries");
	const retryBaseDelay = readOmpPath(data, "retry.baseDelayMs");
	const compactionEnabled = readOmpPath(data, "compaction.enabled");
	const reserveTokens = readOmpPath(data, "compaction.reserveTokens");
	const keepRecentTokens = readOmpPath(data, "compaction.keepRecentTokens");

	/** 数字输入：留空 = 删除该键（omp 用自己的默认值）。 */
	const numberInput = (path: OmpSettingsPath, value: unknown, placeholder?: string, step?: number) => (
		<input
			className="config-settings-input"
			type="number"
			min={0}
			step={step}
			value={nonNegativeInt(value) ?? ""}
			placeholder={placeholder}
			onChange={(e) => {
				const raw = e.target.value.trim();
				if (!raw) {
					update(path, undefined);
					return;
				}
				const parsed = Number(raw);
				if (!Number.isFinite(parsed)) return;
				update(path, Math.max(0, Math.floor(parsed)));
			}}
		/>
	);

	return (
		<div className="config-settings-tab">
			<div className="config-toolbar">
				<span className="config-settings-section-hint">{t("config.settings.yamlSourceHint")}</span>
				<button className="config-btn primary" onClick={props.onSave} disabled={props.saving}>
					{props.saving ? t("common.saving") : t("common.save")}
				</button>
			</div>
			<div className="config-settings-list">
				{/* enabledModels 始终显示在最前面 */}
				<div className="config-settings-row">
					<span className="config-settings-key">{t("config.label.enabledModels")}</span>
					<EnabledModelsInput
						value={enabledModels}
						models={collectModels(props.modelsData, props.discoveredModels)}
						onChange={(v) => update("enabledModels", v)}
					/>
				</div>

				{/* ── 重试配置（config.yml retry.*） ── */}
				<div className="config-retry-group">
					<div className="config-settings-row config-retry-header-row">
						<span className="config-settings-section-title">{t("config.retry.title")}</span>
						<span className="config-settings-section-hint">{t("config.retry.hint")}</span>
					</div>
					<div className="config-settings-row">
						<span className="config-settings-key">{t("config.retry.maxRetries")}</span>
						{numberInput("retry.maxRetries", retryMaxRetries, "10")}
					</div>
					<div className="config-settings-row">
						<span className="config-settings-key">{t("config.retry.baseDelayMs")}</span>
						{numberInput("retry.baseDelayMs", retryBaseDelay, "500", 100)}
					</div>
				</div>

				{/* ── 会话压缩（config.yml compaction.*） ── */}
				<div className="config-retry-group">
					<div className="config-settings-row config-retry-header-row">
						<span className="config-settings-section-title">{t("config.compaction.title")}</span>
						<span className="config-settings-section-hint">{t("config.compaction.hint")}</span>
					</div>
					<div className="config-settings-row">
						<span className="config-settings-key">{t("config.compaction.enabled")}</span>
						<label className="config-checkbox-label">
							<input
								type="checkbox"
								checked={compactionEnabled !== false}
								onChange={(e) => update("compaction.enabled", e.target.checked)}
							/>
							<span>
								{compactionEnabled !== false
									? t("config.compaction.enabledOn")
									: t("config.compaction.enabledOff")}
							</span>
						</label>
					</div>
					<div className="config-settings-row">
						<span className="config-settings-key" title={t("config.compaction.reserveTokensHint")}>
							{t("config.compaction.reserveTokens")}
						</span>
						{numberInput(
							"compaction.reserveTokens",
							reserveTokens,
							t("config.compaction.reserveTokensAuto"),
							1024,
						)}
					</div>
					<div className="config-settings-row">
						<span className="config-settings-key" title={t("config.compaction.keepRecentTokensHint")}>
							{t("config.compaction.keepRecentTokens")}
						</span>
						{numberInput("compaction.keepRecentTokens", keepRecentTokens, "20000", 1024)}
					</div>
					<div className="config-settings-row config-retry-header-row">
						<span className="config-settings-section-hint">{t("config.compaction.manualHint")}</span>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * enabledModels 下拉多选：按供应商分组，搜索过滤可用模型，勾选加入列表。
 * 选中的模型 ID 直接写入 enabledModels 数组，取消勾选即从列表中移除。
 * 输入含 * 或 ? 时可添加 glob 模式。
 */
function EnabledModelsInput(props: {
	/** 字符串 = 模型 id；对象 = path-scoped 条目（{ path, models }），UI 不展示但写回时必须原样保留 */
	value?: unknown[];
	/** 按模型的 provider/id 分组，每项含 provider 信息 */
	models: ModelRecord[];
	onChange: (value: unknown[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(() => {
		// 默认折叠所有供应商分组
		const set = new Set<string>();
		for (const m of props.models) {
			set.add(m.provider);
		}
		return set;
	});
	const containerRef = useRef<HTMLDivElement>(null);
	const entries = props.value ?? [];
	const selected = new Set(
		entries.filter((entry): entry is string => typeof entry === "string"),
	);

	// 点击外部关闭下拉
	useEffect(() => {
		if (!open) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, [open]);

	const toggleModel = (id: string) => {
		props.onChange(setEnabledModelSelected(entries, id, !selected.has(id)));
	};

	const removeSelected = (id: string) => {
		props.onChange(setEnabledModelSelected(entries, id, false));
	};

	// 过滤 & 按供应商分组
	const normalizedFilter = filter.trim().toLowerCase();
	const isGlob = filter.includes("*") || filter.includes("?");
	const filteredModels = normalizedFilter && !isGlob
		? props.models.filter((m) =>
				[m.id, m.name, m.provider, `${m.provider}/${m.id}`]
					.filter(Boolean)
					.some((v) => v!.toLowerCase().includes(normalizedFilter)),
			)
		: props.models;

	// 按供应商分组
	const grouped = filteredModels.reduce<Record<string, ModelRecord[]>>((acc, m) => {
		if (!acc[m.provider]) acc[m.provider] = [];
		acc[m.provider].push(m);
		return acc;
	}, {});

	const providerNames = Object.keys(grouped).sort((a, b) => {
		const order = ["anthropic", "openai", "google", "deepseek", "other"];
		const ai = order.indexOf(a);
		const bi = order.indexOf(b);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});

	const hasResults = providerNames.length > 0 || isGlob;

	return (
		<div ref={containerRef} className="config-enabled-models">
			<div className="config-enabled-models-tags" onClick={() => setOpen(true)}>
				{[...selected].map((id) => (
					<span key={id} className="config-enabled-models-tag">
						<span>{id}</span>
						<button
							type="button"
							className="config-enabled-models-tag-remove"
							onClick={(e) => {
								e.stopPropagation();
								removeSelected(id);
							}}
						>
							<X size={12} />
						</button>
					</span>
				))}
				<span className="config-enabled-models-trigger-text">
					{selected.size === 0
						? t("config.settings.enabledModelsPlaceholder")
						: `${selected.size} ${t("config.settings.enabledModelsSelected")}`}
				</span>
			</div>

			{open && (
				<div className="config-enabled-models-dropdown">
					<div className="config-enabled-models-dropdown-search">
						<input
							autoFocus
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder={t("config.settings.enabledModelsSearchPlaceholder")}
						/>
					</div>
					<div className="config-enabled-models-dropdown-list">
						{/* glob 模式行：输入含 * 或 ? 时显示，可勾选为自定义模式 */}
						{filter && isGlob && (
							<div className="config-enabled-models-glob-row">
								<button
									type="button"
									className={`config-enabled-models-glob-add${selected.has(filter) ? " selected" : ""}`}
									onClick={() => toggleModel(filter)}
								>
									<span className="config-enabled-models-checkbox">
										{selected.has(filter) && <Check size={12} />}
									</span>
									<span className="config-enabled-models-glob-label">{filter}</span>
									<span className="config-enabled-models-glob-hint">{t("config.settings.enabledModelsGlobHint")}</span>
								</button>
							</div>
						)}
						{hasResults && providerNames.map((provider) => (
							<div key={provider} className="config-enabled-provider-group">
								{/* 供应商分组头：点击折叠/展开 */}
								<button
									type="button"
									className={`config-enabled-provider-header${collapsed.has(provider) ? " collapsed" : ""}`}
									onClick={() => {
										setCollapsed((prev) => {
											const next = new Set(prev);
											if (next.has(provider)) next.delete(provider);
											else next.add(provider);
											return next;
										});
									}}
								>
									<span className="config-enabled-provider-name">{provider}</span>
									<span className="config-enabled-provider-count">{grouped[provider].length}</span>
								</button>
								{!collapsed.has(provider) && grouped[provider].map((m) => (
									<label
										key={`${m.provider}/${m.id}`}
										className={`config-enabled-models-option${selected.has(m.id) ? " selected" : ""}`}
										onClick={() => toggleModel(m.id)}
									>
										<span className="config-enabled-models-checkbox">
											{selected.has(m.id) && <Check size={12} />}
										</span>
										<span className="config-enabled-model-label">{m.name ?? m.id}</span>
										<span className="config-enabled-model-provider">{m.provider}/{m.id}</span>
									</label>
								))}
							</div>
						))}
						{!hasResults && (
							<div className="config-enabled-models-empty">{t("app.modelPickerEmpty")}</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
