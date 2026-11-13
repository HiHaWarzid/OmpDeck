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
 * 为什么角色选择继续即时保存：角色一次只有一个值，点选/清除就是原子动作，
 * 不存在"填到一半"的中间态，所以 pick 成功后才更新本地状态，没有额外保存按钮。
 * 需要两段式的只有下面的附加项文本框（循环顺序、供应商顺序、角色存储），
 * 它们的 base/value/dirty/patch 统一走 utils/configDraft，与设置、配置弹框同一份实现；
 * 本 tab 曾手写 `roleStorageDraft === roleStorage` 之类的脏判定，现已由值 diff 取代。
 *
 * 加载拆分：角色列表只依赖 config.yml 读取（毫秒级，立即渲染）；模型目录
 * （projects.listModels，首次会 fork pi 子进程，可能数秒）延迟到用户点开
 * 角色选择器时才拉取，避免打开 tab 被模型扫描拖慢。
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
import {
	createDraft,
	dirtyPaths,
	hasDraftChanges,
	isFieldDirty,
	patchDraft,
	rebaseDraft,
	resetDraft,
	type Draft,
} from "../../utils/configDraft";

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

/**
 * 附加项的草稿形状：文本输入按用户所见保存（逗号分隔串），
 * 选中态用 omp 的枚举值。base 是磁盘上的值，因此 dirty 可以直接由值 diff 得出。
 */
type ExtrasDraft = {
	cycleOrder: string;
	providerOrder: string;
	roleStorage: OmpModelRoleStorage;
};

const EMPTY_EXTRAS_DRAFT: ExtrasDraft = {
	cycleOrder: "",
	providerOrder: "",
	roleStorage: "global",
};

