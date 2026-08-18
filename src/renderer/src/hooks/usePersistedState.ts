import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * localStorage 持久化的 useState：读（含解析/校验/迁移）-写（含序列化/落盘）与
 * ref 镜像收敛到一处，替代散落在各处的 load / save 成对 helper 与 useState 初始化。
 *
 * - 存储键、解析/迁移逻辑与既有实现完全一致（无数据丢失）；
 * - 返回的 [value, setValue, valueRef] 中的 ref 与值同步：setValue 同步写 ref
 *   与 localStorage（挂载一次的 IPC 监听器/事件回调可立即读到最新值，不依赖
 *   React 渲染时序）；value 仅驱动重渲染；
 * - 多次连续 setValue 以 ref 当前值为基准组合，等价于旧 ref 直写语义；
 * - 第 4 个返回值是裸 setState（不落盘）：高频路径（如拖拽 onMove 逐帧宽度）
 *   用它只更新内存值，落盘只在低频的 onUp 一次性调用 setValue。
 */
export type UsePersistedStateOptions<T> = {
	/**
	 * 读取时把 JSON 解析结果转成合法值（校验/clamp/旧格式迁移）。
	 * 返回 undefined 表示存储值无效，回退 defaultValue。缺省直接收下解析结果。
	 */
	parse?: (raw: unknown) => T | undefined;
	/** 写入前变换（如 clamp/round）；缺省原值 JSON 序列化。 */
	serialize?: (value: T) => unknown;
};

function readStored<T>(
	key: string,
	defaultValue: T,
	parse: UsePersistedStateOptions<T>["parse"],
): T {
	try {
		const raw = localStorage.getItem(key);
		if (raw == null) return defaultValue;
		const parsed: unknown = JSON.parse(raw);
		const migrated = parse ? parse(parsed) : (parsed as T);
		return migrated === undefined ? defaultValue : migrated;
	} catch {
		// localStorage 不可用 / 内容损坏：静默回退默认值，不影响主流程
		return defaultValue;
	}
}

export function usePersistedState<T>(
	key: string,
	defaultValue: T,
	options: UsePersistedStateOptions<T> = {},
): [
	T,
	Dispatch<SetStateAction<T>>,
	React.MutableRefObject<T>,
	Dispatch<SetStateAction<T>>,
] {
	const { parse, serialize } = options;
	const [value, setValue] = useState<T>(() =>
		readStored(key, defaultValue, parse),
	);
	const valueRef = useRef<T>(value);
	valueRef.current = value;

	const setPersisted = useCallback(
		(action: SetStateAction<T>) => {
			const prev = valueRef.current;
			const next =
				typeof action === "function"
					? (action as (prev: T) => T)(prev)
					: action;
			if (next === prev) return;
			valueRef.current = next;
			try {
				localStorage.setItem(key, JSON.stringify(serialize ? serialize(next) : next));
			} catch {
				// 配额/隐私模式失败时静默忽略；值仍在本会话内存中有效
			}
			setValue(next);
		},
		[key, serialize],
	);

	return [value, setPersisted, valueRef, setValue];
}