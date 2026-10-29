/**
 * omp 会话 todo 列表，渲染在 composer dock 的 TODO 分区里（标题/展开由 chip 承担）。
 *
 * 数据源是 `get_state.todoPhases`，不是时间线里的 todo 工具结果：模型改 todo、
 * `/todo` 命令、宿主 set_todos 都会同步到同一份会话状态。点击任务按
 * pending → in_progress → completed → pending 循环，blocked/abandoned 回到 pending，
 * 每次变更整份 phases 经 set_todos 回写 omp，保持模型与 UI 同源。
 *
 * omp 只在新一轮写入 todo 时替换列表，所以上一轮全部完成后旧列表会留着；
 * 这种“已完成”的列表必须标注来源，否则会被误读成本轮计划（见 settled 分支）。
 */
import {
	CheckCircle2,
	Circle,
	CircleDot,
	CircleSlash,
	CircleX,
} from "lucide-react";
import type { AgentTodoItem, AgentTodoPhase, AgentTodoStatus } from "../../../../../shared/types";
import { t } from "../../../i18n";

const NEXT_STATUS: Record<AgentTodoStatus, AgentTodoStatus> = {
	pending: "in_progress",
	in_progress: "completed",
	completed: "pending",
	blocked: "pending",
	abandoned: "pending",
};

const STATUS_META: Record<
	AgentTodoStatus,
	{ labelKey: "todo.statusPending" | "todo.statusInProgress" | "todo.statusCompleted" | "todo.statusBlocked" | "todo.statusAbandoned"; Icon: typeof Circle }
> = {
	pending: { labelKey: "todo.statusPending", Icon: Circle },
	in_progress: { labelKey: "todo.statusInProgress", Icon: CircleDot },
	completed: { labelKey: "todo.statusCompleted", Icon: CheckCircle2 },
	blocked: { labelKey: "todo.statusBlocked", Icon: CircleSlash },
	abandoned: { labelKey: "todo.statusAbandoned", Icon: CircleX },
};

/**
 * todo 列表的计数与“上一轮已完成”判定，只在这里算一次：
 * dock chip 的进度标签和列表里的来源提示必须永远一致。
 */
export function summarizeTodoPhases(phases: AgentTodoPhase[]): {
	total: number;
	done: number;
	settled: boolean;
} {
	const total = phases.reduce((count, phase) => count + phase.tasks.length, 0);
	const done = phases.reduce(
		(count, phase) => count + phase.tasks.filter((task) => task.status === "completed").length,
		0,
	);
	return { total, done, settled: total > 0 && done === total };
}

export function NativeTodoPanel(props: {
	phases: AgentTodoPhase[];
	/** 流式/启动/压缩中禁用交互，避免与模型正在写入的 todo 抢写。 */
	disabled?: boolean;
	busy?: boolean;
	onSetTodos: (phases: AgentTodoPhase[]) => void;
}) {
	// 空阶段不渲染，但回写时要按原始下标定位，否则空阶段会让后面的点击写错目标。
	const visiblePhases = props.phases
		.map((phase, index) => ({ phase, index }))
		.filter((entry) => entry.phase.tasks.length > 0);
	const phases = visiblePhases.map((entry) => entry.phase);
	const { settled } = summarizeTodoPhases(props.phases);

	const advance = (originalPhaseIndex: number, taskIndex: number) => {
		const nextPhases = props.phases.map((phase, pIndex) => {
			if (pIndex !== originalPhaseIndex) return phase;
			return {
				...phase,
				tasks: phase.tasks.map((task, tIndex) => {
					if (tIndex !== taskIndex) return task;
					const status = NEXT_STATUS[task.status];
					const next: AgentTodoItem = { ...task, status };
					// blocker 只属于 blocked 状态；离开 blocked 时一并清掉，避免 UI 悬挂旧原因。
					if (status !== "blocked") delete next.blocker;
					return next;
				}),
			};
		});
		props.onSetTodos(nextPhases);
	};

	const showPhaseNames = phases.length > 1 || phases.some((phase) => phase.name.trim() !== "");
	// omp 只在模型写入 todo 时才替换列表：上一轮全部完成后列表会原样留到下一轮。
	// 这种情况必须显式标注来源，否则用户会把旧结果当成当前计划（面板看着像本轮已做完）。

	const content = (
		<div className="extension-widget-card-content native-todo-content">
			{props.busy && <div className="native-todo-round-hint">{t("app.todoSaving")}</div>}
			{settled && <div className="native-todo-round-hint">{t("app.todoRoundSettledHint")}</div>}
			{visiblePhases.map(({ phase, index: phaseIndex }) => (
				<div className="native-todo-phase" key={`${phase.name}-${phaseIndex}`}>
					{showPhaseNames && phase.name.trim() && (
						<div className="native-todo-phase-name">{phase.name}</div>
					)}
					{phase.tasks.map((task, taskIndex) => {
						const meta = STATUS_META[task.status];
						const label = t(meta.labelKey);
						const Icon = meta.Icon;
						return (
							<button
								type="button"
								key={`${phaseIndex}-${taskIndex}`}
								className={`native-todo-item status-${task.status}`}
								disabled={props.disabled || props.busy}
								onClick={() => advance(phaseIndex, taskIndex)}
								title={`${label} · ${t("app.todoPanelHint")}${task.blocker ? `\n${task.blocker}` : ""}`}
								aria-label={`${label}: ${task.content}`}
							>
								<Icon
									size={13}
									strokeWidth={task.status === "in_progress" ? 2.2 : 1.8}
									aria-hidden="true"
								/>
								<span className="native-todo-text">{task.content}</span>
								<span className="native-todo-status">{label}</span>
							</button>
						);
					})}
				</div>
			))}
		</div>
	);

	// 标题与展开态由 composer dock 的 chip 承担，这里只渲染任务列表。
	return (
		<div className="extension-widget-card native-todo-card is-bare" data-widget-key="omp-native-todo">
			{content}
		</div>
	);
}
