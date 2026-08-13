import type { TodoItem, TodoStatus } from "./types/message";

/**
 * 识别 todo 写入类工具（大小写不敏感）。
 * omp 原生工具名为 "todo"；TodoWrite / todo_write 为其它 harness（Claude Code 等）的命名变体。
 * 只匹配写入工具，不匹配 todo_list / todo_get 等只读查询——它们不更新 todo 列表。
 */
export function isTodoWriteToolName(toolName: string | undefined): boolean {
	const key = (toolName ?? "").toLowerCase();
	return key === "todo" || key === "todowrite" || key === "todo_write";
}

/** 把未知状态归一化为合法三态；omp 内部数字枚举（2=in_progress/3=completed）也在实时快照里转为字符串，无需额外兼容。 */
function normalizeStatus(status: unknown): TodoStatus {
	return status === "pending" || status === "in_progress" || status === "completed"
		? status
		: "pending";
}

/**
 * 归一化 TodoWrite 风格的 todos 数组（[{content,status,activeForm}]）。
 * 过滤掉结构非法/空 content 的畸形项。
 */
export function normalizeTodoItems(todos: unknown): TodoItem[] {
	if (!Array.isArray(todos)) return [];
	const items: TodoItem[] = [];
	for (const item of todos) {
		if (!item || typeof item !== "object") continue;
		const obj = item as { content?: unknown; status?: unknown; activeForm?: unknown };
		if (typeof obj.content !== "string" || !obj.content) continue;
		items.push({
			content: obj.content,
			status: normalizeStatus(obj.status),
			...(typeof obj.activeForm === "string" && obj.activeForm ? { activeForm: obj.activeForm } : {}),
		});
	}
	return items;
}

/**
 * 从 omp todo 工具的结构化快照（result.details.phases）归一化 todo 列表。
 * phases: [{ name, tasks: [{ content, status }] }]，每项保留所属 phase 名用于分组展示。
 * 无 phases 时回退到 TodoWrite 风格数组（兼容老协议）。
 */
export function normalizeTodoSnapshot(details: unknown): TodoItem[] {
	if (!details || typeof details !== "object") return [];
	const typed = details as Record<string, unknown>;
	const phases = typed.phases;
	if (Array.isArray(phases)) {
		const items: TodoItem[] = [];
		for (const phase of phases) {
			if (!phase || typeof phase !== "object") continue;
			const phaseObj = phase as { name?: unknown; tasks?: unknown };
			const phaseName = typeof phaseObj.name === "string" && phaseObj.name ? phaseObj.name : undefined;
			const tasks = phaseObj.tasks;
			if (!Array.isArray(tasks)) continue;
			for (const task of tasks) {
				if (!task || typeof task !== "object") continue;
				const taskObj = task as { content?: unknown; status?: unknown };
				if (typeof taskObj.content !== "string" || !taskObj.content) continue;
				items.push({
					content: taskObj.content,
					status: normalizeStatus(taskObj.status),
					...(phaseName ? { phase: phaseName } : {}),
				});
			}
		}
		return items;
	}
	// 兼容老协议：details 直接就是 todos 数组（或含 todos 字段的对象）
	if (Array.isArray(typed.todos)) return normalizeTodoItems(typed.todos);
	if (Array.isArray(details)) return normalizeTodoItems(details);
	return [];
}

/**
 * 从工具消息 meta 中提取 todo 列表。
 * 优先 omp 的结构化快照（meta.details.phases），回退 TodoWrite 风格入参（meta.args.todos）。
 */
export function extractTodoItems(meta: Record<string, unknown> | undefined): TodoItem[] {
	if (!meta) return [];
	// omp：details 是主进程保存的 result.details 对象（含 phases 快照）
	const details = meta.details;
	if (details && typeof details === "object") {
		const fromPhases = normalizeTodoSnapshot(details);
		if (fromPhases.length > 0) return fromPhases;
	}
	// TodoWrite 风格：meta.args 是 JSON 字符串（实时与历史路径都是 truncateForDetail(safeJson(args))）
	const argsRaw = meta.args;
	if (typeof argsRaw !== "string") return [];
	try {
		const parsed = JSON.parse(argsRaw) as { todos?: unknown };
		return normalizeTodoItems(parsed.todos);
	} catch {
		return [];
	}
}

/** 从工具结果对象提取 details 字段（omp todo 的状态快照所在）。 */
export function extractResultDetails(result: unknown): unknown {
	if (!result || typeof result !== "object") return undefined;
	const typed = result as Record<string, unknown>;
	const details = typed.details;
	if (details !== undefined) return details;
	// omp 的 tool_execution_end.result 直接就是 todo 快照（{op, phases, storage}），
	// 没有 details 包装；形似快照（含 phases/todos 数组）时整体返回，让
	// normalizeTodoSnapshot 解析。普通工具结果（{content: [...]} 等）不受影响。
	if (Array.isArray(typed.phases) || Array.isArray(typed.todos)) return result;
	return undefined;
}
