import { memo } from "react";
import { Wrench } from "lucide-react";
import type { ChatMessage, ImageContent } from "../../../../shared/types";
import { t } from "../../i18n";
import {
	sameRenderMessageListForRender,
	type RenderMessage,
} from "./AppUtils";
import {
	AskQuestionCard,
	CompactionCard,
	DiagnosticMessageCard,
	RespondingIndicator,
	ThinkingBlock,
	TurnRow,
	UserBubble,
} from "./AppParts";

type AskResponse = {
	value?: string | boolean | null;
	cancelled?: boolean;
	confirmed?: boolean;
};

/** 流式/运行中的时间线展示状态。App 侧用 useMemo 组装（依赖全部输入 state），
 *  比较器按内容比较（sameMessageStreamState），任一字段变化都能触发重渲染。 */
export type MessageStreamState = {
	/** 正在流式追加的最后一条 assistant 消息 id（见 App.streamingMessageId） */
	streamingMessageId?: string;
	/** Agent 处理中（含多步工具调用之间的短暂间隙，驱动 TurnRow 折叠行为） */
	agentRunning: boolean;
	/** 精确的 activeAgent.status === "running"，驱动响应指示器（与 agentRunning 语义不同） */
	statusRunning: boolean;
	/** 等待首条 assistant 消息时的占位/指示器显示条件 */
	isAwaitingAssistant: boolean;
	showThinking: boolean;
	activeThinking?: string;
	/** 流式思考的开始时间（App 侧 streamingThinkingStartedAt[agentId]，首次 thinking 到达时记录）；
	 *  消息落库后以 message.thinkingStartedAt 为准（见 TurnRow 双来源优先级） */
	thinkingStartedAt?: number;
	isExecutingTool?: boolean;
	isStreaming?: boolean;
	/** 正在取消 ask 响应（发送 cancelled 期间），隐藏响应指示器 */
	cancellingUi: boolean;
	/** 正在用 composer 内联栏回答同一 request 时隐藏时间线 pending 卡 */
	activeUiAskRequestId?: string;
};

/** MessageStreamState 的内容相等比较：字段全是原始值，逐项 Object.is 比较即可。
 *  相比引用比较更保守——即使 App 侧 useMemo 依赖漏列某个输入，
 *  这里仍能捕获其变化触发重渲染（代价与原先 10 个标量 prop 的逐一比较一致）。 */
function sameMessageStreamState(previous: MessageStreamState, next: MessageStreamState): boolean {
	return (
		previous.streamingMessageId === next.streamingMessageId &&
		previous.agentRunning === next.agentRunning &&
		previous.statusRunning === next.statusRunning &&
		previous.isAwaitingAssistant === next.isAwaitingAssistant &&
		previous.showThinking === next.showThinking &&
		previous.activeThinking === next.activeThinking &&
		previous.thinkingStartedAt === next.thinkingStartedAt &&
		previous.isExecutingTool === next.isExecutingTool &&
		previous.isStreaming === next.isStreaming &&
		previous.cancellingUi === next.cancellingUi &&
		previous.activeUiAskRequestId === next.activeUiAskRequestId
	);
}

export type MessageListContentProps = {
	renderedRuns: RenderMessage[];
	/** 流式/运行展示状态（App 侧 useMemo 组装，比较器按内容比较） */
	streamState: MessageStreamState;
	activeAgentId?: string;
	forkingMessageId?: string | null;
	/** Set 引用稳定（App 内 useMemo），比较器按引用比较 */
	validCommandNames: Set<string>;
	validFilePaths: Set<string>;
	// ── 回调（memo 比较器忽略；App 侧尽量 useCallback 稳定，减少 GC 压力）──
	onPreviewImage: (image: ImageContent) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: (path: string, originalContent?: string, content?: string) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	onForkMessage?: (message: ChatMessage) => void;
	onEnterMultiSelect?: () => void;
	onOpenExternal: (url: string) => void;
	onRespondAsk: (requestId: string, response: AskResponse) => void;
};

/**
 * 消息时间线主体（message-list 内容）。从巨型 App() 中抽出并 memo：
 * 流式期间每 50ms 只有最后一条 assistant 消息的内容变化，App 其余部分
 * （侧栏/抽屉/输入框/头部）不应随之整树重渲染。
 *
 * 比较器按内容比较 renderedRuns（同 groupToolMessages 的 sameAgentRunForRender 语义），
 * 只有真正变化的 run 会重渲染；回调类 prop 一律忽略。
 */
