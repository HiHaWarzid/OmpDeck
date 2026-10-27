/**
 * omp 内置模型角色（modelRoles.<role>）。角色集取自 omp v18 的
 * `MODEL_ROLES` 表（src/config/model-roles.ts），顺序与模型中心一致：
 * 前 10 个是对话角色，后 5 个按模型 kind 选择（image/web/speech/dictation/judge）。
 */
export const OMP_CHAT_MODEL_ROLES = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
] as const;

export const OMP_KIND_MODEL_ROLES = [
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
] as const;

export const OMP_MODEL_ROLES = [
	...OMP_CHAT_MODEL_ROLES,
	...OMP_KIND_MODEL_ROLES,
] as const;

export type OmpModelRole = (typeof OMP_MODEL_ROLES)[number];

/** 角色接受的模型 kind（与 omp `roleCandidatePool` 的 accepts 逻辑一致）。 */
export function ompRoleAcceptsModelKind(
	role: OmpModelRole,
	kind: string | undefined,
): boolean {
	switch (role) {
		case "image":
			return kind === "image";
		case "web":
			// JSON 目录不暴露 webSearch 能力位；search 模型必选，chat 由 omp 侧再校验。
			return kind === "search" || kind === "chat" || kind === undefined;
		case "speech":
			return kind === "tts";
		case "dictation":
			return kind === "stt";
		case "judge":
			return kind === "judge" || kind === "tiny" || kind === "chat" || kind === undefined;
		case "tiny":
		case "memory":
			return kind === "tiny" || kind === "chat" || kind === undefined;
		default:
			return kind === "chat" || kind === undefined;
	}
}

/** 模型预设：角色快照 + 可选默认思考档；值与 omp `modelPresets.<name>` 对齐。 */
export type OmpModelPreset = {
	modelRoles: Record<string, string>;
	defaultThinkingLevel?: string;
};

export type OmpModelPresets = Record<string, OmpModelPreset>;

/** 预设名规则（omp `isValidModelPresetName`）：字母开头，后接字母/数字/下划线/连字符。 */
export function isValidOmpModelPresetName(name: string): boolean {
	return /^[a-zA-Z][\w-]*$/.test(name);
}

/** `retry.fallbackChains`：角色或模型选择器 → 有序回退选择器。 */
export type OmpFallbackChains = Record<string, string[]>;

/** 单个角色当前配置：selector 形如 "provider/modelId[:thinkingLevel]"。 */
export type OmpRoleAssignment = {
	selector: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

/** config.yml 中全部角色（含未配置的，值为空）。 */
export type OmpRolesState = Record<OmpModelRole, OmpRoleAssignment>;

/**
 * 解析落盘格式 "provider/modelId[:thinkingLevel]" 为结构化 assignment。
 * provider 不含 "/"；model id 自身可含 "/"；冒号后缀是思考档（omp 原生持久化格式）。
 * 跨进程契约（config.yml 落盘格式）——ConfigManager/OmpRolesStore 与渲染层共用，
 * 渲染层不再手工拼接 selector 字符串。
 */
export function parseRoleSelector(selector: string): {
	selector: string;
	provider: string;
	modelId: string;
	thinkingLevel?: string;
} {
	const sepIdx = selector.indexOf(":");
	const base = sepIdx > 0 ? selector.slice(0, sepIdx) : selector;
	const suffix = sepIdx > 0 ? selector.slice(sepIdx + 1) : "";
	const slashIdx = base.indexOf("/");
	if (slashIdx <= 0) return { selector, provider: "", modelId: base };
	return {
		selector,
		provider: base.slice(0, slashIdx),
		modelId: base.slice(slashIdx + 1),
		thinkingLevel: suffix || undefined,
	};
}

/**
 * 拼回落盘格式 "provider/modelId[:thinkingLevel]"（与 parseRoleSelector 互逆）。
 * 仅在给定 thinkingLevel 时附后缀；空 provider/modelId 返回空串（表示未配置）。
 */
export function formatRoleSelector(
	provider: string,
	modelId: string,
	thinkingLevel?: string,
): string {
	const trimmedLevel = thinkingLevel?.trim();
	if (!provider || !modelId) return "";
	return trimmedLevel
		? `${provider}/${modelId}:${trimmedLevel}`
		: `${provider}/${modelId}`;
}

/**
 * IPC/导入边界收窄：role 必须是 omp 内置角色之一。
 * 与 configHandlers 的旧内联校验同语义，提到 shared 供双端复用。
 */
export function isOmpModelRole(value: string): value is OmpModelRole {
	return (OMP_MODEL_ROLES as readonly string[]).includes(value);
}
