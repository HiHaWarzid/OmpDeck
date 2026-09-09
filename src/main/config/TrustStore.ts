import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { dirname as posixDirname, normalize as posixNormalize } from "node:path/posix";
import { homedir } from "node:os";

/**
 * TrustStore —— 项目信任决策（trust.json）专属模块。
 *
 * 从 ConfigManager 信任块与 AgentManager 决策矩阵收敛而来（架构评审候选 5）：
 * - 存储：trust.json = Record<路径, boolean>；键归一化规则显式化（win32 非 "/"
 *   开头 → 小写；posix 保大小写），win32 大小写不敏感命中；
 * - 父链继承：父目录决策继承到子目录（复刻 pi 的 findNearestTrustEntry 语义）；
 * - 资源探测：哪些项目触发信任确认（.omp 下的配置/扩展/skills 等、逐级父目录
 *   .agents/skills；用户全局 ~/.agents/skills 视为可信不触发）；
 * - 决策编排 decide()：干净项目自动写信任；已信任放行；false/未记录 → ask 注入
 *   （弹窗适配器经回调注入，本模块不持窗口；60s/headless 拒绝由适配器负责）。
 *
 * 语义钉死清单（行为不改，只把散在注释里的规则变成测试）：
 * 1. 干净项目自动写信任（不弹窗）；2. trust.json 显式 false 仍弹窗（不静默拒绝），
 *    false 不落盘；3. 父目录决策继承；4. trust-session → 本次 approve 不落盘；
 *    deny → 本次 no-approve（agent 仍可创建，只是不加载项目资源）；
 * 5. ensure 遇已有不同大小写/分隔符记录或显式 false 不覆盖。
 *
 * configDir 经 accessor 注入（configureWsl 可切换 Windows/WSL home，现取跟随）。
 */
export interface TrustStoreDeps {
	resolveConfigDir: () => string;
}

export type TrustDecideResult = "approve" | "no-approve" | undefined;

export interface TrustDecideOptions {
	/** RPC 侧 cwd（WSL 下为 Linux 路径）：信任记录键与干净项目自动写入用。 */
	cwd: string;
	/** 宿主侧路径（WSL 下为 Windows 路径）：资源探测用。 */
	hostCwd: string;
	projectName: string;
	/** 用户全局 skills 目录所在 home（WSL 下 = windowsHome；纯 Windows 省略走 homedir）。 */
	windowsHome?: string;
	/** 弹窗适配器：窗口/requestId/超时全在 AgentManager 侧，决策模块不持窗口。 */
	ask: () => Promise<"trust-remember" | "trust-session" | "deny">;
}