/** 逗号分隔的顺序文本 → 有序列表（去空白、丢空项）。循环顺序与供应商顺序共用同一口径。 */
function parseOrderList(text: string): string[] {
	return text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

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

/**
 * 本 tab 上报给设置弹框的未保存状态。
 *
 * 角色与预设是即时写盘，只有循环顺序 / 供应商顺序 / 角色存储留在草稿里，
 * 而它们的保存按钮都在本 tab 内 —— 不上报的话，用户改完直接关弹层会静默丢弃，
 * 全局「保存并关闭」也会假称保存成功却什么都没写。因此上报的是
 * 「有没有未保存内容 + 怎么保存 + 怎么丢弃」，而不只是一个 dirty 布尔。
 */
export interface ModelRolesDraftState {
	dirty: boolean;
	/** 保存草稿里所有脏字段；返回 false 表示落盘失败，调用方应留在弹层里。 */
	save: () => Promise<boolean>;
	/** 丢弃草稿改动，回到磁盘基线（全局「取消」用）。 */
	discard: () => void;
}

export function ModelRolesTab(props: {
	onDraftStateChange?: (state: ModelRolesDraftState | null) => void;
} = {}) {
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
	const [fallbackChains, setFallbackChains] = useState<OmpFallbackChains>({});
	const [fallbackRole, setFallbackRole] = useState<string>("default");
	const [fallbackDraft, setFallbackDraft] = useState("");
	const [providerOrder, setProviderOrder] = useState<string[]>([]);
	/**
	 * 循环顺序 / 供应商顺序 / 角色存储这三个附加项的本地草稿。
	 * 它们是「填完再点保存」的表单，所以值必须与已落盘基线分开（configDraft 的 base/value）；
	 * 预设、回退链是即时生效的列表操作，不在这份草稿里（它们的未保存文本单独并入 dirty）。
	 */
	const [extrasDraft, setExtrasDraft] = useState<Draft<ExtrasDraft>>(() =>
		// 复制一份：createDraft 会让 base 与 value 指向同一个对象，
		// 直接传模块常量等于把这份草稿的基线接到了模块级共享状态上。
		createDraft({ ...EMPTY_EXTRAS_DRAFT }),
	);
	const extras = extrasDraft.value;
	const [extrasSaving, setExtrasSaving] = useState<string | null>(null);
	const extrasDirty = hasDraftChanges(extrasDraft);
	/**
	 * 预设名 / 回退链输入框里的文本也算未保存内容。
	 *
	 * 它们不走 extrasDraft（那两个是两段式表单，这两个是「填好再点旁边按钮」的动作），
	 * 但语义一样：输入框里有内容却直接关弹层，用户会以为已经存下了。
	 * 因此把它们并入 dirty，并在全局保存时按「等同于点旁边那个按钮」处理。
	 */
	const pendingPresetName = presetName.trim();
	const pendingFallbackDraft = fallbackDraft.trim();
	// 回退链输入框里的文本也算未保存：哪怕回退键为空、这段文本写不进去，
	// 也不能在关弹层时静默消失。这种写不进去的情况由 addFallback 明确报错并留在弹层。
	const hasPendingTextDrafts = pendingPresetName !== "" || pendingFallbackDraft !== "";
	const rolesDirty = extrasDirty || hasPendingTextDrafts;

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

	/**
	 * 只重读预设列表。
	 *
	 * 保存/删除预设写的是 `modelPresets`，不碰循环顺序、回退链、provider 顺序和
	 * roleStorage。以前这些操作走 `loadExtras()`（无 rebase），会把用户在这四个
	 * 输入框里正在编辑、尚未提交的文本整份重建掉——保存一个预设就静默丢失另一处编辑。
	 */
	const refreshPresets = async () => {
		try {
			setPresets((await window.piDesktop.config.getOmpModelPresets()) ?? {});
		} catch {
			// 旧版 omp 可能没有该 RPC；保持既有预设不变，不影响角色编辑。
		}
	};

	/** 只重读回退链。同样避免重建另外三个 draft 字段。 */
	const refreshFallbackChains = async () => {
		try {
			setFallbackChains((await window.piDesktop.config.getOmpFallbackChains()) ?? {});
		} catch {
			/* 同上 */
		}
	};

	/**
	 * 读取预设/循环/回退链；与角色读取相互独立，失败时保持空值。
	 *
	 * `rebase` 指定刚落盘（或刚被外部改写）的字段：只有这些字段的草稿与基线
	 * 对齐到磁盘真值，其余未提交编辑原样保留。逐字段保存时若整份重建，
	 * 保存 A 字段的回读会把同时编辑中的 B 字段静默清空。
	 * 不传 rebase 即「重新载入 = 丢弃草稿」，只用于首次载入这类用户没有在编辑的时机；
	 * 一次操作没有改动这四个字段时，用 `refreshPresets` / `refreshFallbackChains`。
	 */
	const loadExtras = async (rebase?: readonly (keyof ExtrasDraft)[]) => {
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
			setFallbackChains(nextFallbacks ?? {});
			setProviderOrder(nextProviderOrder ?? []);
			// 基线以磁盘真值（含 omp 的规范化），而不是用请求参数 commit。
			const fresh: ExtrasDraft = {
				cycleOrder: (nextCycle ?? []).join(", "),
				providerOrder: (nextProviderOrder ?? []).join(", "),
				roleStorage: nextRoleStorage,
			};
			setExtrasDraft((prev) =>
				rebase && rebase.length > 0
					? rebaseDraft(prev, fresh, rebase as readonly string[])
					: createDraft(fresh),
			);
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

	/** 把当前角色映射存成命名预设；返回是否落盘（全局「保存并关闭」会等它）。 */
	const saveCurrentAsPreset = async (): Promise<boolean> => {
		const name = presetName.trim();
		if (!name) return true;
		setExtrasSaving("preset-save");
		setNotice(null);
		try {
			const result = await window.piDesktop.config.saveOmpModelPreset(name);
			reportResult(result, "settings.modelPresets.saved");
			if (result.valid) {
				setPresetName("");
				// 只重读预设：另外四个输入框里的未提交编辑不归这次写入管。
				await refreshPresets();
			}
			return result.valid;
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
			return false;
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
				// 应用预设整体替换 modelRoles，但同样不碰循环/回退链/provider/存储字段。
				await loadRoles();
				await refreshPresets();
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
			if (result.valid) await refreshPresets();
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setExtrasSaving(null);
		}
	};

	const saveCycleOrder = async (): Promise<boolean> => {
		setExtrasSaving("cycle");
		setNotice(null);
		try {
			const result = await window.piDesktop.config.setOmpCycleOrder(parseOrderList(extras.cycleOrder));
			reportResult(result, "settings.modelCycle.saved");
			// 基线以磁盘真值校准（omp 会规范化写入值），但只校准本字段：
			// 另外两个字段可能正在编辑，整份重建会静默清空它们。
			if (result.valid) await loadExtras(["cycleOrder"]);
			return result.valid;
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setExtrasSaving(null);
		}
	};

	const saveProviderOrder = async (): Promise<boolean> => {
		setExtrasSaving("provider-order");
		setNotice(null);
		try {
			const result = await window.piDesktop.config.setOmpProviderOrder(
				parseOrderList(extras.providerOrder),
			);
			reportResult(result, "settings.modelProvider.saved");
			if (result.valid) await loadExtras(["providerOrder"]);
			return result.valid;
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setExtrasSaving(null);
		}
	};

	const saveRoleStorage = async (): Promise<boolean> => {
		setExtrasSaving("role-storage");
		setNotice(null);
		try {
			const result = await window.piDesktop.config.setOmpRoleStorage(extras.roleStorage);
			reportResult(result, "settings.modelStorage.saved");
			if (result.valid) await loadExtras(["roleStorage"]);
			return result.valid;
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setExtrasSaving(null);
		}
	};

	/**
	 * 保存草稿里所有未落盘内容（设置弹框的全局「保存并关闭」走这里）。
	 *
	 * 三个附加项字段各写一个键，没有能一次提交全部差异的 RPC；因此按字段逐个提交，
	 * 任一失败即返回 false 让调用方留在弹层里 —— 因为每次保存只校准自己那个字段，
	 * 已成功的部分变干净、剩下的仍是 dirty，用户能看到到底哪一段没保存。
	 *
	 * 预设名 / 回退链输入框里的文本按「等同于点旁边对应按钮」处理：那是用户已经
	 * 表达出的保存意图，全局保存不能把它们当成没发生就关掉弹层。
	 */
	const saveExtrasDraft = async (): Promise<boolean> => {
		if (pendingPresetName && !(await saveCurrentAsPreset())) return false;
		if (pendingFallbackDraft && !(await addFallback())) return false;
		const dirty = dirtyPaths(extrasDraft);
		if (dirty.includes("cycleOrder") && !(await saveCycleOrder())) return false;
		if (dirty.includes("providerOrder") && !(await saveProviderOrder())) return false;
		if (dirty.includes("roleStorage") && !(await saveRoleStorage())) return false;
		return true;
	};

	// 上报未保存状态：本 tab 没有全局保存按钮，三条 save 都各自写盘，
	// 所以关闭守卫只能靠这份上报拦住未保存编辑。
	//
	// 上报对象必须引用稳定（每帧新建会让设置弹框的 setState 永远「有变化」），
	// 而 save/discard 又要读到**当前这一帧**的草稿，所以两者经 ref 解耦：
	// 对象只在 dirty 翻转时重建，函数体始终读 ref 里的最新实现。
	const actionsRef = useRef<{ save: () => Promise<boolean>; discard: () => void }>({
		save: async () => true,
		discard: () => {},
	});
	actionsRef.current = {
		save: saveExtrasDraft,
		discard: () => {
			setExtrasDraft((prev) => resetDraft(prev));
			// 文本输入框也要一起清：只回退 extrasDraft 会让「取消」看起来没生效。
			setPresetName("");
			setFallbackDraft("");
		},
	};
	const draftState = useMemo<ModelRolesDraftState>(
		() => ({
			dirty: rolesDirty,
			save: () => actionsRef.current.save(),
			discard: () => actionsRef.current.discard(),
		}),
		[rolesDirty],
	);
	const onDraftStateChangeRef = useRef(props.onDraftStateChange);
	onDraftStateChangeRef.current = props.onDraftStateChange;
	useEffect(() => {
		onDraftStateChangeRef.current?.(draftState);
	}, [draftState]);
	// 卸载（切走 tab 或关闭弹层）时撤回上报，避免残留的 dirty 让下一次打开直接弹确认。
	useEffect(() => () => onDraftStateChangeRef.current?.(null), []);

	/** 回退链整体写回：先合并本地状态，再提交完整映射（空链会删除该键）。 */
	const commitFallback = async (next: OmpFallbackChains, savingKey: string): Promise<boolean> => {
		setExtrasSaving(savingKey);
		setNotice(null);
		try {
			const result = await window.piDesktop.config.setOmpFallbackChains(next);
			reportResult(result, "settings.modelFallback.saved");
			if (result.valid) {
				setFallbackChains(next);
				setFallbackDraft("");
				// 只重读回退链（omp 会规范化写入值）。不能走 loadExtras()：
				// 那会把循环顺序/provider 顺序/roleStorage 三个输入框里正在编辑的文本重建掉。
				await refreshFallbackChains();
			}
			return result.valid;
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setExtrasSaving(null);
		}
	};

	/** 把「角色 + 逗号分隔链」追加成一条回退链；返回是否落盘。 */
	const addFallback = async (): Promise<boolean> => {
		const text = fallbackDraft.trim();
		const chain = fallbackDraft
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		if (!fallbackRole) {
			// 有文本却没有键：不能返回 true —— 那会让「保存并关闭」一边声称保存成功
			// 一边把这段文本丢掉。返回 false 让调用方留在弹层里，并把原因说清楚。
			if (text.length > 0) {
				setNotice(t("settings.modelFallback.missingKey"));
				return false;
			}
			return true;
		}
		// 有文本却解析不出任何条目（例如只剩一个逗号）：与「有文本没键」同理，
		// 返回 true 会让保存并关闭把这段文本静默丢掉。只有真正空输入才算无事可做。
		if (chain.length === 0) {
			if (text.length > 0) {
				setNotice(t("settings.modelFallback.invalidChain"));
				return false;
			}
			return true;
		}
		return commitFallback({ ...fallbackChains, [fallbackRole]: chain }, "fallback-add");
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
										value={extras.cycleOrder}
										placeholder={t("settings.modelCycle.orderPlaceholder")}
										description={t("settings.modelCycle.orderDesc")}
										onChange={(value) =>
											setExtrasDraft((prev) => patchDraft(prev, { cycleOrder: value }))
										}
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
										value={extras.providerOrder}
										placeholder={t("settings.modelProvider.orderPlaceholder")}
										description={t("settings.modelProvider.orderDesc")}
										onChange={(value) =>
											setExtrasDraft((prev) => patchDraft(prev, { providerOrder: value }))
										}
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
										value={extras.roleStorage}
										options={[
											{ value: "global", label: t("settings.modelStorage.global") },
											{ value: "project", label: t("settings.modelStorage.project") },
										]}
										onChange={(value) =>
											setExtrasDraft((prev) =>
												patchDraft(prev, {
													roleStorage: value === "project" ? "project" : "global",
												}),
											)
										}
										description={t("settings.modelStorage.hint")}
									/>
									<Button
										buttonSize="sm"
										loading={extrasSaving === "role-storage"}
										// 与基线相同就没有可保存的内容；判定与其它 tab 共用 configDraft 的值 diff
										disabled={extrasSaving !== null || !isFieldDirty(extrasDraft, "roleStorage")}
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
										disabled={extrasSaving !== null || pendingFallbackDraft === ""}
										onClick={() => void addFallback()}
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
