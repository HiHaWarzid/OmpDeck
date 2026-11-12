/**
 * 模型角色配置 tab：编辑 omp 的 modelRoles（config.yml），替代原视觉桥。
 *
 * omp 会话用不同模型承担不同角色：主对话(default)、快速/便宜(smol)、深度
 * 推理(slow)、看图(vision)、规划(plan)、提交信息(commit)、在线微型(tiny)、
 * 子任务(task)、顾问(advisor)。每个角色选择模型后写入 config.yml 的
 * `modelRoles.<role>: provider/modelId`，新会话生效。
 *
 * 本组件直接读 config.yml（config.getOmpRoles）与本地模型目录
 * （projects.listModels），不经过 AppSettings draft——角色属于 omp 配置面，
 * 改动立即写盘，与其它 tab 的"草稿+保存"语义解耦。
 *
 * 加载拆分：角色列表只依赖 config.yml 读取（毫秒级，立即渲染）；模型目录
 * （projects.listModels，首次会 fork pi 子进程，可能数秒）延迟到用户点开
 * 角色选择器时才拉取，避免打开 tab 被模型扫描拖慢。
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
	OMP_CHAT_MODEL_ROLES,
	OMP_MODEL_ROLES,
	formatRoleSelector,
	isValidOmpRoleSelector,
	ompRoleAcceptsModelKind,
	parseRoleSelector,
	sortProvidersByOrder,
	type OmpFallbackChains,
	type OmpModelPresets,
	type OmpModelRole,
	type OmpModelRoleStorage,
} from "../../../../shared/types/ompRoles";
import type { AvailableModel } from "../../../../shared/types";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";

/** 角色元数据：本地化由 i18n 键提供（settings.role.<key>.name/.desc）。 */
const ROLE_META: Array<{ role: OmpModelRole }> = OMP_MODEL_ROLES.map((role) => ({ role }));

type RoleAssignment = {
	selector: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

/** 模型目录加载态：首次点开选择器才拉取，之后缓存。 */
type ModelsState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; models: AvailableModel[] };

/** omp 模型选择弹层：一组可用模型（provider 分组、可搜索），选中回调。 */
function ModelListPopup(props: {
	role: OmpModelRole;
	modelsState: ModelsState;
	providerOrder: readonly string[];
	onPick: (model: AvailableModel) => void;
	onPickSelector: (selector: string) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const [customSelector, setCustomSelector] = useState("");
	const normalized = query.trim().toLowerCase();
	const models =
		props.modelsState.status === "ready" ? props.modelsState.models : [];
	const customValid = isValidOmpRoleSelector(customSelector);

	// 角色只接受对应 kind：default/smol 等选 chat，image/tts/stt/judge 各自
	// 只出现匹配条目；web 在 JSON 目录没有能力位，放宽到 chat + search。
	const byKind = models.filter((m) => ompRoleAcceptsModelKind(props.role, m.kind));
	const filtered = normalized
		? byKind.filter((m) =>
				[m.id, m.provider, m.name, `${m.provider}/${m.id}`]
					.filter(Boolean)
					.some((v) => String(v).toLowerCase().includes(normalized)),
			)
		: byKind;
	const groups = filtered.reduce<Record<string, AvailableModel[]>>((acc, m) => {
		const p = m.provider || "other";
		(acc[p] ??= []).push(m);
		return acc;
	}, {});
	// 分组顺序严格跟 omp `modelProviderOrder` 一致；未列出的供应商按字母序。
	const sortedGroups = sortProvidersByOrder(Object.keys(groups), props.providerOrder);
	return (
		<div className="model-roles-popup">
			<div className="model-roles-popup-header">
				<input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t("settings.modelRoles.pickerSearch")}
					className="model-roles-popup-search"
				/>
				<IconButton label={t("common.close")} onClick={props.onClose} className="model-roles-popup-close">
					<X size={15} strokeWidth={2} aria-hidden="true" />
				</IconButton>
			</div>
			{props.modelsState.status === "loading" && (
				<div className="model-roles-popup-empty">{t("settings.modelRoles.loading")}</div>
			)}
			{props.modelsState.status === "ready" && (
				<div className="model-roles-popup-list">
					{sortedGroups.length === 0 && (
						<div className="model-roles-popup-empty">{t("settings.modelRoles.pickerEmpty")}</div>
					)}
					{sortedGroups.map((provider) => (
						<div key={provider} className="model-roles-popup-group">
							<div className="model-roles-popup-group-title">{provider}</div>
							{groups[provider].map((m) => (
								<button
									key={`${provider}/${m.id}`}
									type="button"
									className="model-roles-popup-item"
									onClick={() => props.onPick(m)}
								>
									<span className="model-roles-popup-item-name">{m.name ?? m.id}</span>
									<span className="model-roles-popup-item-id">
										{provider}/{m.id}
										{m.kind && m.kind !== "chat" ? ` · ${m.kind}` : ""}
									</span>
								</button>
							))}
						</div>
					))}
				</div>
			)}
			{/* omp 选择器支持别名、候选列表与 :thinking 后缀，模型目录无法覆盖，
			    所以保留一个直接输入入口；合法性用 omp 同口径的校验提前拦截。 */}
			<form
				className="model-roles-popup-custom"
				onSubmit={(event) => {
					event.preventDefault();
					if (!customValid) return;
					props.onPickSelector(customSelector.trim());
				}}
			>
				<TextField
					label={t("settings.modelRoles.selectorLabel")}
					value={customSelector}
					placeholder={t("settings.modelRoles.selectorPlaceholder")}
					description={t("settings.modelRoles.selectorDesc")}
					onChange={setCustomSelector}
				/>
				<Button
					buttonSize="sm"
					type="submit"
					disabled={!customValid}
				>
					{t("settings.modelRoles.selectorApply")}
				</Button>
			</form>
		</div>
	);
}

