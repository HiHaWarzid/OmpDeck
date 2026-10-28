/**
 * omp 会话 todo 面板（composer 上方）。
 *
 * 数据源是 `get_state.todoPhases`，不是时间线里的 todo 工具结果：模型改 todo、
 * `/todo` 命令、宿主 set_todos 都会同步到同一份会话状态。点击任务按
 * pending → in_progress → completed → pending 循环，blocked/abandoned 回到 pending，
 * 每次变更整份 phases 经 set_todos 回写 omp，保持模型与 UI 同源。
 */
import { useState } from "react";
import {
	CheckCircle2,
	ChevronDown,
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

export function NativeTodoPanel(props: {
	phases: AgentTodoPhase[];
	/** 流式/启动/压缩中禁用交互，避免与模型正在写入的 todo 抢写。 */
	disabled?: boolean;
	busy?: boolean;
	onSetTodos: (phases: AgentTodoPhase[]) => void;
}) {
	const [expanded, setExpanded] = useState(true);
	const phases = props.phases.filter((phase) => phase.tasks.length > 0);
	const total = phases.reduce((count, phase) => count + phase.tasks.length, 0);
	const done = phases.reduce(
		(count, phase) => count + phase.tasks.filter((task) => task.status === "completed").length,
		0,
	);

	const advance = (phaseIndex: number, taskIndex: number) => {
		const nextPhases = props.phases.map((phase, pIndex) => {
			if (pIndex !== phaseIndex) return phase;
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

	return (
		<div className="extension-widget-card native-todo-card" data-widget-key="omp-native-todo">
			<div className="extension-widget-card-header">
				<button
					type="button"
					className="extension-widget-card-trigger"
					onClick={() => setExpanded((prev) => !prev)}
					aria-expanded={expanded}
				>
					<ChevronDown
						size={14}
						className={`extension-widget-card-chevron${expanded ? " open" : ""}`}
					/>
					<span className="extension-widget-card-title">{t("app.widgetTodo")}</span>
					<span className="extension-widget-card-meta">
						{done}/{total}
					</span>
					{props.busy && <span className="native-todo-busy">{t("app.todoSaving")}</span>}
				</button>
			</div>
			{expanded && (
				<div className="extension-widget-card-content native-todo-content">
					{phases.map((phase, phaseIndex) => (
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
			)}
		</div>
	);
}
