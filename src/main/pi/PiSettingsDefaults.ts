/**
 * 补齐 pi 全局 settings.json 的推荐默认项。
 *
 * 之前内联在 index.ts 中（ensurePiSettingsDefaults + ensureAllPiSettingsDefaults），
 * 此处抽成独立模块：
 * - 仅添加缺失的 key，不覆盖用户已有配置
 * - 适用于新安装 pi 或配置精简的用户
 * - 同时支持 Windows 本地与 WSL 环境的 settings.json
 */
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { app } from "electron";
import type { AppSettings } from "../../shared/types";
import type { PiLocator } from "./PiLocator";
import type { WslEnvironment } from "../wsl/WslPaths";

/** pi settings.json 的推荐默认项。仅添加缺失的 key，不覆盖用户已有配置。 */
const PI_SETTINGS_DEFAULTS: Record<string, unknown> = {
	theme: "dark",
	hideThinkingBlock: false,
	defaultProjectTrust: "ask",
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	retry: { enabled: true, maxRetries: 3 },
};

/** 补齐指定 configDir 下 settings.json 的缺失默认项。 */
export async function ensurePiSettingsDefaults(
	configDir: string,
	piVersionHint?: string,
): Promise<void> {
	const filePath = join(configDir, "settings.json");
	let current: Record<string, unknown> = {};
	try {
		const raw = await readFile(filePath, "utf8");
		current = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		/* 文件不存在或解析失败，使用空对象 */
	}

	let changed = false;

	if (piVersionHint && !current.lastChangelogVersion) {
		current.lastChangelogVersion = piVersionHint;
		changed = true;
	}

	for (const [key, defaultValue] of Object.entries(PI_SETTINGS_DEFAULTS)) {
		if (!(key in current)) {
			current[key] = defaultValue;
			changed = true;
		}
	}

	if (changed) {
		await mkdir(configDir, { recursive: true });
		await writeFile(filePath, JSON.stringify(current, null, 2), "utf8");
		console.log("[OmpDeck] Ensured pi settings defaults at:", filePath);
	}
}

/**
 * 对当前环境和 WSL 环境（如果启用）都补齐 settings.json 默认项。
 * 自动获取 pi 版本写入 lastChangelogVersion，避免用户漏配。
 */
export async function ensureAllPiSettingsDefaults(
	settings: AppSettings,
	locator: PiLocator,
	activeWslEnvironment: WslEnvironment | null,
): Promise<void> {
	const piVersion = (await locator.check(undefined, settings.wslEnabled, settings.wslDistro, settings.wslUser).catch(() => null))?.version ?? "";

	// Windows 本地
	const winDir = join(app.getPath("home"), ".omp", "agent");
	await ensurePiSettingsDefaults(winDir, piVersion).catch(() => {});

	// WSL（如果已配置）
	if (activeWslEnvironment) {
		const wslDir = join(activeWslEnvironment.windowsHome, ".omp", "agent");
		await ensurePiSettingsDefaults(wslDir, piVersion).catch(() => {});
	}
}
