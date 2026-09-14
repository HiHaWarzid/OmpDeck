/** 诊断与压缩卡片：压缩摘要、诊断提示及其归档消息展开。 */
import { memo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { t, type TranslationKey } from "../../../i18n";
import type { ChatMessage } from "../../../../../shared/types";
import { formatTime, stripAnsi } from "../format";

function getDiagnosticTone(message: ChatMessage): "error" | "warning" | "success" | "info" {
	if (message.role === "error") return "error";
	const status = String(message.meta?.status ?? "");
	if (status === "error") return "error";
	if (status === "running") return "warning";
	if (status === "success") return "success";
	return "info";
}
/** 压缩事件卡片：在时间线上标记会话被压缩过，展示摘要和节约的 token 数。
 * 支持展开查看压缩前的归档消息。 */
export const CompactionCard = memo(function CompactionCard(props: {
	message: ChatMessage;
}) {
	const [expanded, setExpanded] = useState(false);
	const summary = props.message.text;
	const tokensBefore = (props.message.meta as any)?.tokensBefore;
	const compactionCount = (props.message.meta as any)?.compactionCount;
	const archivedMessages = (props.message.meta as any)?.archivedMessages as ChatMessage[] | undefined;
	const time = formatTime(props.message.timestamp);
	const hasArchived = Array.isArray(archivedMessages) && archivedMessages.length > 0;

	return (
		<article
			className={`compaction-card${expanded ? " compaction-card--expanded" : ""}`}
			data-message-id={props.message.id}
		>
			<button
				type="button"
				className="compaction-card-header"
				onClick={() => hasArchived && setExpanded(!expanded)}
				disabled={!hasArchived}
				aria-expanded={expanded}
			>
				<span className="compaction-card-icon" aria-hidden="true">
					{hasArchived ? (expanded ? "📂" : "📁") : "🔁"}
				</span>
				<div className="compaction-card-body">
					<span className="compaction-card-summary">{stripAnsi(summary)}</span>
					<div className="compaction-card-meta">
						{typeof compactionCount === "number" && compactionCount > 0 && (
							<span className="compaction-card-count">
								{t("app.compactionCount", { count: compactionCount })}
							</span>
						)}
						{typeof tokensBefore === "number" && (
							<span className="compaction-card-tokens">
								~{Math.round(tokensBefore / 1000)}k tokens before
							</span>
						)}
						{hasArchived && (
							<span className="compaction-card-hint">
								{expanded ? t("app.compactionCollapse") : t("app.compactionExpand")}
							</span>
						)}
					</div>
					<time className="compaction-card-time">{time}</time>
				</div>
			</button>
			{expanded && hasArchived && (
				<div className="compaction-card-archive">
					<div className="compaction-card-archive-divider" />
					<ArchivedMessageList messages={archivedMessages} />
				</div>
			)}
		</article>
	);
});
/** 归档消息列表：压缩卡片展开时，以简略格式渲染压缩前的消息历史。 */
function ArchivedMessageList({ messages }: { messages: ChatMessage[] }) {
	return (
		<div className="archived-message-list">
			{messages.map((msg) => (
				<ArchivedMessage key={msg.id} message={msg} />
			))}
		</div>
	);
}
/** 单条归档消息：根据角色显示对应的图标和内容预览。
 * 只展示纯文本内容，不渲染 Markdown / 代码高亮 / 工具详情，保持归档区视觉干净。 */
function ArchivedMessage({ message }: { message: ChatMessage }) {
	const text = stripAnsi(message.text).trim();
	// 截断过长的消息以减少展开区体积
	const preview = text.length > 300 ? text.slice(0, 300) + "…" : text;
	const roleIcon =
		message.role === "user" ? "👤" :
		message.role === "assistant" ? "🤖" :
		message.role === "tool" ? "🔧" : "💬";

	return (
		<div className={`archived-message archived-message--${message.role}`}>
			<span className="archived-message-role">{roleIcon}</span>
			<span className="archived-message-text">{preview || "(empty)"}</span>
		</div>
	);
}
/** 错误/RPC/系统诊断消息使用独立卡片，避免和普通 AI 正文混在一起难以扫读。 */
export const DiagnosticMessageCard = memo(function DiagnosticMessageCard(props: {
	message: ChatMessage;
}) {
	const tone = getDiagnosticTone(props.message);
	const title = props.message.role === "error"
		? t("diagnostic.errorTitle")
		: t("diagnostic.systemTitle");
	return (
		<article
			className={`diagnostic-card tone-${tone}`}
			data-message-id={props.message.id}
			data-role={props.message.role}
		>
			<div className="diagnostic-card-header">
				<AlertTriangle size={14} aria-hidden="true" />
				<span>{title}</span>
				<time>{formatTime(props.message.timestamp)}</time>
			</div>
			<pre className="diagnostic-card-body">{stripAnsi(
				props.message.meta && typeof props.message.meta === "object" && "i18nKey" in props.message.meta
					? t((props.message.meta as Record<string, string>).i18nKey as TranslationKey)
					: props.message.text
			)}</pre>
		</article>
	);
});
