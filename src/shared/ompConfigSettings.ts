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
 * 配置值的结构化相等：嵌套对象按内容比较（键顺序无关），数组按顺序逐项比较。
 *
 * 为什么不用 JSON.stringify：同一份映射换个插入顺序就会字符串不同，
 * 于是「把值改回原样」仍被判成改动 —— 草稿回退因此看起来没生效。
 * 类型必须严格一致（true / 1 / "1" 互不相等），所以先比 typeof 再比内容。
 */
export function configValuesEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== typeof b || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => configValuesEqual(item, b[index]));
	}
	if (typeof a !== "object") return false;
	// 到这里 a / b 都是同类型的普通映射（YAML 解析结果没有 Date/Map 等 exotic 值）
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every(
		(key) =>
			Object.prototype.hasOwnProperty.call(right, key) &&
			configValuesEqual(left[key], right[key]),
	);
}

/**
 * 基线 vs 草稿在给定点路径上的差异 → 只包含改动路径的补丁（空补丁不落盘）。
 * 路径集合由调用方给出：设置页只提交可编辑键，配置页同理，非可编辑键一律不碰。
 *
 * 这是「设置页怎么算 dirty」的唯一实现。渲染层草稿引擎
 * （renderer/src/utils/configDraft.ts 的 draftPatch / hasDraftChanges）包在本函数上，
 * 因此不要再在这里加 `diffOmpSettings(baseline, draft)` 之类的便捷包装——
 * 多一个同语义导出，就多一份可以悄悄漂移的口径。
 */
export function diffOmpPathValues(
	baseline: Record<string, unknown>,
	draft: Record<string, unknown>,
	paths: readonly string[],
): OmpConfigPatch {
	const set: NonNullable<OmpConfigPatch["set"]> = [];
	const unset: string[] = [];
	for (const path of paths) {
		const before = readOmpPath(baseline, path);
		const after = readOmpPath(draft, path);
		if (after === undefined) {
			if (before !== undefined) unset.push(path);
			continue;
		}
		if (!configValuesEqual(before, after)) {
			set.push({ path, value: after });
		}
	}
	return { set, unset };
}
