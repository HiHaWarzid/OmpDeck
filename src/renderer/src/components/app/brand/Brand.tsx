/** 品牌标识与头像：Logo、项目/智能体头像、空状态与状态指示，主界面与侧边栏共用。 */
import { Fragment } from "react";
import { Folder, MessageCircle } from "lucide-react";
import { t, type TranslationKey } from "../../../i18n";

/**
 * 侧栏 Agent 状态圆点（对齐最近会话列表风格）：
 * idle=实心蓝点；starting=灰色转圈；running=实心黄点；error=实心红点；closed=灰色静默点。
 * 仅用色点/转圈表达状态，title/aria-label 保留完整文案。
 */
export function AgentStatusIndicator(props: { status: string }) {
	const statusKey = `app.status${props.status.charAt(0).toUpperCase()}${props.status.slice(1)}` as TranslationKey;
	const label = t(statusKey) || props.status;
	return (
		<span
			className={`agent-status-indicator status-${props.status}`}
			title={label}
			aria-label={label}
		>
			{/* starting 用环状 spinner，其余状态用实心圆点 */}
			<span className="agent-status-dot" aria-hidden="true" />
		</span>
	);
}
export function LogoMark() {
	return (
		<div className="logo-mark" aria-label={t("app.logoLabel")}>
			<svg viewBox="0 0 120 120" width="24" height="24" aria-hidden="true">
				<rect x="22" y="30" width="76" height="12" rx="2" fill="#000"/>
				<rect x="34" y="42" width="12" height="52" rx="2" fill="#000"/>
				<rect x="74" y="42" width="12" height="32" rx="2" fill="#000"/>
				<rect x="64" y="68" width="28" height="22" rx="4" fill="#ff8c00"/>
				<rect x="69" y="74" width="4" height="10" rx="1" fill="var(--color-bg-sidebar)"/>
				<rect x="83" y="74" width="4" height="10" rx="1" fill="var(--color-bg-sidebar)"/>
			</svg>
		</div>
	);
}
/**
 * 侧栏品牌 lockup：π 标 + OmpDeck 字标，垂直居中平齐。
 * replayToken 由 App 在 agent 启动/关闭时递增，驱动 logo 重播拼装动画。
 */
export function BrandLockup(_props: { replayToken?: number } = {}) {
	return (
		<div className="brand-lockup" aria-label="OmpDeck">
			{/* 44px SVG π — 细版匹配托盘图标 */}
			<svg viewBox="0 0 120 120" width="45" height="45" aria-hidden="true">
				<rect x="22" y="30" width="76" height="12" rx="2" fill="#000"/>
				<rect x="34" y="42" width="12" height="52" rx="2" fill="#000"/>
				<rect x="74" y="42" width="12" height="32" rx="2" fill="#000"/>
				<rect x="64" y="68" width="28" height="22" rx="4" fill="#ff8c00"/>
				<rect x="69" y="74" width="4" height="10" rx="1" fill="var(--color-bg-sidebar)"/>
				<rect x="83" y="74" width="4" height="10" rx="1" fill="var(--color-bg-sidebar)"/>
			</svg>
			<span className="brand-wordmark" aria-hidden="true">
				OmpDeck
			</span>
		</div>
	);
}
export function ProjectAvatar(props: { name: string; kind?: "chat" | "project" }) {
	return (
		<div
			className={`conversation-avatar project-avatar${props.kind === "chat" ? " chat-avatar" : ""}`}
			title={t("app.projectAvatarTitle", { name: props.name })}
		>
			{props.kind === "chat" ? (
				<MessageCircle size={16} strokeWidth={1.9} />
			) : (
				<Folder size={16} strokeWidth={1.8} />
			)}
		</div>
	);
}
export function AgentAvatar(props: { status: string }) {
	return (
		<div className={`conversation-avatar agent-avatar ${props.status}`}>
			<svg viewBox="0 0 120 120" width="28" height="28" aria-hidden="true">
				<rect x="22" y="30" width="76" height="12" rx="2" fill="#000"/>
				<rect x="34" y="42" width="12" height="52" rx="2" fill="#000"/>
				<rect x="74" y="42" width="12" height="32" rx="2" fill="#000"/>
				<rect x="64" y="68" width="28" height="22" rx="4" fill="#ff8c00"/>
				<rect x="69" y="74" width="4" height="10" rx="1" fill="var(--color-bg-sidebar)"/>
				<rect x="83" y="74" width="4" height="10" rx="1" fill="var(--color-bg-sidebar)"/>
			</svg>
		</div>
	);
}
export function EmptyState(props: { hasProject: boolean; onCreate: () => void }) {
	return (
		<div className="empty-state">
			<div className="empty-logo">
				<svg
					viewBox="0 0 120 120"
					width="168"
					height="168"
					aria-hidden="true"
				>
					<rect x="22" y="31" width="76" height="10" rx="2" fill="#000"/>
					<rect x="35" y="41" width="10" height="52" rx="2" fill="#000"/>
					<rect x="75" y="41" width="10" height="32" rx="2" fill="#000"/>
					<rect x="65" y="67" width="28" height="22" rx="4" fill="#ff8c00"/>
					<rect x="70" y="73" width="4" height="10" rx="1" fill="var(--color-bg-app)"/>
					<rect x="84" y="73" width="4" height="10" rx="1" fill="var(--color-bg-app)"/>
				</svg>
			</div>
			<div className="empty-tagline" aria-label="A coding agent with the IDE wired in." style={{ fontWeight: 350 }}>
				<span>A coding agent</span>
				<span>
					<span style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-display)", fontStyle: "italic" }}>with the </span>
					<span style={{ color: "oklch(0.29 0.11 346.85 / 1)" }}>IDE wired in.</span>
				</span>
			</div>
			<p className="empty-subtitle">
				{t("app.emptySubtitle").split("\n").map((line, i) => (
					<Fragment key={i}>
						{i > 0 && <br />}
						<span className="empty-subtitle-line">{line}</span>
					</Fragment>
				))}
			</p>
			{props.hasProject ? (
				<button onClick={props.onCreate}>{t("app.createAgent")}</button>
			) : (
				<p className="empty-hint">{t("app.emptyNoProject")}</p>
			)}
		</div>
	);
}