const TRUST_REQUIRING_RESOURCE_FILES = [
	"settings.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

export class TrustStore {
	private readonly deps: TrustStoreDeps;

	constructor(deps: TrustStoreDeps) {
		this.deps = deps;
	}

	private get configDir(): string {
		return this.deps.resolveConfigDir();
	}

	/** trust.json 原文（供 IPC config.getTrust 裸读）。ENOENT = 空存储（正常首启）；其它读错误 ok=false。 */
	async readTrust(): Promise<{ entries: Record<string, boolean>; ok: boolean; raw: string }> {
		try {
			const raw = await readFile(join(this.configDir, "trust.json"), "utf8");
			const parsed = JSON.parse(raw) as unknown;
			return {
				entries:
					parsed && typeof parsed === "object" && !Array.isArray(parsed)
						? (parsed as Record<string, boolean>)
						: {},
				ok: true,
				raw,
			};
		} catch (e) {
			// 文件不存在 = 空信任库（可安全写）；权限/损坏等真错误才拒绝写（不冒险覆盖）
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { entries: {}, ok: true, raw: "" };
			return { entries: {}, ok: false, raw: "" };
		}
	}

	/** 干净项目自动信任：去重（不同大小写/分隔符已有记录则不写）；写失败静默。 */
	async ensureTrustedDirectory(directoryPath: string): Promise<void> {
		const { entries, ok } = await this.readTrust();
		if (!ok) return; // 读不到文件（权限/损坏）不冒险写
		const normalizedPath = normalizeTrustPath(directoryPath);
		const existing = Object.keys(entries).find(
			(key) => normalizeTrustPathKey(key) === normalizeTrustPathKey(normalizedPath),
		);
		if (existing !== undefined) return; // 已有记录（含显式 false）→ 尊重，不覆盖
		await this.writeTrust({ ...entries, [normalizedPath]: true });
	}

	/** 沿父链查最近决策（未记录或只记录了祖先/后代之外的路径时返回 null）。 */
	async getDecision(cwd: string): Promise<boolean | null> {
		const { entries } = await this.readTrust();
		return findNearestTrustEntry(entries, cwd);
	}

	/** 写入某目录决策（覆盖该路径既有值；键按归一化规则落盘）。 */
	async setDecision(cwd: string, decision: boolean): Promise<void> {
		const { entries, ok } = await this.readTrust();
		if (!ok) return;
		const key = normalizeTrustPath(cwd);
		if (entries[key] === decision) return;
		await this.writeTrust({ ...entries, [key]: decision });
	}

	/** 项目是否含需要信任才能加载的资源（.omp 配置/扩展/skills、逐级 .agents/skills）。 */
	hasRequiringResources(hostCwd: string, userAgentsSkillsDir: string): boolean {
		const configDir = join(hostCwd, ".omp");
		if (
			TRUST_REQUIRING_RESOURCE_FILES.some((file) => existsSync(join(configDir, file)))
		) {
			return true;
		}
		let currentDir = hostCwd;
		while (true) {
			const agentsSkillsDir = join(currentDir, ".agents", "skills");
			if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
				return true;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) return false;
			currentDir = parentDir;
		}
	}

	/**
	 * 决策编排（启动 pi 前的信任确认，纯逻辑 + 注入 ask）：
	 * - 干净项目 → 自动写信任，放行；
	 * - 已信任 → 放行（pi 查 trustStore 即可）；
	 * - 未记录或曾记 false → ask：
	 *   trust-remember → 落盘 true，放行；trust-session → 本次 approve 不落盘；
	 *   deny → 本次 no-approve（不落盘 false，下次仍可重新决策）。
	 * 返回 undefined = 放行且无需信任覆盖指令。
	 */
	async decide(options: TrustDecideOptions): Promise<TrustDecideResult> {
		const { cwd, hostCwd, windowsHome, ask } = options;
		const userAgentsSkillsDir = join(
			windowsHome ?? homedir(),
			".agents",
			"skills",
		);
		if (!this.hasRequiringResources(hostCwd, userAgentsSkillsDir)) {
			await this.ensureTrustedDirectory(cwd);
			return undefined;
		}
		const decision = await this.getDecision(cwd);
		if (decision === true) return undefined;
		const choice = await ask();
		if (choice === "trust-remember") {
			await this.setDecision(cwd, true);
			return undefined;
		}
		if (choice === "trust-session") return "approve";
		return "no-approve"; // deny：本次以不信任模式启动
	}

	private async writeTrust(entries: Record<string, boolean>): Promise<void> {
		try {
			await mkdir(this.configDir, { recursive: true });
			await writeFile(join(this.configDir, "trust.json"), JSON.stringify(entries, null, 2), "utf8");
		} catch {
			// 写失败静默（与原实现一致：信任写入尽力而为）
		}
	}
}

/**
 * 路径归一化：非 "/" 开头走 win32 normalize（\ → /）；"/" 开头走 posix，去尾斜杠。
 */
export function normalizeTrustPath(path: string): string {
	if (!path.startsWith("/")) return normalize(path);
	const normalized = posixNormalize(path);
	return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

/** 键比较归一化：win32 且非 "/" 开头 → 小写（大小写不敏感命中）；posix 保大小写。 */
export function normalizeTrustPathKey(path: string): string {
	const normalized = normalizeTrustPath(path).replace(/[\\/]+$/, "");
	return process.platform === "win32" && !normalized.startsWith("/")
		? normalized.toLowerCase()
		: normalized;
}

/** 沿父目录链查找最近的信任记录（继承语义：祖先决策适用于后代路径）。 */
export function findNearestTrustEntry(
	data: Record<string, boolean>,
	cwd: string,
): boolean | null {
	const normalized = new Map<string, boolean>();
	for (const [key, value] of Object.entries(data)) {
		normalized.set(normalizeTrustPathKey(key), value);
	}
	let current = normalizeTrustPathKey(cwd);
	while (true) {
		const value = normalized.get(current);
		if (value === true || value === false) return value;
		const parent = current.startsWith("/") ? posixDirname(current) : dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
