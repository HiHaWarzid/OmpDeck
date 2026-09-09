import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, type Document } from "yaml";
import {
	OMP_MODEL_ROLES,
	isOmpModelRole,
	parseRoleSelector,
	type OmpModelRole,
	type OmpRolesState,
} from "../../shared/types/ompRoles";
import type { ConfigValidationResult } from "./ConfigManager";

/**
 * OmpRolesStore —— omp config.yml（modelRoles + defaultThinkingLevel）的专属存取模块。
 *
 * 领域语义（scout 实锤 @oh-my-pi/pi-coding-agent 18.1.13 + 本机 config.yml）：
 * - omp 只把 config.yml/config.yaml 当全局 settings 权威源；settings.json 仅当
 *   config.yml 缺失时一次性迁移（改名 settings.json.bak），OmpDeck 不再反向写它；
 * - modelRoles.<role> 值 = "provider/modelId[:thinkingLevel]"，后缀是显式档，
 *   该角色生效时优先于顶层 defaultThinkingLevel（default 无后缀才回退顶层）；
 * - 因此「设置 OMP 默认（模型+思考档）」= 一次文档变更写两个槽位（selector 后缀
 *   是 omp 的角色级档位，顶层键是其它角色/回退的档位）——两者不是冗余，是 schema
 *   的两个槽位，见 ConfigManager 原双写窗口缺陷（两次全文件 RMW）的收敛。
 *
 * 不变式：
 * 1. 一次用户意图 = 一次 parse-mutate-write（原 setDefaultModel 两次串行全文件
 *    RMW 的撕裂写窗口在此关闭）；
 * 2. yaml round-trip 保留注释与无关键；
 * 3. 全部动作返回 {valid, error?}，不抛错（与 ConfigManager 校验风格一致）；
 * 4. 写前 mkdir configDir；default 角色清空时同步清顶层 defaultThinkingLevel
 *    （与原 writeOmpModelRole 语义一致），避免残留旧默认档。
 *
 * configDir 通过 accessor 注入：ConfigManager.configureWsl 可切换 WSL home，
 * 每次调用现取，保证指针跟随。
 */
export interface OmpRolesStoreDeps {
	resolveConfigDir: () => string;
}

export type DefaultModelInfo = {
	selector?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
};

function emptyRoles(): OmpRolesState {
	const empty: OmpRolesState = {} as OmpRolesState;
	for (const role of OMP_MODEL_ROLES) empty[role] = { selector: "" };
	return empty;
}

export class OmpRolesStore {
	private readonly deps: OmpRolesStoreDeps;

	constructor(deps: OmpRolesStoreDeps) {
		this.deps = deps;
	}

	/** 进程内一次性 legacy 迁移守卫（避免多次启动重复写）。 */
	private legacyMigrated = false;

	private get configDir(): string {
		return this.deps.resolveConfigDir();
	}

	/** 读取 config.yml/config.yaml 原文；两者都不存在返回 null。 */
	private async readRawConfigYaml(): Promise<string | null> {
		for (const name of ["config.yml", "config.yaml"]) {
			const filePath = join(this.configDir, name);
			try {
				if (!existsSync(filePath)) continue;
				return await readFile(filePath, "utf-8");
			} catch {
				// 单个文件读失败继续尝试下一个
			}
		}
		return null;
	}

	/** 写入文件名：优先已存在的 config.yaml，否则 config.yml（与原行为一致）。 */
	private ompConfigYamlName(): string {
		return existsSync(join(this.configDir, "config.yaml"))
			? "config.yaml"
			: "config.yml";
	}

	private async parseDoc(): Promise<Record<string, unknown> | null> {
		const raw = await this.readRawConfigYaml();
		if (raw === null) return null;
		try {
			const value = parseDocument(raw).toJS() as Record<string, unknown> | null;
			return value && typeof value === "object" && !Array.isArray(value) ? value : null;
		} catch {
			return null; // 解析失败按空处理（与原 readOmpModelRoles catch 语义一致）
		}
	}

