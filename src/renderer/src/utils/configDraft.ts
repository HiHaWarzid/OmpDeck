/**
 * 配置草稿引擎（零 React 依赖，纯函数）。
 *
 * 为什么需要它：设置弹框、配置弹框、模型角色 tab 三处都在编辑「已落盘的配置」，
 * 但各自实现了一套脏判定：
 * - 设置弹框记「被 patch 过的字段集合」，把值改回原值后集合里仍留着键，
 *   于是 save bar 和关闭守卫继续提示「有未保存更改」（回退不生效的 bug）；
 * - 配置弹框自己比 baseline，但没把 dirty 交给弹层守卫，关窗即静默丢草稿；
 * - 模型角色 tab 直接拿 draft 字符串和已落盘值比。
 *
 * 本 module 把草稿语义收敛成一份实现：`value` 是正在编辑的值，`base` 是它的
 * 唯一比较对象，脏不脏一律由**值 diff**（不是「改过哪些字段」）得出，落盘成功后
 * 由 `commitDraft` 决定 base 推进到哪。三个消费点只保留「怎么呈现」和
 * 「调哪个 RPC」，不再各写一遍 dirty 判定。
 *
 * 值比较与点路径补丁复用 shared/ompConfigSettings（与主进程同口径），
 * 避免嵌套结构/数组/数值类型的比较语义在两处漂移。
 */
import {
	configValuesEqual,
	diffOmpPathValues,
	readOmpPath,
	writeOmpPath,
} from "../../../shared/ompConfigSettings";
import type { OmpConfigPatch } from "../../../shared/types/config";

export interface Draft<T extends object> {
	/** 最后确认落盘（或载入）的基线；dirty 的唯一比较对象 */
	readonly base: T;
	/** 用户正在编辑的值 */
	readonly value: T;
}

/** 建草稿：value 与 base 指向同一份初始值，因此刚打开时必然是干净的。 */
export function createDraft<T extends object>(seed: T): Draft<T> {
	return { base: seed, value: seed };
}

/**
 * 顶层键浅合并（AppSettings 这类扁平记录）。
 * 嵌套对象必须整体替换而不是就地改写，否则 value 与 base 会共享同一个对象引用，
 * 嵌套字段的 diff 永远看不出来 —— 这是「必须不可变更新」的原因。
 */
export function patchDraft<T extends object>(draft: Draft<T>, changes: Partial<T>): Draft<T> {
	return { base: draft.base, value: { ...draft.value, ...changes } };
}

/** 整份替换草稿值（配置弹框的 SettingsTab 以 writeOmpPath 返回新的根对象）。 */
export function setDraftValue<T extends object>(draft: Draft<T>, value: T): Draft<T> {
	return { base: draft.base, value };
}

/**
 * 值 diff：返回真正与 base 不同的键/路径。
 * 不传 paths 时按顶层键比较（扁平记录）；传点路径时按路径逐个比较（config.yml）。
 */
export function dirtyPaths<T extends object>(
	draft: Draft<T>,
	paths?: readonly string[],
): string[] {
	const base = draft.base as Record<string, unknown>;
	const value = draft.value as Record<string, unknown>;
	const candidates = paths ?? [...new Set([...Object.keys(base), ...Object.keys(value)])];
	return candidates.filter(
		(path) => !configValuesEqual(readOmpPath(base, path), readOmpPath(value, path)),
	);
}

/** 是否有未保存更改；paths 语义同 `dirtyPaths`。 */
export function hasDraftChanges<T extends object>(
	draft: Draft<T>,
	paths?: readonly string[],
): boolean {
	return dirtyPaths(draft, paths).length > 0;
}

/** 单个字段/路径是否与基线不同（标签旁的未保存圆点、按钮禁用都用它）。 */
export function isFieldDirty<T extends object>(draft: Draft<T>, path: string): boolean {
	return dirtyPaths(draft, [path]).length > 0;
}

/**
 * 顶层键的改动值，可直接作为 `onChange(patch)` 的入参。
 * 只含真正不同的键：回退到基线值的字段不会出现在这里。
 */
export function draftChanges<T extends object>(draft: Draft<T>): Partial<T> {
	const value = draft.value as Record<string, unknown>;
	const changes: Record<string, unknown> = {};
	for (const key of dirtyPaths(draft)) changes[key] = value[key];
	return changes as Partial<T>;
}

