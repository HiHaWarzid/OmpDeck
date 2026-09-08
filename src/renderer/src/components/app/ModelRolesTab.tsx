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
import { OMP_MODEL_ROLES, type OmpModelRole } from "../../../../shared/types/ompRoles";
import type { AvailableModel } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

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
	modelsState: ModelsState;
	onPick: (model: AvailableModel) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const normalized = query.trim().toLowerCase();
	const models =
		props.modelsState.status === "ready" ? props.modelsState.models : [];

	const filtered = normalized
		? models.filter((m) =>
				[m.id, m.provider, m.name, `${m.provider}/${m.id}`]
					.filter(Boolean)
					.some((v) => String(v).toLowerCase().includes(normalized)),
			)
		: models;
	const groups = filtered.reduce<Record<string, AvailableModel[]>>((acc, m) => {
		const p = m.provider || "other";
		(acc[p] ??= []).push(m);
		return acc;
	}, {});
	const providerOrder = ["anthropic", "openai", "google", "deepseek", "commandcode", "other"];
	const sortedGroups = Object.keys(groups).sort((a, b) => {
		const ai = providerOrder.indexOf(a);
		const bi = providerOrder.indexOf(b);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});
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
									</span>
								</button>
							))}
						</div>
					))}
				</div>
			)}
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
		return () => {
			cancelled = true;
		};
	}, []);

	/** 模型目录懒加载：幂等（首次点开才拉；主进程有全局缓存，后续复用）。 */
	const ensureModels = async () => {
		if (modelsState.status === "ready" || modelsState.status === "loading") return;
		setModelsState({ status: "loading" });
		try {
			const available = await window.piDesktop.projects.listModels().catch(() => [] as AvailableModel[]);
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

	const pickModel = async (role: OmpModelRole, model: AvailableModel) => {
		setSavingRole(role);
		setNotice(null);
		try {
			const result = await window.piDesktop.config.setOmpRole(role, `${model.provider}/${model.id}`);
			if (result.valid) {
				setRoles((prev) => {
					if (!prev) return prev;
					return {
						...prev,
						[role]: {
							selector: `${model.provider}/${model.id}`,
							provider: model.provider,
							modelId: model.id,
						},
					};
				});
				setNotice(t("settings.modelRoles.saved", { role: t(`settings.role.${role}.name`) }));
			} else {
				setNotice(result.error ?? t("settings.modelRoles.saveFailed"));
			}
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingRole(null);
			setActiveRole(null);
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
												<>
													<code className="model-role-current">
														{assignment.provider}/{assignment.modelId}
													</code>
													{assignment.thinkingLevel && (
														<span className="model-role-level">{assignment.thinkingLevel}</span>
													)}
												</>
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
													modelsState={modelsState}
													onClose={() => setActiveRole(null)}
													onPick={(m) => void pickModel(role, m)}
												/>
											</div>
										)}
									</div>
								);
							})}
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