export const MessageListContent = memo(
	function MessageListContent(props: MessageListContentProps) {
		const {
			renderedRuns,
			streamState,
			forkingMessageId,
			validCommandNames,
			validFilePaths,
			onPreviewImage,
			onOpenFile,
			onDiffFile,
			onEditMessage,
			onDeleteMessage,
			onForkMessage,
			onEnterMultiSelect,
			onOpenExternal,
			onRespondAsk,
		} = props;
		const {
			streamingMessageId,
			agentRunning,
			statusRunning,
			isAwaitingAssistant,
			showThinking,
			activeThinking,
			thinkingStartedAt,
			isExecutingTool,
			isStreaming,
			cancellingUi,
			activeUiAskRequestId,
		} = streamState;

		return (
			<div className="message-list">
				{/* 使用 groupToolMessages 渲染：user/error/system 独立条目，
				    assistant + tool 聚合为 agnet-run（TurnRow 自带操作栏） */}
				{renderedRuns.map((item, index) => {
					if (item.kind === "agent-run") {
						// 判断该 run 是否包含正在流式的消息
						const isRunStreaming = Boolean(
							streamingMessageId &&
							item.items.some(
								(i) => i.kind === "message" && i.message.id === streamingMessageId,
							),
						);
						return (
							<TurnRow
								key={item.id}
								run={item}
								onPreviewImage={onPreviewImage}
								showThinking={showThinking}
								isStreaming={isRunStreaming}
								streamingThinkingStartedAt={thinkingStartedAt}
								agentRunning={agentRunning && index === renderedRuns.length - 1}
								onOpenExternal={onOpenExternal}
								onOpenFile={onOpenFile}
								onDiffFile={onDiffFile}
								onEditMessage={onEditMessage}
								onDeleteMessage={onDeleteMessage}
								onEnterMultiSelect={onEnterMultiSelect}
							/>
						);
					}
					// 独立消息条目：user / error / system
					// 理论上顶层的 thinking-group / tool-group 不会穿透到此（
					// 它们总是被聚合进 agent-run），但 TypeScript 需要穷举
					if (item.kind !== "message") return null;
					const message = item.message;
					if (message.role === "user") {
						return (
							<UserBubble
								key={message.id}
								message={message}
								onPreviewImage={onPreviewImage}
								onOpenFile={onOpenFile}
								onEditMessage={onEditMessage}
								onDeleteMessage={onDeleteMessage}
								onForkMessage={onForkMessage}
								agentRunning={agentRunning}
								forking={forkingMessageId === message.id}
								validCommandNames={validCommandNames}
								validFilePaths={validFilePaths}
								onEnterMultiSelect={onEnterMultiSelect}
							/>
						);
					}
					if (message.role === "error") {
						return (
							<DiagnosticMessageCard key={message.id} message={message} />
						);
					}
					if (message.role === "system") {
						const meta = message.meta as Record<string, unknown> | undefined;
						if (meta?.type === "askQuestion") {
							// 正在用 composer 内联栏回答同一 request 时，隐藏时间线 pending 卡，避免双份 UI。
							// 已回答/取消的卡由 AskQuestionCard 内部 return null，最终结果看 ToolCard。
							const req = meta.uiRequest as { requestId?: string } | undefined;
							const isActivePending =
								meta.status === "pending" &&
								Boolean(req?.requestId) &&
								Boolean(activeUiAskRequestId) &&
								req?.requestId === activeUiAskRequestId;
							if (isActivePending) return null;
							return (
								<AskQuestionCard
									key={message.id}
									message={message}
									onRespond={(response) => {
										if (req?.requestId) onRespondAsk(req.requestId, response);
									}}
								/>
							);
						}
						if (meta?.type === "compaction") {
							return (
								<CompactionCard key={message.id} message={message} />
							);
						}
						return (
							<DiagnosticMessageCard key={message.id} message={message} />
						);
					}
					return null;
				})}
				{isAwaitingAssistant && (
					<>
						{showThinking && activeThinking && (
							<ThinkingBlock
								text={activeThinking}
								startedAt={thinkingStartedAt}
								showThinking={showThinking}
							/>
						)}
						{/* 工具执行中但消息尚未到达时，显示临时占位卡片，避免状态指示器亮了但页面空白。
						    runtimeState 在工具消息到达前就已更新 isExecutingTool，存在时序间隙。 */}
						{isExecutingTool &&
							!renderedRuns.some(r =>
								r.kind === "agent-run" &&
								r.items.some(i => i.kind === "tool-group"),
							) && (
							<section className="tool-card tone-info" data-status="running">
								<div className="tool-card-header">
									<span className="tool-card-trigger">
										<span className="tool-card-icon">
											<Wrench size={14} />
										</span>
										<span className="tool-card-name">{t("tool.pending")}</span>
										<span className="tool-card-status">
											<span className="tool-card-spinner" aria-hidden="true" />
											{t("tool.statusRunning")}
										</span>
									</span>
								</div>
							</section>
						)}
					</>
				)}
				{/* 响应指示器：agent 运行或流式期间显示三点动画 */}
				{!cancellingUi && (statusRunning || isStreaming) && (
					<RespondingIndicator
						thinking={activeThinking}
						showThinking={showThinking}
						isExecutingTool={isExecutingTool}
						isStreaming={isStreaming}
					/>
				)}
			</div>
		);
	},
	(previous, next) =>
		// 廉价标量比较在前、深比较殿后：App 每次重渲染（含 thinking tick、
		// 侧栏状态变化）都会跑比较器，标量不匹配时直接短路，省掉 O(runs) 深遍历。
		// streamState 由 App 侧 useMemo 组装，这里按内容比较（见 sameMessageStreamState），
		// 任一流式字段变化（含 thinkingStartedAt/activeThinking 等可能与 renderedRuns
		// 不同步变化的字段）都能触发重渲染，行为与合并前的 10 个标量 prop 一致。
		sameMessageStreamState(previous.streamState, next.streamState) &&
		previous.activeAgentId === next.activeAgentId &&
		previous.forkingMessageId === next.forkingMessageId &&
		previous.validCommandNames === next.validCommandNames &&
		previous.validFilePaths === next.validFilePaths &&
		sameRenderMessageListForRender(previous.renderedRuns, next.renderedRuns),
);
