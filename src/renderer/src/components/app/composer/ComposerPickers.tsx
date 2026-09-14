/** composer 选择器：模型 / 模式 / 思考档位 / 提示模板下拉。 */
import { useEffect, useRef, useState } from "react";
import {
	ChevronLeft,
	ChevronsUpDown,
	MoveDown,
	MoveUp,
	ChevronsDownUp,
	Eye,
	FileText,
	Pin,
	X,
	Star,
} from "lucide-react";
import { t } from "../../../i18n";
import { IconButton } from "../../ui/IconButton";
import type { ComposerAgentMode, AvailableModel } from "../../../../../shared/types";
import { THINKING_LEVELS } from "./thinkingLevels";

export function ModelPicker(props: {
	models: AvailableModel[];
	current?: { provider?: string; modelId?: string; modelName?: string };
	onClose: () => void;
	onPick: (model: AvailableModel) => void;
	/** 收藏的模型 ID 列表（格式：provider/modelId），收藏的模型独立置顶显示但仍保留在原供应商分组 */
	favoriteModels: string[];
	/** 切换收藏状态 */
	onToggleFavorite: (provider: string, modelId: string) => void;
	/** 当前 omp 默认模型 key（格式：provider/modelId）；不配对或未设置时为 undefined */
	defaultModelKey?: string;
	/** 将某模型设为 omp 默认模型（新会话初始模型），由调用方负责 IPC 写入与 toast */
	onSetDefault: (provider: string, modelId: string) => void;
}) {
	const [modelPickerSearch, setModelPickerSearch] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
		// 默认折叠所有供应商分组，避免长列表一次性铺开
		const set = new Set<string>();
		for (const m of props.models) {
			set.add(m.provider || 'other');
		}
		const favSet = new Set(props.favoriteModels ?? []);
		if (props.models.some(m => favSet.has(`${m.provider}/${m.id}`))) {
			set.add('__favorites__');
		}
		return set;
	});
	const normalizedSearch = modelPickerSearch.trim().toLowerCase();
	const selectedItemRef = useRef<HTMLButtonElement | null>(null);
	const modelPickerListRef = useRef<HTMLDivElement | null>(null);
	const currentModelKey = props.current?.provider && props.current?.modelId
		? `${props.current.provider}/${props.current.modelId}`
		: undefined;
	const favoritesSet = new Set(props.favoriteModels ?? []);

	// 搜索同时覆盖模型展示名、模型 id 和 provider,避免用户只记得任一字段时找不到模型。
	const filteredModels = normalizedSearch
		? props.models.filter((model) =>
				[
					model.name,
					model.id,
					model.provider,
					`${model.provider}/${model.id}`,
				]
					.filter(Boolean)
					.some((value) =>
						String(value).toLowerCase().includes(normalizedSearch),
					),
			)
		: props.models;

	// 收藏列表（从全部模型中提取，不移除原供应商分组下的显示）
	const favorites: AvailableModel[] = filteredModels.filter((model) =>
		favoritesSet.has(`${model.provider}/${model.id}`),
	);
	favorites.sort((a, b) => {
		const ap = a.provider ?? '';
		const bp = b.provider ?? '';
		if (ap !== bp) return ap.localeCompare(bp);
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});

	// 全量模型按供应商分组（收藏模型也保留在原分组）
	const groupedModels = filteredModels.reduce<Record<string, AvailableModel[]>>((groups, model) => {
		const provider = model.provider || 'other';
		if (!groups[provider]) {
			groups[provider] = [];
		}
		groups[provider].push(model);
		return groups;
	}, {});
	// 每个分组按展示名排序
	for (const provider of Object.keys(groupedModels)) {
		groupedModels[provider].sort((a, b) =>
			(a.name ?? a.id).localeCompare(b.name ?? b.id),
		);
	}

	// 供应商排序：常见的放前面
	const providerOrder = ['anthropic', 'openai', 'google', 'deepseek', 'other'];
	const sortedProviders = Object.keys(groupedModels).sort((a, b) => {
		const aIndex = providerOrder.indexOf(a);
		const bIndex = providerOrder.indexOf(b);
		if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
		if (aIndex !== -1) return -1;
		if (bIndex !== -1) return 1;
		return a.localeCompare(b);
	});
	const providerGroupKeys = favorites.length > 0
		? ['__favorites__', ...sortedProviders]
		: sortedProviders;
	const allProviderGroupsCollapsed =
		providerGroupKeys.length > 0 && providerGroupKeys.every((groupKey) => collapsedGroups.has(groupKey));

	const renderModelRow = (model: AvailableModel) => {
		const modelKey = `${model.provider}/${model.id}`;
		const selected = modelKey === currentModelKey;
		const favorited = favoritesSet.has(modelKey);
		const isDefault = modelKey === props.defaultModelKey;
		const canSetDefault = Boolean(model.provider);
		return (
			<button
				ref={selected ? selectedItemRef : undefined}
				key={modelKey}
				className={`picker-palette-item${selected ? " selected" : ""}`}
				onClick={() => props.onPick(model)}
			>
				{/* 收藏/取消收藏按钮：填充星为收藏，空心为未收藏 */}
				<span
					className={`model-favorite-star${favorited ? ' favorited' : ''}`}
					title={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
					onClick={(e) => {
						e.stopPropagation();
						props.onToggleFavorite(model.provider, model.id);
					}}
				>
					<Star size={14} strokeWidth={1.8} fill={favorited ? 'currentColor' : 'none'} />
				</span>
				<span className="picker-palette-label">{model.name ?? model.id}</span>
				<span className="picker-palette-desc">
					{model.provider}/{model.id}
				</span>
				{/* 设为默认按钮：钉住 = omp 新会话初始模型。已默认时填充态不可点；无供应商的模型无法表达默认供应商，置灰不可点 */}
				<span
					className={`model-default-pin${isDefault ? " is-default" : ""}${!canSetDefault ? " disabled" : ""}`}
					title={isDefault ? t("app.modelIsDefault") : canSetDefault ? t("app.modelSetDefault") : t("app.modelNoProvider")}
					onClick={(e) => {
						e.stopPropagation();
						if (isDefault || !canSetDefault) return;
						props.onSetDefault(model.provider, model.id);
					}}
				>
					<Pin size={14} strokeWidth={1.8} fill={isDefault ? 'currentColor' : 'none'} aria-hidden="true" />
				</span>
				{selected && <span className="picker-palette-check">✓</span>}
			</button>
		);
	};

	// 打开选模型弹框时，自动滚动到当前选中的模型行，避免用户从头翻找。
	useEffect(() => {
		if (!selectedItemRef.current) return;
		// 在布局完成后再滚动，确保列表已渲染且尺寸稳定。
		requestAnimationFrame(() => {
			selectedItemRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
		});
	}, [currentModelKey, normalizedSearch]);

	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div
				className="picker-palette model-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="picker-palette-header">
					<span>{t("app.modelPickerTitle")}</span>
					<IconButton
						className="picker-palette-close"
						label={t("common.close")}
						onClick={props.onClose}
					>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</IconButton>
				</div>
				<div className="picker-palette-search">
					<div className="picker-palette-search-row">
						<input
							autoFocus
							value={modelPickerSearch}
							onChange={(event) => setModelPickerSearch(event.target.value)}
							placeholder={t("app.modelPickerSearch")}
							className={providerGroupKeys.length > 0 ? "has-actions" : undefined}
						/>
						{providerGroupKeys.length > 0 && (
							<div className="picker-palette-actions">
								<IconButton
									className="picker-palette-action-icon"
									label={t("app.modelCollapseAllProviders")}
									title={t("app.modelCollapseAllProviders")}
									onClick={() => {
										// 一键折叠当前结果里的所有 provider 分组，适合像 IDE 一样快速收拢长列表。
										setCollapsedGroups((prev) => {
											const next = new Set(prev);
											for (const groupKey of providerGroupKeys) next.add(groupKey);
											return next;
										});
									}}
									disabled={allProviderGroupsCollapsed}
								>
									<ChevronsDownUp size={13} strokeWidth={2} aria-hidden="true" />
								</IconButton>
								<IconButton
									className="picker-palette-action-icon"
									label={t("app.modelExpandAllProviders")}
									title={t("app.modelExpandAllProviders")}
									onClick={() => {
										// 展开当前结果里的所有 provider 分组，避免用户折叠后还要逐个恢复。
										setCollapsedGroups((prev) => {
											const next = new Set(prev);
											for (const groupKey of providerGroupKeys) next.delete(groupKey);
											return next;
										});
									}}
									disabled={!allProviderGroupsCollapsed}
								>
									<ChevronsUpDown size={13} strokeWidth={2} aria-hidden="true" />
								</IconButton>
							</div>
						)}
					</div>
				</div>
				<div className="picker-palette-list" ref={modelPickerListRef}>
					<button
						type="button"
						className="picker-palette-scroll-btn picker-palette-scroll-top"
						title={t("app.modelScrollToTop")}
						onClick={() => modelPickerListRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
					>
						<MoveUp size={14} strokeWidth={1.8} aria-hidden="true" />
					</button>
					{/* 收藏分区：置于最顶部，可折叠 */}
					{favorites.length > 0 && (
						<div className="model-group model-favorites-group">
							<div
								className={`model-group-header${collapsedGroups.has('__favorites__') ? ' collapsed' : ''}`}
								onClick={() => {
									setCollapsedGroups(prev => {
										const next = new Set(prev);
										if (next.has('__favorites__')) next.delete('__favorites__');
										else next.add('__favorites__');
										return next;
									});
								}}
							>
								<span className={`model-favorites-arrow${collapsedGroups.has('__favorites__') ? ' collapsed' : ''}`}>
									<Star size={14} strokeWidth={1.8} fill='currentColor' />
								</span>
								{t("app.modelFavorites")}
								<span className="model-group-count">{favorites.length}</span>
							</div>
							{!collapsedGroups.has('__favorites__') && favorites.map(renderModelRow)}
						</div>
					)}
					{/* 其余模型按供应商分组 */}
					{sortedProviders.map((provider) => (
						<div key={provider} className="model-group">
							<div
								className={`model-group-header${collapsedGroups.has(provider) ? ' collapsed' : ''}`}
								onClick={() => {
									setCollapsedGroups(prev => {
										const next = new Set(prev);
										if (next.has(provider)) next.delete(provider);
										else next.add(provider);
										return next;
									});
								}}
							>
								{provider}
								<span className="model-group-count">{groupedModels[provider].length}</span>
							</div>
							{!collapsedGroups.has(provider) && groupedModels[provider].map(renderModelRow)}
						</div>
					))}
					{favorites.length === 0 && sortedProviders.length === 0 && (
						<div className="picker-palette-empty">{t("app.modelPickerEmpty")}</div>
					)}
					<button
						type="button"
						className="picker-palette-scroll-btn picker-palette-scroll-bottom"
						title={t("app.modelScrollToBottom")}
						onClick={() => {
							const el = modelPickerListRef.current;
							if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
						}}
					>
						<MoveDown size={14} strokeWidth={1.8} aria-hidden="true" />
					</button>
				</div>
			</div>
		</div>
	);
}
export function ComposerModePicker(props: {
	currentMode: ComposerAgentMode;
	onClose: () => void;
	onPick: (mode: ComposerAgentMode) => void;
}) {
	const items = [
		{
			value: "normal" as const,
			labelKey: "app.composerModeNormal" as const,
			descriptionKey: "app.composerModeNormalDesc" as const,
		},
		{
			value: "plan" as const,
			labelKey: "app.composerModePlan" as const,
			descriptionKey: "app.composerModePlanDesc" as const,
		},
	];

	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div
				className="picker-palette composer-mode-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="picker-palette-header">
					<div className="thinking-picker-header-content">
						<span>{t("app.composerModeTitle")}</span>
					</div>
					<IconButton
						className="picker-palette-close"
						label={t("common.close")}
						onClick={props.onClose}
					>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</IconButton>
				</div>
				<div className="picker-palette-list">
					{items.map((item) => {
						const selected = item.value === props.currentMode;
						return (
							<button
								key={item.value}
								className={`picker-palette-item${selected ? " selected" : ""}`}
								onClick={() => props.onPick(item.value)}
							>
								<span className="picker-palette-label">{t(item.labelKey)}</span>
								<span className="picker-palette-desc">{t(item.descriptionKey)}</span>
								{selected && <span className="picker-palette-check">✓</span>}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
export function ThinkingPicker(props: {
	current?: string;
	onClose: () => void;
	onPick: (level: string) => void;
}) {
	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div
				className="picker-palette thinking-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="picker-palette-header">
					<div className="thinking-picker-header-content">
						<span>{t("app.thinkingPickerTitle")}</span>
						<small className="thinking-picker-hint">
							{t("app.thinkingPickerHint")}
						</small>
					</div>
					<IconButton
						className="picker-palette-close"
						label={t("common.close")}
						onClick={props.onClose}
					>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</IconButton>
				</div>
				<div className="picker-palette-list">
					{THINKING_LEVELS.map((level) => {
						const selected = level.value === props.current;
						return (
							<button
								key={level.value}
								className={`picker-palette-item${selected ? " selected" : ""}`}
								onClick={() => props.onPick(level.value)}
							>
								<span className="picker-palette-label">{t(level.labelKey)}</span>
								<span className="picker-palette-desc">{t(level.descriptionKey)}</span>
								{selected && <span className="picker-palette-check">✓</span>}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
/**
 * Prompt Template 选择器：列出 ~/.omp/agent/prompts/ 下所有 .md 模板，
 * 点击后将模板内容插入到 composer 输入框。
 */
export function PromptTemplatePicker(props: {
	templates: Array<{
		name: string;
		path: string;
		description: string;
		content: string;
		scope?: "global" | "project";
		argumentHint?: string;
	}>;
	onClose: () => void;
	onPick: (template: {
		name: string;
		path: string;
		description: string;
		content: string;
		scope?: "global" | "project";
		argumentHint?: string;
	}) => void;
}) {
	type TemplateItem = typeof props.templates[number];
	const [search, setSearch] = useState("");
	const [previewTemplate, setPreviewTemplate] = useState<TemplateItem | null>(null);
	const normalizedSearch = search.trim().toLowerCase();
	const filtered: TemplateItem[] = normalizedSearch
		? props.templates.filter(
				(t: TemplateItem) =>
					t.name.toLowerCase().includes(normalizedSearch) ||
					t.description.toLowerCase().includes(normalizedSearch),
			)
		: props.templates;

	const templateList = filtered.map((template) => (
		<div
			key={template.path}
			className="picker-palette-item-wrap"
		>
			<button
				className="picker-palette-item"
				onClick={() => props.onPick(template)}
			>
				<FileText size={14} strokeWidth={1.8} aria-hidden="true" />
				<span className="picker-palette-label">/{template.name}</span>
				{template.argumentHint && (
					<code className="picker-palette-arg-hint">{template.argumentHint}</code>
				)}
				<span className="picker-palette-desc">{template.description}</span>
			</button>
			<button
				className="picker-palette-preview-btn"
				title={t("common.preview")}
				onClick={(e) => {
					e.stopPropagation();
					setPreviewTemplate(
						previewTemplate?.path === template.path ? null : template,
					);
				}}
			>
				<Eye size={14} strokeWidth={1.8} />
			</button>
		</div>
	));

	const emptyState = filtered.length === 0 && (
		<div className="picker-palette-empty">
			{search
				? t("app.promptTemplateSearchEmpty")
				: t("app.promptTemplateEmpty")}
		</div>
	);

	return (
		<div className="picker-backdrop" onClick={props.onClose}>
			<div
				className="picker-palette prompt-template-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="picker-palette-header">
					{previewTemplate ? (
						<>
							<button
								className="picker-preview-back-btn"
								onClick={() => setPreviewTemplate(null)}
								title={t("app.promptTemplateBackToPicker")}
							>
								<ChevronLeft size={16} strokeWidth={2.2} />
							</button>
							<span>{t("app.promptTemplatePreviewTitle", { name: "/" + previewTemplate.name })}</span>
						</>
					) : (
						<span>{t("app.promptTemplatePickerTitle")}</span>
					)}
					<IconButton
						className="picker-palette-close"
						label={t("common.close")}
						onClick={props.onClose}
					>
						<X size={16} strokeWidth={2.2} aria-hidden="true" />
					</IconButton>
				</div>
				{!previewTemplate && (
					<div className="picker-palette-search">
						<input
							autoFocus
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder={t("app.promptTemplateSearchPlaceholder")}
						/>
					</div>
				)}
				{previewTemplate ? (
					<div className="picker-preview-inline">
						<pre className="picker-preview-content">{previewTemplate.content}</pre>
					</div>
				) : (
					<div className="picker-palette-list">
						{templateList}
						{emptyState}
					</div>
				)}
				{/* 旧的弹框预览已移除，改为内联显示 */}
			</div>
		</div>
	);
}