	/** 读取全部角色的当前值（未配置角色返回空 assignment）。 */
	async readRolesState(): Promise<OmpRolesState> {
		const rolesState = emptyRoles();
		const parsed = await this.parseDoc();
		if (!parsed) return rolesState;
		const roles =
			parsed.modelRoles && typeof parsed.modelRoles === "object" && !Array.isArray(parsed.modelRoles)
				? (parsed.modelRoles as Record<string, unknown>)
				: {};
		for (const role of OMP_MODEL_ROLES) {
			const selector = typeof roles[role] === "string" ? roles[role] : "";
			if (selector) rolesState[role] = parseRoleSelector(selector);
		}
		return rolesState;
	}

	/** 默认模型角色（config.yml modelRoles.default），附顶层 defaultThinkingLevel 回退。 */
	async readDefaultModel(): Promise<DefaultModelInfo> {
		const parsed = await this.parseDoc();
		if (!parsed) return {};
		const topLevel =
			typeof parsed.defaultThinkingLevel === "string"
				? parsed.defaultThinkingLevel
				: undefined;
		const defaultSelector =
			parsed.modelRoles &&
			typeof parsed.modelRoles === "object" &&
			!Array.isArray(parsed.modelRoles) &&
			typeof (parsed.modelRoles as Record<string, unknown>).default === "string"
				? ((parsed.modelRoles as Record<string, unknown>).default as string)
				: "";
		if (!defaultSelector) return {};
		const parsedSelector = parseRoleSelector(defaultSelector);
		return {
			selector: parsedSelector.selector,
			provider: parsedSelector.provider,
			model: parsedSelector.modelId,
			thinkingLevel: parsedSelector.thinkingLevel ?? topLevel,
		};
	}

	/** 顶层 defaultThinkingLevel（桌面端 post-ready 强推与 SettingsTab 展示的数据源）。 */
	async readDefaultThinkingLevel(): Promise<string | undefined> {
		const parsed = await this.parseDoc();
		return parsed && typeof parsed.defaultThinkingLevel === "string"
			? parsed.defaultThinkingLevel
			: undefined;
	}

