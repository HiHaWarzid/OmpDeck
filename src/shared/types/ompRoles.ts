/** omp 内置模型角色（modelRoles.<role>）。角色集取自 omp v18 runtime 元数据表。 */
export const OMP_MODEL_ROLES = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"task",
	"advisor",
] as const;

export type OmpModelRole = (typeof OMP_MODEL_ROLES)[number];

/** 单个角色当前配置：selector 形如 "provider/modelId[:thinkingLevel]"。 */
export type OmpRoleAssignment = {
	selector: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

/** config.yml 中全部角色（含未配置的，值为空）。 */
export type OmpRolesState = Record<OmpModelRole, OmpRoleAssignment>;