/** 点路径补丁（omp config.yml）：只写真正改动的键，未改的键连同注释一起保留。 */
export function draftPatch<T extends object>(
	draft: Draft<T>,
	paths: readonly string[],
): OmpConfigPatch {
	return diffOmpPathValues(
		draft.base as Record<string, unknown>,
		draft.value as Record<string, unknown>,
		paths,
	);
}

/**
 * 落盘成功后推进基线：只把**真正落盘**的部分（paths，默认全部 dirty 键）从
 * value 搬到 base，value 保持不动。
 *
 * 为什么只推进这些键：保存是异步的，请求在途时用户可能继续编辑别的字段；
 * 若把整份 value 设为 base，这些新编辑会被当成「已保存」而静默丢失。
 * 落盘失败时不要调用本函数 —— draft 与 dirty 都必须原样保留。
 *
 * 为什么要在 paths 之外再收一份 persisted：paths 只说明「哪些键落盘了」，
 * 不说明「落盘的是哪个值」。调用方通常先算 patch 再 await 写入，若此间用户
 * 继续输入，draft.value 已比 patch 新；此时从 value 取值推进基线，会让那段
 * 从未发送出去的文本变成「已保存」，关闭弹层即丢失。传 persisted（就是刚
 * 提交的那份 patch）才能让基线与磁盘真值一致。
 */
export function commitDraft<T extends object>(
	draft: Draft<T>,
	paths?: readonly string[],
	persisted?: Partial<T>,
): Draft<T> {
	const source = (persisted ?? draft.value) as Record<string, unknown>;
	let base = draft.base as Record<string, unknown>;
	for (const path of paths ?? dirtyPaths(draft)) {
		base = writeOmpPath(base, path, readOmpPath(source, path));
	}
	return { base: base as T, value: draft.value };
}

/**
 * 采信外部真值（即时保存的开关、重新载入的配置）：base 与 value 一起更新，
 * 这些键随之变干净。用于「不经过草稿直接落盘」的字段，避免草稿继续显示旧值。
 */
export function adoptDraft<T extends object>(draft: Draft<T>, values: Partial<T>): Draft<T> {
	return {
		base: { ...draft.base, ...values },
		value: { ...draft.value, ...values },
	};
}

/**
 * 只把**已落盘**的路径对齐到磁盘真值，其余路径的草稿与基线原样保留。
 *
 * 与 `adoptDraft` 的区别：那个只接受顶层浅合并的值，无法表达 config.yml 的点路径；
 * 与「整份重载」的区别：那个会把尚未提交的编辑一起抹掉。逐字段保存的界面
 * （一次只写一个键，但读回来的是整份配置）必须用这个：否则保存 A 字段的回读
 * 会把同时编辑中的 B 字段静默清空。
 *
 * `paths` 里的键若在磁盘上不存在（unset），会把该路径写成 undefined。
 *
 * `submitted` 给出**本次提交出去的值**，用于处理「请求在途期间用户又改了同一字段」：
 * 那时磁盘真值属于更早的一次输入，直接写回 `value` 会吞掉在途编辑并把草稿标成干净。
 * 因此只有当 `value` 仍等于提交值（用户没再动过）时才对齐 `value`；`base` 一律对齐，
 * 它描述的是磁盘事实。不传 `submitted` 则退化为无条件对齐（调用方确认没有在途编辑）。
 */
export function rebaseDraft<T extends object>(
	draft: Draft<T>,
	fresh: T,
	paths: readonly string[],
	submitted?: Partial<T>,
): Draft<T> {
	let base = draft.base as Record<string, unknown>;
	let value = draft.value as Record<string, unknown>;
	const source = fresh as Record<string, unknown>;
	const submittedSource = submitted as Record<string, unknown> | undefined;
	for (const path of paths) {
		const next = readOmpPath(source, path);
		base = writeOmpPath(base, path, next);
		// 没有提交值可比（调用方保证无在途编辑）时保持旧语义。
		const untouched =
			submittedSource === undefined ||
			configValuesEqual(readOmpPath(value, path), readOmpPath(submittedSource, path));
		if (untouched) value = writeOmpPath(value, path, next);
	}
	return { base: base as T, value: value as T };
}

/** 丢弃全部未保存更改：value 回退到 base（base 不动）。 */
export function resetDraft<T extends object>(draft: Draft<T>): Draft<T> {
	return { base: draft.base, value: draft.base };
}