	/** 通用写盘：一次 parse-mutate-write，保留注释与无关键。 */
	private async writeDoc(mutate: (doc: Document) => void): Promise<ConfigValidationResult> {
		try {
			await mkdir(this.configDir, { recursive: true });
			const existing = await this.readRawConfigYaml();
			const doc = parseDocument(existing ?? "", { prettyErrors: true });
			mutate(doc);
			// modelRoles 被清空时删除整块，避免写残留空对象
			const rolesNode = doc.get("modelRoles");
			if (
				rolesNode &&
				typeof rolesNode === "object" &&
				!Array.isArray(rolesNode) &&
				Object.keys(rolesNode as Record<string, unknown>).length === 0
			) {
				doc.delete("modelRoles");
			}
			const filePath = join(this.configDir, this.ompConfigYamlName());
			await writeFile(filePath, doc.toString(), "utf8");
			return { valid: true };
		} catch (e) {
			return {
				valid: false,
				error: `config.yml 写入失败：${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	/**
	 * 设置某个模型角色（含后缀档位）。default 角色走 applyDefault（与顶层键联动）；
	 * 非 default 角色只写 modelRoles.<role>。
	 */
	async applyRole(
		role: OmpModelRole,
		selector: string,
		thinkingLevel?: string,
	): Promise<ConfigValidationResult> {
		if (role === "default") return this.applyDefault(selector, thinkingLevel);
		return this.writeDoc((doc) => {
			const trimmed = thinkingLevel?.trim();
			doc.setIn(["modelRoles", role], trimmed ? `${selector}:${trimmed}` : selector);
		});
	}
	/** 只写顶层 defaultThinkingLevel（导入恢复用：保留已有档位的兜底项）。 */
	async applyDefaultThinkingLevel(
		level: string,
	): Promise<ConfigValidationResult> {
		return this.writeDoc((doc) => {
			doc.set("defaultThinkingLevel", level.trim());
		});
	}

	/** 清除某个角色；default 联动清顶层 defaultThinkingLevel。 */
	async clearRole(role: OmpModelRole): Promise<ConfigValidationResult> {
		return this.writeDoc((doc) => {
			doc.deleteIn(["modelRoles", role]);
			if (role === "default") doc.delete("defaultThinkingLevel");
		});
	}

	/**
	 * 设置 OMP 默认（模型 + 可选思考档）——单次文档变更写两个槽位：
	 * modelRoles.default = "provider/modelId[:level]"；顶层 defaultThinkingLevel =
	 * level（给了才写；没给且原值在，则删除——与原双写流程的净效果一致，只是原子）。
	 */
	async applyDefault(
		selector: string,
		thinkingLevel?: string,
	): Promise<ConfigValidationResult> {
		return this.writeDoc((doc) => {
			const trimmed = thinkingLevel?.trim();
			doc.setIn(
				["modelRoles", "default"],
				trimmed ? `${selector}:${trimmed}` : selector,
			);
			if (trimmed) doc.set("defaultThinkingLevel", trimmed);
			else doc.delete("defaultThinkingLevel");
		});
	}

	/** 清除 OMP 默认（modelRoles.default + 顶层 defaultThinkingLevel 一次清）。 */
	async clearDefault(): Promise<ConfigValidationResult> {
		return this.clearRole("default");
	}

	/**
	 * 恢复导出的 config.yml 包片段：逐角色校验后原子写入，顶层档位保留。
	 * 无效角色/空 selector/缺 provider 跳过；包赢（同文档一次变更）。
	 */
	async importPackage(ompConfig: unknown): Promise<ConfigValidationResult> {
		if (!ompConfig || typeof ompConfig !== "object" || Array.isArray(ompConfig)) {
			return { valid: true };
		}
		const roles = (ompConfig as Record<string, unknown>).modelRoles;
		const topLevel = (ompConfig as Record<string, unknown>).defaultThinkingLevel;
		return this.writeDoc((doc) => {
			if (roles && typeof roles === "object" && !Array.isArray(roles)) {
				for (const [role, selector] of Object.entries(roles)) {
					if (!isOmpModelRole(role) || typeof selector !== "string" || !selector) continue;
					const parsed = parseRoleSelector(selector);
					if (!parsed.provider || !parsed.modelId) continue;
					// 先剥离、再统一拼后缀，避免 "a:b" + "b" → "a:b:b"。
					const bare = `${parsed.provider}/${parsed.modelId}`;
					doc.setIn(
						["modelRoles", role],
						parsed.thinkingLevel ? `${bare}:${parsed.thinkingLevel}` : bare,
					);
				}
			}
			if (typeof topLevel === "string" && topLevel) {
				doc.set("defaultThinkingLevel", topLevel);
			}
		});
	}

	/**
	 * 一次性 legacy 迁移（Q20a 语义）：settings.json 的 defaultThinkingLevel 只填空、
	 * 不覆盖——仅当 config.yml 顶层缺该键且 settings.json 有值时写入。omp 本身只在
	 * config.yml 缺失时消费 settings.json，此处不改变 omp 的迁移边界，只把 OmpDeck
	 * 旧写入的档位搬进权威源。进程内只跑一次；多数机器 settings.json 无此键，空操作。
	 */
	async migrateLegacyDefaultThinkingLevel(): Promise<void> {
		if (this.legacyMigrated) return;
		this.legacyMigrated = true;
		try {
			const parsed = await this.parseDoc();
			if (parsed && typeof parsed.defaultThinkingLevel === "string") return; // 权威源已有
			const settingsPath = join(this.configDir, "settings.json");
			if (!existsSync(settingsPath)) return;
			const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
				defaultThinkingLevel?: unknown;
			};
			if (typeof settings.defaultThinkingLevel !== "string") return;
			await this.writeDoc((doc) => {
				doc.set("defaultThinkingLevel", settings.defaultThinkingLevel as string);
			});
		} catch {
			// 迁移失败不阻塞启动；下次进程启动再试（守卫按进程计，非按文件）
		}
	}
}
