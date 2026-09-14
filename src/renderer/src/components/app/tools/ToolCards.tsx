/** 工具调用卡片：ToolCard 与按轮聚合的 ToolGroupCard，以及工具名/参数的展示推导。 */
import { memo, useState, type ReactNode } from "react";
import {
	type ToolGroupItem,
	parseToolArgs,
	getToolFilePath,
	countTextLines,
	getToolEditDiff,
} from "../AppUtils";
import {
	Check,
	ChevronDown,
	Circle,
	CircleDot,
	Brain,
	FileText,
	Folder,
	Globe2,
	MessageCircle,
	Network,
	Search,
	Terminal,
	Wrench,
	Copy,
	SquarePen,
	ListTodo,
} from "lucide-react";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { writeClipboard } from "../../../utils/clipboard";
import type { ChatMessage, TodoItem } from "../../../../../shared/types";
import { extractTodoItems, isTodoWriteToolName } from "../../../../../shared/todo";
import { formatDuration, stripAnsi } from "../format";
import type { DiffFileHandler } from "../types";

// ============================================================
// 会话时间线渲染组件（借鉴 opencode 扁平 timeline 风格重写）
// 设计要点：
// - 助手内容去掉气泡，改为左对齐扁平排版，用左侧竖线聚合一轮对话
// - 工具调用做成独立可折叠卡片，trigger 行 + 展开内容，内联在 timeline 里
// - 用户消息保留右对齐气泡，但收窄并去掉头像，操作栏 hover 显隐
// - 思考过程做成轻量折叠卡片，不再占用大块气泡空间
// ============================================================

/** 按工具名选择语义图标：read→文件、edit→铅笔、bash→终端、grep→搜索等，未匹配回退扳手。 */
function toolIcon(toolName: string): ReactNode {
	const key = toolName.toLowerCase();
	if (key.includes("read") || key.includes("view")) return <FileText size={15} />;
	if (key.includes("write") || key.includes("edit") || key.includes("apply_patch") || key.includes("patch"))
		return <SquarePen size={15} />;
	if (key.includes("bash") || key.includes("shell") || key.includes("terminal")) return <Terminal size={15} />;
	if (key.includes("grep") || key.includes("search")) return <Search size={15} />;
	if (key.includes("glob") || key.includes("list") || key.includes("ls")) return <Folder size={15} />;
	if (key.includes("task") || key.includes("subagent") || key.includes("agent")) return <Network size={15} />;
	if (key.includes("web") || key.includes("fetch")) return <Globe2 size={15} />;
	if (key.includes("todo")) return <ListTodo size={15} />;
	return <Wrench size={15} />;
}
/** 从工具消息 meta 中提取副标题（文件路径或命令），让 trigger 行能体现工具作用对象。
 *  pi 的工具参数可能是对象，也可能已被主进程截断/序列化为 JSON 字符串；两种格式都要兼容，否则 bash 命令摘要会丢失。 */