export function ModelRolesTab() {
	const [roles, setRoles] = useState<Record<OmpModelRole, RoleAssignment> | null>(null);
	const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
	const [activeRole, setActiveRole] = useState<OmpModelRole | null>(null);
	const [modelsState, setModelsState] = useState<ModelsState>({ status: "idle" });
	const [savingRole, setSavingRole] = useState<OmpModelRole | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const popupRef = useRef<HTMLDivElement | null>(null);

	// 模型中心附加项：预设 / 循环顺序 / 回退链（都写 config.yml）。
	const [presets, setPresets] = useState<OmpModelPresets>({});
	const [presetName, setPresetName] = useState("");
	const [cycleDraft, setCycleDraft] = useState("");
	const [fallbackChains, setFallbackChains] = useState<OmpFallbackChains>({});
	const [fallbackRole, setFallbackRole] = useState<string>("default");
	const [fallbackDraft, setFallbackDraft] = useState("");
	const [providerOrderDraft, setProviderOrderDraft] = useState("");
	const [providerOrder, setProviderOrder] = useState<string[]>([]);
	const [roleStorage, setRoleStorage] = useState<OmpModelRoleStorage>("global");
	const [roleStorageDraft, setRoleStorageDraft] = useState<OmpModelRoleStorage>("global");
	const [extrasSaving, setExtrasSaving] = useState<string | null>(null);

	/** 只读 config.yml 的角色映射（快），不依赖模型目录扫描。 */
	const loadRoles = async () => {
		setLoadState("loading");
		try {
			const rolesState = await window.piDesktop.config.getOmpRoles();
			setRoles(rolesState);
			setLoadState("ready");
		} catch {
			setLoadState("error");
		}
	};

	/** 读取预设/循环/回退链；与角色读取相互独立，失败时保持空值。 */
	const loadExtras = async () => {
		try {
			const [nextPresets, nextCycle, nextFallbacks, nextProviderOrder, nextRoleStorage] =
				await Promise.all([
					window.piDesktop.config.getOmpModelPresets(),
					window.piDesktop.config.getOmpCycleOrder(),
					window.piDesktop.config.getOmpFallbackChains(),
					window.piDesktop.config.getOmpProviderOrder(),
					window.piDesktop.config.getOmpRoleStorage(),
				]);
			setPresets(nextPresets ?? {});
			setCycleDraft(nextCycle.join(", "));
			setFallbackChains(nextFallbacks ?? {});
			setProviderOrder(nextProviderOrder ?? []);
			setProviderOrderDraft((nextProviderOrder ?? []).join(", "));
			setRoleStorage(nextRoleStorage);
			setRoleStorageDraft(nextRoleStorage);
		} catch {
			// 旧版 omp 可能没有这些 RPC；附加项保持空态，不影响角色编辑。
		}
	};

	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoadState("loading");
			try {
				const rolesState = await window.piDesktop.config.getOmpRoles();
				if (cancelled) return;
				setRoles(rolesState);
				setLoadState("ready");
			} catch {
				if (!cancelled) setLoadState("error");
			}
		})();
		void loadExtras();
		return () => {
			cancelled = true;
		};
	}, []);

	/** 模型目录懒加载：幂等（首次点开才拉；主进程有全局缓存，后续复用）。 */
	const ensureModels = async () => {
		if (modelsState.status === "ready" || modelsState.status === "loading") return;
		setModelsState({ status: "loading" });
		try {
			const available = await window.piDesktop.projects
				.listModels(undefined, true)
				.catch(() => [] as AvailableModel[]);
			setModelsState({ status: "ready", models: available });
		} catch {
			setModelsState({ status: "ready", models: [] });
		}
	};

	// 点击"设置/更换"：拉模型目录（若未加载）并打开弹层
	const openPickerFor = (role: OmpModelRole) => {
		if (activeRole === role) {
			setActiveRole(null);
			return;
		}
		setActiveRole(role);
		void ensureModels();
	};

	// 点击外部关闭弹层
	useEffect(() => {
		if (!activeRole) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!popupRef.current?.contains(e.target as Node)) setActiveRole(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setActiveRole(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [activeRole]);

	const saveRoleSelector = async (role: OmpModelRole, selector: string) => {
		setSavingRole(role);
		setNotice(null);
		try {
			const result = await window.piDesktop.config.setOmpRole(role, selector);
			if (result.valid) {
				setRoles((prev) => {
					if (!prev) return prev;
					return { ...prev, [role]: parseRoleSelector(selector) };
				});
				setNotice(t("settings.modelRoles.saved", { role: t(`settings.role.${role}.name`) }));
				setActiveRole(null);
			} else {
				setNotice(result.error ?? t("settings.modelRoles.saveFailed"));
			}
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingRole(null);
		}
	};

	const clearRole = async (role: OmpModelRole) => {
		setSavingRole(role);
		setNotice(null);
		try {
			const result = await window.piDesktop.config.clearOmpRole(role);
			if (result.valid) {
				setRoles((prev) => {
					if (!prev) return prev;
					return { ...prev, [role]: { selector: "" } };
				});
				setNotice(t("settings.modelRoles.cleared", { role: t(`settings.role.${role}.name`) }));
			} else {
				setNotice(result.error ?? t("settings.modelRoles.saveFailed"));
			}
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingRole(null);
		}
	};

	const isSaving = (role: OmpModelRole) => savingRole === role;

	const reportResult = (result: { valid: boolean; error?: string }, successKey: TranslationKey) => {
		if (result.valid) setNotice(t(successKey));
		else setNotice(result.error ?? t("settings.modelRoles.saveFailed"));
	};

	const saveCurrentAsPreset = async () => {
		const name = presetName.trim();
		if (!name) return;
		setExtrasSaving("preset-save");
		setNotice(null);
		try {
			const result = await window.piDesktop.config.saveOmpModelPreset(name);
			reportResult(result, "settings.modelPresets.saved");
			if (result.valid) {
				setPresetName("");
				await loadExtras();
			}
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setExtrasSaving(null);
		}
	};

	const applyPreset = async (name: string) => {
		setExtrasSaving(`preset-apply-${name}`);
		setNotice(null);
		try {
			const result = await window.piDesktop.config.applyOmpModelPreset(name);
			reportResult(result, "settings.modelPresets.applied");
			if (result.valid) {
				await loadRoles();
				await loadExtras();
			}
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setExtrasSaving(null);
		}
	};

	const deletePreset = async (name: string) => {
		setExtrasSaving(`preset-delete-${name}`);
		setNotice(null);
		try {
			const result = await window.piDesktop.config.deleteOmpModelPreset(name);
			reportResult(result, "settings.modelPresets.deleted");
			if (result.valid) await loadExtras();
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setExtrasSaving(null);
		}
	};

	const saveCycleOrder = async () => {
		setExtrasSaving("cycle");
		setNotice(null);
		try {
			const order = cycleDraft
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
			const result = await window.piDesktop.config.setOmpCycleOrder(order);
			reportResult(result, "settings.modelCycle.saved");
			if (result.valid) await loadExtras();
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setExtrasSaving(null);
		}
	};

	const saveProviderOrder = async () => {
		setExtrasSaving("provider-order");
		setNotice(null);
		try {
			const order = providerOrderDraft
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
			const result = await window.piDesktop.config.setOmpProviderOrder(order);
			reportResult(result, "settings.modelProvider.saved");
			if (result.valid) await loadExtras();
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setExtrasSaving(null);
		}
	};

	const saveRoleStorage = async () => {
		setExtrasSaving("role-storage");
		setNotice(null);
		try {
			const result = await window.piDesktop.config.setOmpRoleStorage(roleStorageDraft);
			reportResult(result, "settings.modelStorage.saved");
			if (result.valid) await loadExtras();
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setExtrasSaving(null);
		}
	};

	/** 回退链整体写回：先合并本地状态，再提交完整映射（空链会删除该键）。 */
	const commitFallback = async (next: OmpFallbackChains, savingKey: string) => {
		setExtrasSaving(savingKey);
		setNotice(null);
		try {
			const result = await window.piDesktop.config.setOmpFallbackChains(next);
			reportResult(result, "settings.modelFallback.saved");
			if (result.valid) {
				setFallbackChains(next);
				setFallbackDraft("");
				await loadExtras();
			}
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setExtrasSaving(null);
		}
	};

	const addFallback = () => {
		const chain = fallbackDraft
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		if (!fallbackRole || chain.length === 0) return;
		void commitFallback({ ...fallbackChains, [fallbackRole]: chain }, "fallback-add");
	};

	const removeFallback = (key: string) => {
		const next = { ...fallbackChains };
		delete next[key];
		void commitFallback(next, `fallback-remove-${key}`);
	};

	const summary =
		loadState === "loading"
			? t("settings.modelRoles.loading")
			: loadState === "error"
				? t("settings.modelRoles.loadError")
				: roles
					? t("settings.modelRoles.sectionDesc")
					: "";

	return (
		<section className="settings-section">
			<div className="settings-section-header">
				<strong>{t("settings.modelRoles.section")}</strong>
				<small>{summary}</small>
			</div>
			<div className="settings-section-body">
				{loadState === "loading" && (
					<div className="setting-field">
						<small className="ui-field-description">{t("settings.modelRoles.loading")}</small>
					</div>
				)}
				{loadState === "error" && (
					<div className="setting-field">
						<small className="setting-status error">{t("settings.modelRoles.loadError")}</small>
						<Button buttonSize="sm" onClick={() => void loadRoles()}>
							{t("app.renderErrorRetry")}
						</Button>
					</div>
				)}
				{loadState === "ready" && roles && (
					<>
						<div className="model-roles-list">
							{ROLE_META.map(({ role }) => {
								const assignment = roles[role];
								const hasValue = Boolean(assignment?.selector);
								return (
									<div key={role} className="model-role-row">
										<div className="model-role-row-main">
											<span className="model-role-tag">{role}</span>
											<div className="model-role-info">
												<strong>{t(`settings.role.${role}.name`)}</strong>
												<small>{t(`settings.role.${role}.desc`)}</small>
											</div>
										</div>
										<div className="model-role-value">
											{hasValue ? (
												<code className="model-role-current" title={assignment.selector}>
													{assignment.selector}
												</code>
											) : (
												<span className="model-role-unset">{t("settings.modelRoles.unset")}</span>
											)}
										</div>
										<div className="model-role-actions">
											<Button
												buttonSize="sm"
												loading={isSaving(role)}
												disabled={isSaving(role)}
												onClick={() => openPickerFor(role)}
											>
												{hasValue ? t("settings.modelRoles.change") : t("settings.modelRoles.set")}
											</Button>
											{hasValue && (
												<Button
													buttonSize="sm"
													variant="ghost"
													disabled={isSaving(role)}
													onClick={() => void clearRole(role)}
												>
													{t("settings.modelRoles.clear")}
												</Button>
											)}
										</div>
										{activeRole === role && (
											<div className="model-role-picker" ref={popupRef}>
												<ModelListPopup
													role={role}
													modelsState={modelsState}
													providerOrder={providerOrder}
													onClose={() => setActiveRole(null)}
													onPick={(m) =>
														void saveRoleSelector(role, formatRoleSelector(m.provider, m.id))
													}
													onPickSelector={(selector) => void saveRoleSelector(role, selector)}
												/>
											</div>
										)}
									</div>
								);
							})}
						</div>

						<div className="model-extras">
							<div className="model-extras-section">
								<div className="settings-section-header">
									<strong>{t("settings.modelPresets.section")}</strong>
									<small>{t("settings.modelPresets.sectionDesc")}</small>
								</div>
								<div className="model-extras-form">
									<TextField
										label={t("settings.modelPresets.nameLabel")}
										value={presetName}
										placeholder={t("settings.modelPresets.namePlaceholder")}
										onChange={setPresetName}
									/>
									<Button
										buttonSize="sm"
										loading={extrasSaving === "preset-save"}
										disabled={!presetName.trim() || extrasSaving !== null}
										onClick={() => void saveCurrentAsPreset()}
									>
										{t("settings.modelPresets.saveCurrent")}
									</Button>
								</div>
								<div className="model-preset-list">
									{Object.keys(presets).length === 0 && (
										<small className="ui-field-description">
											{t("settings.modelPresets.empty")}
										</small>
									)}
									{Object.entries(presets).map(([name, preset]) => (
										<div key={name} className="model-preset-row">
											<div className="model-preset-info">
												<strong>{name}</strong>
												<small>
													{t("settings.modelPresets.roleCount", {
														count: String(Object.keys(preset.modelRoles).length),
													})}
													{preset.defaultThinkingLevel
														? ` · ${preset.defaultThinkingLevel}`
														: ""}
												</small>
											</div>
											<div className="model-role-actions">
												<Button
													buttonSize="sm"
													loading={extrasSaving === `preset-apply-${name}`}
													disabled={extrasSaving !== null}
													onClick={() => void applyPreset(name)}
												>
													{t("settings.modelPresets.apply")}
												</Button>
												<Button
													buttonSize="sm"
													variant="ghost"
													loading={extrasSaving === `preset-delete-${name}`}
													disabled={extrasSaving !== null}
													onClick={() => void deletePreset(name)}
												>
													{t("settings.modelPresets.delete")}
												</Button>
											</div>
										</div>
									))}
								</div>
							</div>

							<div className="model-extras-section">
								<div className="settings-section-header">
									<strong>{t("settings.modelCycle.section")}</strong>
									<small>{t("settings.modelCycle.sectionDesc")}</small>
								</div>
								<div className="model-extras-form">
									<TextField
										label={t("settings.modelCycle.orderLabel")}
										value={cycleDraft}
										placeholder={t("settings.modelCycle.orderPlaceholder")}
										description={t("settings.modelCycle.orderDesc")}
										onChange={setCycleDraft}
									/>
									<Button
										buttonSize="sm"
										loading={extrasSaving === "cycle"}
										disabled={extrasSaving !== null}
										onClick={() => void saveCycleOrder()}
									>
										{t("settings.modelCycle.save")}
									</Button>
								</div>
							</div>

							<div className="model-extras-section">
								<div className="settings-section-header">
									<strong>{t("settings.modelProvider.section")}</strong>
									<small>{t("settings.modelProvider.sectionDesc")}</small>
								</div>
								<div className="model-extras-form">
									<TextField
										label={t("settings.modelProvider.orderLabel")}
										value={providerOrderDraft}
										placeholder={t("settings.modelProvider.orderPlaceholder")}
										description={t("settings.modelProvider.orderDesc")}
										onChange={setProviderOrderDraft}
									/>
									<Button
										buttonSize="sm"
										loading={extrasSaving === "provider-order"}
										disabled={extrasSaving !== null}
										onClick={() => void saveProviderOrder()}
									>
										{t("settings.modelProvider.save")}
									</Button>
								</div>
							</div>

							<div className="model-extras-section">
								<div className="settings-section-header">
									<strong>{t("settings.modelStorage.section")}</strong>
									<small>{t("settings.modelStorage.sectionDesc")}</small>
								</div>
								<div className="model-extras-form">
									<SelectField
										label={t("settings.modelStorage.label")}
										value={roleStorageDraft}
										options={[
											{ value: "global", label: t("settings.modelStorage.global") },
											{ value: "project", label: t("settings.modelStorage.project") },
										]}
										onChange={(value) =>
											setRoleStorageDraft(value === "project" ? "project" : "global")
										}
										description={t("settings.modelStorage.hint")}
									/>
									<Button
										buttonSize="sm"
										loading={extrasSaving === "role-storage"}
										disabled={extrasSaving !== null || roleStorageDraft === roleStorage}
										onClick={() => void saveRoleStorage()}
									>
										{t("settings.modelStorage.save")}
									</Button>
								</div>
							</div>

							<div className="model-extras-section">
								<div className="settings-section-header">
									<strong>{t("settings.modelFallback.section")}</strong>
									<small>{t("settings.modelFallback.sectionDesc")}</small>
								</div>
								<div className="model-fallback-list">
									{Object.keys(fallbackChains).length === 0 && (
										<small className="ui-field-description">
											{t("settings.modelFallback.empty")}
										</small>
									)}
									{Object.entries(fallbackChains).map(([key, chain]) => (
										<div key={key} className="model-preset-row">
											<div className="model-preset-info">
												<strong>{key}</strong>
												<small>{chain.join(" → ")}</small>
											</div>
											<div className="model-role-actions">
												<Button
													buttonSize="sm"
													variant="ghost"
													loading={extrasSaving === `fallback-remove-${key}`}
													disabled={extrasSaving !== null}
													onClick={() => removeFallback(key)}
												>
													{t("settings.modelFallback.remove")}
												</Button>
											</div>
										</div>
									))}
								</div>
								<div className="model-extras-form">
									<TextField
										label={t("settings.modelFallback.keyLabel")}
										value={fallbackRole}
										placeholder={t("settings.modelFallback.keyPlaceholder")}
										onChange={setFallbackRole}
									/>
									<TextField
										label={t("settings.modelFallback.chainLabel")}
										value={fallbackDraft}
										placeholder={t("settings.modelFallback.chainPlaceholder")}
										onChange={setFallbackDraft}
									/>
									<Button
										buttonSize="sm"
										loading={extrasSaving === "fallback-add"}
										disabled={extrasSaving !== null || !fallbackDraft.trim()}
										onClick={addFallback}
									>
										{t("settings.modelFallback.add")}
									</Button>
								</div>
							</div>
						</div>

						{notice && (
							<small className="model-roles-notice" role="status">
								{notice}
							</small>
						)}
					</>
				)}
			</div>
		</section>
	);
}
