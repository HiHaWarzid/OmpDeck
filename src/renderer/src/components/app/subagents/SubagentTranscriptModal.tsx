/**
 * 子代理会话记录弹框：按需从子会话 JSONL 读取（与历史会话 Viewer 同一转换管线）。
 *
 * 运行中的子代理每 2s 刷新一次快照；读取有在途守卫，避免 progress 高频更新叠加整文件读取。
 * transcript 只读，不提供编辑/重发——父会话才是可写的入口。
 */
import { lazy, Suspense, useEffect, useState } from "react";
import type { PiDesktopApi } from "../../../../../shared/api";
import type { AgentSubagent, ChatMessage } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Modal } from "../../ui/Modal";
import { isSubagentRunning } from "./subagentStatus";

const LazyMarkdownText = lazy(() =>
	import("../timeline/MarkdownBody").then((module) => ({ default: module.MarkdownText })),
);

function roleLabel(role: ChatMessage["role"]): string {
	switch (role) {
		case "user":
			return t("app.subagentRoleUser");
		case "assistant":
			return t("app.subagentRoleAssistant");
		case "tool":
			return t("app.subagentRoleTool");
		case "error":
			return t("app.subagentRoleError");
		default:
			return t("app.subagentRoleSystem");
	}
}

export function SubagentTranscriptModal({
	open,
	onClose,
	agentId,
	agents,
	subagent,
}: {
	open: boolean;
	onClose: () => void;
	agentId: string;
	agents: PiDesktopApi["agents"];
	/** 取实时 registry 行：状态/耗时随 progress 帧更新，弹框不需要另存快照。 */
	subagent?: AgentSubagent;
}) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const subagentId = subagent?.id;
	const running = subagent ? isSubagentRunning(subagent) : false;

	useEffect(() => {
		if (!open || !subagentId) {
			setMessages([]);
			setError(null);
			setLoading(false);
			return;
		}
		// 在途守卫必须是 effect 局部变量：旧 effect 被 running 状态翻转到终止态时
		// 会立刻清理，若守卫挂在 ref 上，新 effect 会被旧请求挡住且再也不会重试，
		// 弹框就永远停在 loading。局部守卫允许新旧各读一次，旧结果由 disposed 丢弃。
		let disposed = false;
		let inFlight = false;
		const load = async () => {
			if (inFlight) return;
			inFlight = true;
			setLoading(true);
			try {
				const list = await agents.subagentMessages(agentId, subagentId);
				if (!disposed) {
					setMessages(list);
					setError(null);
				}
			} catch (loadError) {
				if (!disposed) {
					setError(loadError instanceof Error ? loadError.message : String(loadError));
				}
			} finally {
				inFlight = false;
				if (!disposed) setLoading(false);
			}
		};
		void load();
		// 终态子代理的会话文件不再变化：只读一次，避免无意义的整文件轮询。
		const timer = running ? setInterval(() => void load(), 2000) : undefined;
		return () => {
			disposed = true;
			if (timer) clearInterval(timer);
		};
	}, [open, agentId, agents, subagentId, running]);

	const title = subagent
		? t("app.subagentTranscriptTitle", {
				name: subagent.description || subagent.agent || subagent.id,
			})
		: t("app.subagentTranscript");

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={title}
			size="medium"
			contentClassName="subagent-transcript-content"
		>
			<div className="subagent-transcript-body">
				{subagent && (
					<div className="subagent-transcript-meta">
						<span>{subagent.resolvedModel ?? subagent.agent ?? ""}</span>
						{subagent.tokens != null && (
							<span>
								{t("app.subagentTokens", {
									count: subagent.tokens.toLocaleString(),
								})}
							</span>
						)}
						{subagent.sessionFile && (
							<span className="subagent-transcript-path" title={subagent.sessionFile}>
								{subagent.sessionFile}
							</span>
						)}
					</div>
				)}
				{loading && messages.length === 0 && (
					<div className="config-loading">{t("app.subagentTranscriptLoading")}</div>
				)}
				{error && <div className="config-error">{t("app.subagentTranscriptFailed")}: {error}</div>}
				{!loading && !error && messages.length === 0 && (
					<div className="config-empty">{t("app.subagentTranscriptEmpty")}</div>
				)}
				{messages.map((message) => (
					<div key={message.id} className={`subagent-transcript-message role-${message.role}`}>
						<div className="subagent-transcript-role">{roleLabel(message.role)}</div>
						{message.thinking && (
							<pre className="subagent-transcript-thinking">{message.thinking}</pre>
						)}
						<Suspense fallback={<div className="subagent-transcript-text">{message.text}</div>}>
							<LazyMarkdownText text={message.text} className="subagent-transcript-text" />
						</Suspense>
					</div>
				))}
			</div>
		</Modal>
	);
}
