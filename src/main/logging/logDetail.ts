/**
 * 日志 detail 序列化：把调用方随手传进来的 Error / 嵌套 Error 转成可读结构。
 *
 * 背景：`JSON.stringify(new Error("x"))` 得到 `{}`，Error 的 name/message/stack 都是
 * 非枚举属性。历史日志里因此出现过 `{"error":{}}` 这种「失败原因完全丢失」的记录
 * （例如 `Failed to list sessions`），线上问题只能靠猜。这里做深度转换：
 * - Error（含嵌套在对象/数组里的）→ { name, message, stack }；
 * - 循环引用 → "[Circular]"；
 * - 超深/超长结构截断，避免一条日志把整个运行时状态序列化出来拖慢主进程；
 * - bigint / function / symbol 等不可 JSON 化的值转字符串。
 */

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 60;
const MAX_STRING_LENGTH = 4000;

function serializeError(error: Error): Record<string, unknown> {
	const result: Record<string, unknown> = {
		name: error.name,
		message: error.message,
	};
	if (error.stack) result.stack = error.stack;
	// Node 的错误常带 code/errno/path 等自有字段（例如 ENOENT），它们往往比 message 更精确。
	// Error 实例的全部自有属性都按记录读取，这里一次性收敛成记录类型，避免逐字段断言。
	const errorRecord = error as Error & Record<string, unknown>;
	for (const key of Object.keys(errorRecord)) {
		if (key in result) continue;
		result[key] = errorRecord[key];
	}
	// AggregateError / 自定义 cause 链：保留一层原因，避免丢失根因。
	if ("cause" in error && error.cause !== undefined) {
		result.cause = error.cause;
	}
	return result;
}

export function serializeLogDetail(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
	if (value === null || value === undefined) return value;
	if (value instanceof Error) {
		return serializeLogDetail(serializeError(value), depth, seen);
	}
	const type = typeof value;
	if (type === "string") {
		const text = value as string;
		return text.length > MAX_STRING_LENGTH
			? `${text.slice(0, MAX_STRING_LENGTH)}…(${text.length} chars)`
			: text;
	}
	if (type !== "object") {
		// bigint 不能 JSON.stringify；function/symbol 序列化后也只会丢信息。
		return type === "bigint" ? `${String(value)}n` : type === "function" ? "[Function]" : type === "symbol" ? String(value) : value;
	}
	if (depth >= MAX_DEPTH) return "[MaxDepth]";
	const object = value as object;
	if (seen.has(object)) return "[Circular]";
	seen.add(object);
	try {
		if (Array.isArray(value)) {
			const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => serializeLogDetail(item, depth + 1, seen));
			if (value.length > MAX_ARRAY_ITEMS) items.push(`…(${value.length} items)`);
			return items;
		}
		if (value instanceof Map) {
			return serializeLogDetail(Object.fromEntries(value), depth, seen);
		}
		if (value instanceof Set) {
			return serializeLogDetail([...value], depth, seen);
		}
		if (value instanceof Date) return value.toISOString();
		if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
			return `[Buffer ${value.byteLength} bytes]`;
		}
		const entries: Record<string, unknown> = {};
		// typeof 判定为非 null 对象后，Object.keys 的键一定可索引；一次性收敛成记录类型。
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
			entries[key] = serializeLogDetail(record[key], depth + 1, seen);
		}
		if (keys.length > MAX_OBJECT_KEYS) entries["…"] = `(${keys.length} keys)`;
		return entries;
	} finally {
		seen.delete(object);
	}
}
