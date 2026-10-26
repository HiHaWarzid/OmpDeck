import type { OmpConfigPatch } from "./types";

/**
 * 设置页可编辑的 omp config.yml 键（点路径）。
 *
 * 事实源是 omp schema（`omp config list --json`），这里只挑出 OmpDeck 设置页
 * 有控件覆盖的常用键；其余键（modelRoles、auth.broker.* 等）一律走「源文件」
 * 页或各自的 store，避免 UI 以旧 schema 整份覆盖用户配置。
 */
export const OMP_SETTINGS_PATHS = [
	"enabledModels",
	"retry.maxRetries",
	"retry.baseDelayMs",
	"compaction.enabled",
	"compaction.reserveTokens",
	"compaction.keepRecentTokens",
] as const;

export type OmpSettingsPath = (typeof OMP_SETTINGS_PATHS)[number];

/** 读取点路径当前值；缺失/不可穿越返回 undefined（= 未配置，走 omp 默认）。 */
export function readOmpPath(root: Record<string, unknown>, path: string): unknown {
	let cursor: unknown = root;
	for (const key of path.split(".")) {
		if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return cursor;
}

/**
 * 不可变写入点路径，返回新草稿（`retry.maxRetries` → `{ retry: { maxRetries } }`）。
 *
 * - value === undefined = 删除该键（回到 omp 默认），并向上修剪空父节点，
 *   避免把 `retry: {}` 这类空壳写进 config.yml；
 * - 只复制路径上的映射，其它键（含用户的未知键）原样共享引用，不做深拷贝。
 */
export function writeOmpPath(
	root: Record<string, unknown>,
	path: string,
	value: unknown,
): Record<string, unknown> {
	const keys = path.split(".");
	const next: Record<string, unknown> = { ...root };
	const parents: Array<Record<string, unknown>> = [next];
	let cursor = next;
	for (const key of keys.slice(0, -1)) {
		const child = cursor[key];
		const copy =
			child && typeof child === "object" && !Array.isArray(child)
				? { ...(child as Record<string, unknown>) }
				: {};
		cursor[key] = copy;
		parents.push(copy);
		cursor = copy;
	}
	const lastKey = keys[keys.length - 1];
	if (value === undefined) delete cursor[lastKey];
	else cursor[lastKey] = value;
	for (let depth = parents.length - 1; depth >= 1; depth--) {
		if (Object.keys(parents[depth]).length > 0) break;
		delete parents[depth - 1][keys[depth - 1]];
	}
	return next;
}

/**
 * 设置 enabledModels 里某个模型 id 的选中态，返回新数组。
 *
 * enabledModels 的条目允许两种形状：字符串（模型 id）与 path-scoped 对象
 * `{ path, models }`。UI 只能勾选字符串 id，因此这里只增删字符串条目，
 * 其它条目必须原样保留——否则一次勾选就会把用户的 path-scoped 规则写丢。
 */
export function setEnabledModelSelected(
	entries: readonly unknown[],
	id: string,
	selected: boolean,
): unknown[] {
	return selected
		? [...entries, id]
		: entries.filter((entry) => entry !== id);
}

/**
 * omp config.yml 的 hideThinkingBlock → 桌面 showThinking（取反）。
 * omp 只读 config.yml；未设置或非布尔值返回 undefined，由调用方决定默认值。
 */
export function readShowThinkingSetting(
	root: Record<string, unknown>,
): boolean | undefined {
	const hidden = root.hideThinkingBlock;
	return typeof hidden === "boolean" ? !hidden : undefined;
}

/**
 * 导出：只取设置页可编辑键中已配置的部分。
 * 其它 config.yml 键不入包（含可能带凭据的 auth.broker.*）。
 */
export function pickOmpSettings(root: Record<string, unknown>): Record<string, unknown> {
	let picked: Record<string, unknown> = {};
	for (const path of OMP_SETTINGS_PATHS) {
		const value = readOmpPath(root, path);
		if (value === undefined) continue;
		picked = writeOmpPath(picked, path, value);
	}
	return picked;
}

/**
 * 导入：包内出现的键覆盖目标（package wins）；包内缺失的键保持目标原值，
 * 与 OmpRolesStore.importPackage 的「只写给出项」语义一致。
 */
export function ompSettingsPatchFromPackage(root: Record<string, unknown>): OmpConfigPatch {
	const set: NonNullable<OmpConfigPatch["set"]> = [];
	for (const path of OMP_SETTINGS_PATHS) {
		const value = readOmpPath(root, path);
		if (value === undefined) continue;
		set.push({ path, value });
	}
	return { set };
}

/**
 * 设置页草稿 vs 载入基线的差异 → 只包含改动键的补丁（空补丁不落盘）。
 * 值用 JSON 序列化比较：true / 1 / "1" 不会互相等价，数组顺序变化算改动。
 */
export function diffOmpSettings(
	baseline: Record<string, unknown>,
	draft: Record<string, unknown>,
): OmpConfigPatch {
	const set: NonNullable<OmpConfigPatch["set"]> = [];
	const unset: string[] = [];
	for (const path of OMP_SETTINGS_PATHS) {
		const before = readOmpPath(baseline, path);
		const after = readOmpPath(draft, path);
		if (after === undefined) {
			if (before !== undefined) unset.push(path);
			continue;
		}
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			set.push({ path, value: after });
		}
	}
	return { set, unset };
}