function getToolSubtitle(message: ChatMessage): string {
	const meta = message.meta;
	if (!meta) return "";
	// 优先从 args 取参数（pi 工具事件的标准结构）
	const args = parseToolArgs(meta.args);
	if (args) {
		for (const key of [
			// 文件操作类
			"filePath", "file_path", "path", "file",
			// bash/shell 命令
			"command",
			// 搜索/查询类（grep、web_search 等）
			"pattern", "query", "queries",
			// 网络获取类（fetch_content 等）
			"url", "urls",
			// 待办事项类（todo 等）
			"action", "text",
		]) {
			const v = args[key];
			if (typeof v === "string" && v) return v;
			// queries 和 urls 是数组，取第一条
			if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
		}
	}
	// 兼容历史平铺写法
	const path = meta.path;
	if (typeof path === "string" && path) return path;
	const command = meta.command;
	if (typeof command === "string" && command) return command;
	const file = meta.file;
	if (typeof file === "string" && file) return file;
	// 兜底：取 args 中第一个非空字符串值
	if (args && typeof args === "object") {
		for (const val of Object.values(args as Record<string, unknown>)) {
			if (typeof val === "string" && val) return val;
		}
	}
	return "";
}
function getToolArgFilePath(args: Record<string, unknown> | undefined): string | undefined {
	return getToolFilePath(args);
}
function getToolDiffTarget(message: ChatMessage): { path: string; originalContent: string; content: string; changedLines: number } | undefined {
	const toolName = getToolName(message);
	if (!/write|edit|create|patch/i.test(toolName)) return undefined;
	const args = parseToolArgs(message.meta?.args);
	const path = getToolArgFilePath(args);
	if (!args || !path) return undefined;
	if (/write|create/i.test(toolName)) {
		const content = typeof args.content === "string"
			? args.content
			: typeof args.text === "string"
				? args.text
				: undefined;
		if (content === undefined) return undefined;
		return { path, originalContent: "", content, changedLines: countTextLines(content) };
	}
	// edit/patch：不存储 full file originalContent，只展示变动区域
	const diff = getToolEditDiff(args);
	if (!diff) return undefined;
	return {
		path,
		originalContent: diff.oldText,
		content: diff.newText,
		changedLines: Math.max(countTextLines(diff.oldText), countTextLines(diff.newText)),
	};
}
/**
 * 识别模型主动触发的 skill：pi 系统提示会指示 LLM 用 read 工具读取 SKILL.md 来加载 skill，
 * 所以 toolName==="read" 且 path 以 SKILL.md 结尾时，视为 skill 调用，返回 skill 名（父目录名）。
 * 这是模型侧的 skill 触发，与用户侧 /skill:name 展开成 <skill> 块不同。
 */
function getReadSkillName(message: ChatMessage): string | undefined {
	const meta = message.meta;
	if (!meta) return;
	const toolName = typeof meta.toolName === "string" ? meta.toolName : "";
	if (toolName.toLowerCase() !== "read") return;
	const args = meta.args as Record<string, unknown> | undefined;
	if (!args || typeof args !== "object") return;
	const rawPath = String(args.path ?? args.filePath ?? args.file_path ?? "");
	if (!rawPath) return;
	// 取最后一段文件名与父目录名，跨平台分隔符兼容
	const segs = rawPath.split(/[\\/]/).filter(Boolean);
	const fileName = segs[segs.length - 1] ?? "";
	if (fileName.toUpperCase() !== "SKILL.MD") return;
	return segs[segs.length - 2] ?? fileName;
}
/** 计算工具的语气色：running 黄、error 红、非零退出 warning、其余 ok。 */
function getToolTone(message: ChatMessage): "running" | "error" | "warning" | "ok" {
	const status = getToolStatus(message);
	const exitCode = getToolExitCode(message);
	if (status === "running") return "running";
	if (status === "error" || message.meta?.isError === true) return "error";
	if (typeof exitCode === "number" && exitCode !== 0) return "warning";
	return "ok";
}
/** pi 内置工具名集合，用于与 MCP / 扩展工具区分。 */
const BUILT_IN_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
/**
 * 扩展工具中带下划线的名称，会被 MCP-direct 正则误匹配为形如 {server}_{tool}。
 * 在此登记后 getToolKind 将其归为 "extension" 而非 "mcp-direct"。
 */
const NON_MCP_TOOLS = new Set(["ask_question"]);
/**
 * 识别工具来源类型：
 * - mcp-proxy：toolName 为 mcp（pi-mcp-adapter 代理模式，LLM 通过单一 mcp 工具调用具体 server/tool）
 * - mcp-direct：toolName 形如 {server}_{tool} 且非内置/非扩展工具（directTools 模式，server 名去掉 -mcp 后缀）
 * - builtin：pi 内置工具（bash/edit/find/grep/ls/read/write）
 * - extension：扩展工具或自定义命名的其他工具
 */
