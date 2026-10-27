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

/** 模型角色存储范围（omp settings `modelRoleStorage`）。 */
export type OmpModelRoleStorage = "global" | "project";

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
 * omp 认可的角色 selector 后缀档位。`inherit` 只出现在内部解析，不作为落盘
 * 选择器；其余与 ThinkingLevel 枚举一致。
 */
const ROLE_THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/**
 * omp 角色选择器语法（config.yml modelRoles 的值）：
 * - `provider/modelId`（model id 可再含 `/`）
 * - `@role` / `pi/role`（角色别名，可递归；`*` 表示 default）
 * - 逗号分隔的候选列表，按顺序尝试
 * - 末尾 `:level` 是角色级思考档
 * 裸模型 id 同样合法（omp 会做模糊匹配），因此这里只拒绝空白/残缺路径。
 */
export function isValidOmpRoleSelector(selector: string): boolean {
	const trimmed = selector.trim();
	if (!trimmed) return false;
	const candidates = trimmed.split(",");
	if (candidates.some((candidate) => !candidate.trim())) return false;
	return candidates.every((candidate) => {
		const value = stripRoleThinkingSuffix(candidate.trim());
		if (!value) return false;
		if (value === "*") return true;
		if (value.startsWith("@")) return /^[a-zA-Z0-9_-]+$/.test(value.slice(1));
		if (value.startsWith("pi/")) {
			const role = value.slice(3);
			return /^[a-zA-Z0-9_-]+$/.test(role) || role === "*";
		}
		if (value.includes("/")) {
			const [provider, ...rest] = value.split("/");
			return provider.length > 0 && rest.join("/").length > 0;
		}
		return !/\s/.test(value);
	});
}

/**
 * 剥离 omp 认可的思考档后缀；未知后缀视为模型 id 的一部分，原样保留。
 * 角色编辑、列表展示和导入共用，避免各处维护同一份档位名单。
 */
export function stripRoleThinkingSuffix(value: string): string {
	const sepIdx = value.lastIndexOf(":");
	if (sepIdx <= 0) return value;
	const suffix = value.slice(sepIdx + 1);
	return ROLE_THINKING_LEVELS.has(suffix) ? value.slice(0, sepIdx) : value;
}

/**
 * 解析落盘格式 "provider/modelId[:thinkingLevel]" 为结构化 assignment。
 * provider 不含 "/"；model id 自身可含 "/" 与冒号。只有 omp 认可的档位后缀
 * 才被拆出——否则 `provider/model:embed` 这类合法 id 会被误判成思考档。
 * 别名/候选列表（`@slow`、`a/b,c/d`）没有单一 provider/model，返回空字段，
 * 调用方应展示原始 selector。
 */
export function parseRoleSelector(selector: string): {
	selector: string;
	provider: string;
	modelId: string;
	thinkingLevel?: string;
} {
	const trimmed = selector.trim();
	const base = stripRoleThinkingSuffix(trimmed);
	const hasLevel = base !== trimmed;
	const suffix = hasLevel ? trimmed.slice(base.length + 1) : "";
	if (base.includes(",") || base.startsWith("@") || base.startsWith("pi/") || base === "*") {
		return { selector: trimmed, provider: "", modelId: "" };
	}
	const slashIdx = base.indexOf("/");
	if (slashIdx <= 0) return { selector: trimmed, provider: "", modelId: base };
	return {
		selector: trimmed,
		provider: base.slice(0, slashIdx),
		modelId: base.slice(slashIdx + 1),
		thinkingLevel: hasLevel ? suffix : undefined,
	};
}

/** 按 omp `modelProviderOrder` 排序供应商；未列出的按字母序排在其后。 */
export function sortProvidersByOrder(
	providers: readonly string[],
	order: readonly string[],
): string[] {
	const rank = new Map(order.map((provider, index) => [provider, index]));
	return [...providers].sort((a, b) => {
		const ai = rank.get(a);
		const bi = rank.get(b);
		if (ai !== undefined && bi !== undefined) return ai - bi;
		if (ai !== undefined) return -1;
		if (bi !== undefined) return 1;
		return a.localeCompare(b);
	});
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
