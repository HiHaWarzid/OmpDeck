/** 诊断与压缩卡片：压缩摘要、诊断提示及其归档消息展开。 */
import { memo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { t, type TranslationKey } from "../../../i18n";
import type { ChatMessage } from "../../../../../shared/types";
import { Button } from "../../ui/Button";
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
 * 展开时展示压缩前的归档消息：文件直读路径（查看器）把归档挂在 meta 上，实时会话只带
 * compactionId + 条数，展开瞬间按需经 IPC 取回（归档可达整个压缩前历史，MB 级）。 */
export const CompactionCard = memo(function CompactionCard(props: {
	message: ChatMessage;
}) {
	const [expanded, setExpanded] = useState(false);
	const summary = props.message.text;
	// meta 在共享类型里就是 Record<string, unknown>：逐字段做 typeof 收窄，不做断言。
	const meta = props.message.meta ?? {};
	const tokensBefore = typeof meta.tokensBefore === "number" ? meta.tokensBefore : undefined;
	const compactionCount = typeof meta.compactionCount === "number" ? meta.compactionCount : undefined;
	const compactionId = typeof meta.compactionId === "string" ? meta.compactionId : undefined;
	const archivedMessageCount = typeof meta.archivedMessageCount === "number" ? meta.archivedMessageCount : 0;
	const inlineArchived = Array.isArray(meta.archivedMessages)
		? meta.archivedMessages.filter((item): item is ChatMessage => !!item && typeof item === "object")
		: undefined;
	const [fetchedArchived, setFetchedArchived] = useState<ChatMessage[] | undefined>(undefined);
	const [loadingArchive, setLoadingArchive] = useState(false);
	const [archiveFailed, setArchiveFailed] = useState(false);
	const archived = inlineArchived ?? fetchedArchived;
	// 展开资格只由「主进程给的归档索引 / 内联归档」决定，不用已到手的结果反推：
	// 否则读取到 0 条（索引与实际不一致）会把已展开的区域整块收掉，看起来像点击无效。
	const archiveIndexed = (inlineArchived?.length ?? archivedMessageCount) > 0;
	const canExpand = archiveIndexed || expanded;
	const time = formatTime(props.message.timestamp);

	const loadArchive = async () => {
		if (loadingArchive || archived) return;
		const agentId = props.message.agentId;
		if (!compactionId || !agentId) {
			setArchiveFailed(true);
			return;
		}
		setLoadingArchive(true);
		setArchiveFailed(false);
		try {
			// window.piDesktop 的类型来自 shared/api.ts（types.d.ts 全局声明），无需断言
			const { messages } = await window.piDesktop.sessions.readArchivedMessages(agentId, compactionId);
			setFetchedArchived(messages);
		} catch {
			// 失败必须可见：否则用户只看到展开区一直空着，无法区分「没有归档」和「读取失败」
			setArchiveFailed(true);
		} finally {
			setLoadingArchive(false);
		}
	};

	const toggleExpanded = () => {
		if (!canExpand) return;
		const next = !expanded;
		setExpanded(next);
		if (next) void loadArchive();
	};

	return (
		<article
			className={`compaction-card${expanded ? " compaction-card--expanded" : ""}`}
			data-message-id={props.message.id}
		>
			<button
				type="button"
				className="compaction-card-header"
				onClick={toggleExpanded}
				disabled={!canExpand}
				aria-expanded={expanded}
			>
				<span className="compaction-card-icon" aria-hidden="true">
					{canExpand ? (expanded ? "📂" : "📁") : "🔁"}
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
						{canExpand && (
							<span className="compaction-card-hint">
								{expanded ? t("app.compactionCollapse") : t("app.compactionExpand")}
							</span>
						)}
					</div>
					<time className="compaction-card-time">{time}</time>
				</div>
			</button>
			{expanded && (
				<div className="compaction-card-archive">
					<div className="compaction-card-archive-divider" />
					{loadingArchive ? (
						<div className="compaction-card-archive-status">{t("app.compactionArchiveLoading")}</div>
					) : archiveFailed ? (
						<div className="compaction-card-archive-status compaction-card-archive-status--error">
							<span>{t("app.compactionArchiveFailed")}</span>
							<Button variant="ghost" onClick={() => void loadArchive()}>
								{t("app.compactionArchiveRetry")}
							</Button>
						</div>
					) : archived && archived.length > 0 ? (
						<ArchivedMessageList messages={archived} />
					) : (
						// 条数索引与实际读取不一致（会话文件被替换/归档区间缺失）时给可见反馈，
						// 否则用户只看到一块空白区域，无法区分「空」和「出错」
						<div className="compaction-card-archive-status">
							{t("app.compactionArchiveEmpty")}
						</div>
					)}
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