function getToolKind(toolName: string): "mcp-proxy" | "mcp-direct" | "builtin" | "extension" {
	const key = toolName.toLowerCase();
	if (key === "mcp") return "mcp-proxy";
	if (BUILT_IN_TOOLS.has(key)) return "builtin";
	// directTools 模式：server_tool，server 名通常含字母/连字符，tool 名也是标识符
	if (/^[a-z][a-z0-9-]*_[a-z][a-z0-9_-]*$/i.test(toolName)) {
		// 已知扩展工具名含下划线但不是 MCP 直连 → 归为 extension
		if (NON_MCP_TOOLS.has(key)) return "extension";
		return "mcp-direct";
	}
	return "extension";
}
/** 从 MCP direct 工具名中拆出 server 名（chrome_devtools_navigate → chrome）。 */
function getMcpServerName(toolName: string): string {
	const idx = toolName.indexOf("_");
	return idx > 0 ? toolName.slice(0, idx) : toolName;
}
/** 给工具返回展示标签：MCP 代理/直连/内置/扩展，用于 ToolCard trigger 的 kind 徽标。 */
function getToolKindLabel(toolName: string): string {
	const kind = getToolKind(toolName);
	if (kind === "mcp-proxy") return "MCP";
	if (kind === "mcp-direct") return `MCP·${getMcpServerName(toolName)}`;
	return "";
}
/** 识别 todo 写入类工具（兼容 omp 原生 "todo" 及 TodoWrite/todo_write 命名变体）。 */
const isTodoWrite = isTodoWriteToolName;
/**
 * 从工具消息 meta 解析 todo 列表。
 * 优先 omp 的结构化快照（meta.details.phases），回退 TodoWrite 风格入参（meta.args.todos）。
 * 实现见 shared/todo.ts，主进程与渲染层共用同一套归一化逻辑。
 */

/**
 * 计算 todo 列表的进度摘要：已完成数/总数 + 当前 in_progress 项的摘要文本。
 * 返回 { done, total, currentText }，currentText 优先用 activeForm，fallback 到 content 截断。
 */
function summarizeTodoProgress(items: TodoItem[]): { done: number; total: number; currentText: string } {
	const total = items.length;
	const done = items.filter((i) => i.status === "completed").length;
	const inProgress = items.find((i) => i.status === "in_progress");
	const currentText = inProgress
		? (inProgress.activeForm || inProgress.content).slice(0, 40)
		: "";
	return { done, total, currentText };
}
/** 渲染 TodoWrite 展开态清单的单行：三态图标 + content，in_progress 加粗。 */
function renderTodoLine(item: TodoItem, key: React.Key): ReactNode {	const icon =
		item.status === "completed" ? (
			// Check 图形瘦窄（占 SVG 约 2/3 宽），放大并配合固定槽位居中，
			// 使"图形右缘→文字"间距与 Circle/CircleDot 一致。
			<Check size={15} strokeWidth={2.6} className="todo-line-icon todo-line-icon--done" aria-label={t("todo.statusCompleted")} />
		) : item.status === "in_progress" ? (
			<CircleDot size={13} strokeWidth={2.2} className="todo-line-icon todo-line-icon--active" aria-label={t("todo.statusInProgress")} />
		) : (
			<Circle size={13} strokeWidth={1.8} className="todo-line-icon todo-line-icon--pending" aria-label={t("todo.statusPending")} />
		);
	return (
		<li
			key={key}
			className={`todo-write-line todo-write-line--${item.status}`}
			title={item.content}
		>
			<span className="todo-write-line-icon" aria-hidden="true">{icon}</span>
			<span className="todo-write-line-text">{item.content}</span>
		</li>
	);
}
/**
 * 渲染 todo 列表（保持 phase 分组顺序）。
 * omp 的 todo 快照带 phase 分组；分组标题不再展示（用户要求精简），
 * 任务行按原分组顺序平铺，无 phase 的项（TodoWrite 风格）同样直接平铺。
 */
function renderTodoGroups(items: TodoItem[]): ReactNode[] {
	return items.map((item, idx) => renderTodoLine(item, String(idx)));
}
/** 单个工具调用卡片：trigger 行（图标+工具名+副标题+状态+耗时）+ 展开后详情。 */
/** 格式化 ask 答案展示：长文本可换行，避免 fixed height 下覆盖错位 */
function formatAskAnswerText(answer: unknown, answerLabel?: string): string {
	if (typeof answerLabel === "string" && answerLabel.trim()) return answerLabel;
	if (typeof answer === "boolean") return answer ? t("common.true") : t("common.false");
	if (answer == null) return t("ask.answered");
	return String(answer);
}
function getToolStatus(message: ChatMessage): "running" | "done" | "error" {
	const status = String(message.meta?.status ?? "done");
	if (status === "running" || status === "error") return status;
	return "done";
}
function getToolName(message: ChatMessage) {
	const name = message.meta?.toolName;
	if (typeof name === "string" && name.trim()) return name.trim();
	const text = stripAnsi(message.text).replace(/^[▶✓✗]\s*/u, "").trim();
	return text || "tool";
}
function getToolDetailText(message: ChatMessage) {
	if (typeof message.meta?.detailText === "string") {
		return stripAnsi(message.meta.detailText);
	}
	return stripAnsi(JSON.stringify(message.meta ?? {}, null, 2));
}
function getToolExitCode(message: ChatMessage) {
	const result = message.meta?.result;
	if (!result || typeof result !== "object") return undefined;
	const value = (result as { exitCode?: unknown }).exitCode;
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}
export const ToolCard = memo(function ToolCard(props: {
	message: ChatMessage;
	defaultOpen?: boolean;
	onDiffFile?: DiffFileHandler;
}) {
	const toolName = getToolName(props.message);
	// TodoWrite 默认展开：todo 列表是执行进度的主视图，折叠态只留一行进度摘要不够直观；
	// 其它工具保持默认折叠，避免消息流被工具详情占满。
	const [expanded, setExpanded] = useState(
		() => props.defaultOpen ?? isTodoWriteToolName(toolName),
	);
	const status = getToolStatus(props.message);
	const detailText = getToolDetailText(props.message);
	const tone = getToolTone(props.message);
	const kindLabel = getToolKindLabel(toolName);
	const diffTarget = getToolDiffTarget(props.message);
	// TodoWrite 特化：从 meta 解析 todos（omp details.phases 快照优先），派生进度摘要并隐藏无意义的耗时
	const isTodoWrite = isTodoWriteToolName(toolName);
	const todoItems = isTodoWrite ? extractTodoItems(props.message.meta) : [];
	const todoSummary = isTodoWrite ? summarizeTodoProgress(todoItems) : null;
	// 折叠态 subtitle：TodoWrite 用进度摘要（{done}/{total} · activeForm），其它工具走原 subtitle
	const subtitle = isTodoWrite && todoSummary
		? (todoSummary.total > 0
			? `${todoSummary.done}/${todoSummary.total}${todoSummary.currentText ? " · " + todoSummary.currentText : ""}`
			: "")
		: getToolSubtitle(props.message);
	const durationMs =
		typeof props.message.meta?.durationMs === "number"
			? props.message.meta.durationMs
			: undefined;
	// TodoWrite 是瞬时记账操作，耗时对用户无信息量，隐藏；其它工具 status 非running 时显示
	const showDuration = !isTodoWrite && status !== "running" && durationMs !== undefined;
	// 模型用 read 工具读取 SKILL.md 来加载 skill：识别后以 skill 徽标样式渲染
	const skillName = getReadSkillName(props.message);
	const isSkillRead = Boolean(skillName);
	// 历史/实时会话中从 ask_question 工具结果反推的提问卡片数据
	// items 存在时为批量问卷：逐题展示答案，避免只显示第一题像「未回答」
	const askCard = props.message.meta?._askCard as
		| {
				question?: string;
				type?: string;
				answered?: boolean;
				answer?: unknown;
				answerLabel?: string;
				options?: unknown[];
				cancelled?: boolean;
				items?: Array<{
					id?: string;
					question?: string;
					type?: string;
					answered?: boolean;
					answer?: unknown;
					answerLabel?: string;
					options?: unknown[];
					wasCustom?: boolean;
				}>;
		  }
		| undefined;
	const isAskCard = Boolean(askCard?.question) || Boolean(askCard?.items?.length);
	// 运行中显示 "运行中"，出错显示 "错误"，完成后不显示状态文本
const statusLabel =
	status === "running"
		? t("tool.statusRunning")
		: status === "error"
			? ""
			: "";
	const [copied, setCopied] = useState(false);
	const handleCopy = () => {
		// 全文加载后复制全文，否则复制截断的 detailText
		writeClipboard(displayText);
		setCopied(true);
		showNotice(t("app.codeCopied"), 1200);
		setTimeout(() => setCopied(false), 2000);
	};
	// 「查看完整输出」：detailText 被截断（meta.truncated）时按需经 IPC 拉取全文；
	// 内存缓存优先，历史会话回退按 entryId 读文件。展开后展示全文并让复制按钮复制全文。
	const isTruncated = props.message.meta?.truncated === true;
	const [fullText, setFullText] = useState<string | null>(null);
	const [fullTextLoading, setFullTextLoading] = useState(false);
	const [fullTextError, setFullTextError] = useState(false);
	const displayText = fullText ?? detailText;
	const loadFullText = async () => {
		if (fullText !== null || fullTextLoading) return;
		setFullTextLoading(true);
		setFullTextError(false);
		try {
			const api = (window as unknown as {
				piDesktop?: { sessions?: { readMessageFullText?: (agentId: string, messageId: string, entryId?: string) => Promise<{ text: string }> } };
			}).piDesktop;
			const agentId = props.message.agentId;
			const entryId = props.message.meta?.entryId as string | undefined;
			if (!api?.sessions?.readMessageFullText || !agentId) {
				throw new Error("full-text unavailable");
			}
			const { text } = await api.sessions.readMessageFullText(agentId, props.message.id, entryId);
			setFullText(text);
		} catch {
			setFullTextError(true);
		} finally {
			setFullTextLoading(false);
		}
	};
	return (
		<section
			className={`tool-card tone-${tone}${isSkillRead ? " tool-card--skill" : ""}${isAskCard ? " tool-card--ask" : ""}`}
			data-status={status}
			data-tool-kind={isSkillRead ? "skill" : getToolKind(toolName)}
			data-message-id={props.message.id}
		>
			<div className={`tool-card-header${diffTarget ? " has-diff" : ""}`}>
				<button
					className="tool-card-trigger"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
				>
					<span className="tool-card-icon">
						{isSkillRead ? <Brain size={15} /> : isAskCard ? <MessageCircle size={15} /> : toolIcon(toolName)}
					</span>
					<span className="tool-card-name">
						{isSkillRead ? `skill:${skillName}` : isAskCard ? t("ask.toolName") : toolName}
					</span>
					<ChevronDown
						size={14}
						className={`tool-card-chevron${expanded ? " open" : ""}`}
					/>
					{!isSkillRead && kindLabel && (
						<span className="tool-card-kind">{kindLabel}</span>
					)}
					<span className="tool-card-status">
						{status === "running" && <span className="tool-card-spinner" aria-hidden="true" />}
						{askCard?.answered ? t("ask.answered") : (statusLabel)}
					</span>
					{showDuration && (
						<span className="tool-card-duration" title={t("tool.durationTitle")}>
							{formatDuration(durationMs)}
						</span>
					)}
					{isAskCard && askCard ? (
						<span
							className="tool-card-subtitle"
							title={
								Array.isArray(askCard.items) && askCard.items.length > 0
									? t("ask.batchTitle", { count: String(askCard.items.length) })
									: (askCard.question ?? "")
							}
						>
							|{" "}
							{Array.isArray(askCard.items) && askCard.items.length > 0
								? t("ask.batchTitle", { count: String(askCard.items.length) })
								: askCard.question}
						</span>
					) : subtitle ? (
						<span className="tool-card-subtitle" title={subtitle}>
							| {subtitle}
						</span>
					) : null}
				</button>
				{diffTarget && props.onDiffFile && (
					<button
						className="tool-card-diff-chip"
						type="button"
						onClick={() => props.onDiffFile?.(diffTarget.path, diffTarget.originalContent, diffTarget.content)}
						title={`${t("tool.viewDiff")} · ${diffTarget.path}`}
					>
						{t("tool.diff")}
					</button>
				)}
			</div>
			{expanded && (
				<div className="tool-card-content">
					{isAskCard && askCard ? (
						<div className="ask-question-card-tool-inner">
							{/*
							 * 单问 / 批量统一成 Q→A 行卡。
							 * 业务规则：批量 items 优先；单问（select/confirm/input/editor）
							 * 也走同一布局，避免会话里两套视觉语言。
							 */}
							{(() => {
								const rows =
									Array.isArray(askCard.items) && askCard.items.length > 0
										? askCard.items.map((item, idx) => ({
												key: item.id ?? String(idx),
												num: idx + 1,
												question: item.question || item.id,
												answered: Boolean(item.answered),
												answerText: formatAskAnswerText(item.answer, item.answerLabel),
										  }))
										: [
												{
													key: "single",
													num: 1,
													question: askCard.question ?? "",
													answered: Boolean(askCard.answered),
													answerText: formatAskAnswerText(
														askCard.answer,
														askCard.answerLabel,
													),
												},
										  ];
								const isSingleSelect =
									!(Array.isArray(askCard.items) && askCard.items.length > 0) &&
									Array.isArray(askCard.options) &&
									askCard.options.length > 0;

								return (
									<>
										<div className="ask-question-card-batch-list">
											{rows.map((row) => (
												<div key={row.key} className="ask-question-card-batch-item">
													<span className="ask-question-card-batch-num" aria-hidden="true">
														{row.num}
													</span>
													<div className="ask-question-card-batch-row">
														<span
															className="ask-question-card-batch-q"
															title={row.question}
														>
															{row.question}
														</span>
														<span className="ask-question-card-batch-sep" aria-hidden="true">
															→
														</span>
														{row.answered ? (
															<span
																className="ask-question-card-batch-a"
																title={row.answerText}
															>
																{row.answerText}
															</span>
														) : (
															<span className="ask-question-card-batch-a ask-question-card-batch-a--muted">
																{askCard.cancelled
																	? t("ask.cancelled")
																	: t("ask.unanswered")}
															</span>
														)}
													</div>
												</div>
											))}
										</div>
										{/* 单问 select：折叠展示备选项，选中项轻量高亮，便于回看完整上下文 */}
										{isSingleSelect && (
											<div className="ask-question-card-options-list ask-question-card-options-list--compact">
												{askCard.options!.map((opt, i) => {
													const optLabel =
														typeof opt === "string"
															? opt
															: ((opt as { label?: string }).label ??
																String((opt as { value?: unknown }).value ?? ""));
													const optValue =
														typeof opt === "string"
															? opt
															: String(
																	(opt as { value?: unknown }).value ?? optLabel,
															  );
													const desc =
														typeof opt === "object" && opt
															? (opt as { description?: string }).description
															: undefined;
													const isSelected =
														Boolean(askCard.answered) &&
														(optLabel === askCard.answerLabel ||
															optValue === askCard.answer);
													return (
														<div
															key={i}
															className={`ask-question-card-option-item${isSelected ? " selected" : ""}`}
														>
															<span className="ask-question-card-option-selector" aria-hidden="true">
																{isSelected ? <Check size={12} strokeWidth={2.4} /> : null}
															</span>
															<div className="ask-question-card-option-text">
																<span className="ask-question-card-option-label">{optLabel}</span>
																{desc ? (
																	<span className="ask-question-card-option-desc">{desc}</span>
																) : null}
															</div>
														</div>
													);
												})}
											</div>
										)}
									</>
								);
							})()}
						</div>
					) : isTodoWrite && todoItems.length > 0 ? (
						<ol className="todo-write-list">
							{renderTodoGroups(todoItems)}
						</ol>
					) : (
						<pre className="tool-card-detail">{displayText}</pre>
					)}
					{isTruncated && (
						<button
							className="tool-card-full-text"
							onClick={loadFullText}
							disabled={fullTextLoading}
							title={t("tool.showFullOutput")}
						>
							{fullTextLoading
								? t("tool.loadingFullOutput")
								: fullTextError
									? t("tool.fullOutputFailed")
									: fullText !== null
										? t("tool.fullOutputLoaded")
										: t("tool.showFullOutput")}
						</button>
					)}
					<button
						className="tool-card-copy"
						onClick={handleCopy}
						title={t("tool.copyDetail")}
					>
						{copied ? <Check size={14} /> : <Copy size={14} />}
					</button>
				</div>
			)}
		</section>
	);
});
/** 工具组直接平铺为工具列表；每个 ToolCard 自己默认折叠，避免外层再占一行。 */
export const ToolGroupCard = memo(function ToolGroupCard(props: {
	group: ToolGroupItem;
	onDiffFile?: DiffFileHandler;
}) {
	return (
		<section className="tool-group-card flat" data-message-id={props.group.id}>
			<div className="tool-group-card-list">
				{props.group.messages.map((message) => (
					<ToolCard key={message.id} message={message} onDiffFile={props.onDiffFile} />
				))}
			</div>
		</section>
	);
});
