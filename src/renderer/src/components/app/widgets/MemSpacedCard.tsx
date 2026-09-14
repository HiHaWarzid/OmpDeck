/** 记忆面板卡片：展示 memory-store 条目与容量/饥饿状态。 */
import { memo, useCallback, useEffect, useState } from "react";
import { ChevronDown, Bot, Brain, RefreshCw, X } from "lucide-react";
import { t, type TranslationKey } from "../../../i18n";
import { showNotice } from "../../../utils/notice";

// 记忆管理阈值
const HUNGRY_THRESHOLD = 0.15;
const ARCHIVE_THRESHOLD = 0.1;
// 仅作为路径片段，实际拼接用 joinMemoryStorePath，兼容 Windows 反斜杠。
const MEM_STORE_SEGMENTS = [".omp", "agent", "memory-store.json"] as const;
const TYPE_LABEL_KEYS: Record<string, TranslationKey> = {
	decision: "mem.type.decision",
	convention: "mem.type.convention",
	pattern: "mem.type.pattern",
	preference: "mem.type.preference",
	fact: "mem.type.fact",
	lesson: "mem.type.lesson",
};
function joinMemoryStorePath(homeDir: string): string {
	const sep = homeDir.includes("\\") ? "\\" : "/";
	const base = homeDir.replace(/[\\/]+$/, "");
	return [base, ...MEM_STORE_SEGMENTS].join(sep);
}
function potencyBadge(p: number): { icon: string; cls: string } {
	if (p >= 0.8) return { icon: "🔥", cls: "mem-badge-high" };
	if (p >= 0.4) return { icon: "⭐", cls: "mem-badge-mid" };
	if (p > ARCHIVE_THRESHOLD) return { icon: "⚠️", cls: "mem-badge-low" };
	return { icon: "📦", cls: "mem-badge-archived" };
}
function formatMemoryTime(ts: number | undefined): string {
	if (!ts) return t("mem.time.never");
	const days = Math.floor((Date.now() - ts) / 864e5);
	if (days === 0) return t("mem.time.today");
	if (days === 1) return t("mem.time.yesterday");
	return t("mem.time.daysAgo", { days });
}
function memoryTypeLabel(type: string): string {
	const key = TYPE_LABEL_KEYS[type];
	return key ? t(key) : "";
}
interface MemoryItem {
	id: string;
	type: string;
	content: string;
	potency: number;
	tenured?: boolean;
	lastInjectedAt?: number;
}
interface MemoryStore {
	memories: MemoryItem[];
}
/**
 * MemSpacedCard — 记忆管理卡片
 *
 * 直接从 ~/.omp/agent/memory-store.json 读取记忆数据，展示概览统计、低效记忆和全部记忆列表。
 * 支持手动刷新、AI 整理记忆库入口。
 */
export const MemSpacedCard = memo(function MemSpacedCard(props: {
	widgetKey: string;
	lines: string[];
	homeDir: string;
	agentId?: string;
	onClose: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [view, setView] = useState<"summary" | "low-potency" | "all">("summary");
	const [data, setData] = useState<MemoryStore | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	const storePath = props.homeDir ? joinMemoryStorePath(props.homeDir) : "";

	const loadData = useCallback(async () => {
		if (!storePath) return;
		setLoading(true);
		try {
			// 有界读返回 { content, truncated }；被截断的 JSON 无法解析，按读取失败处理并提示。
			const { content: raw, truncated } = await window.piDesktop.files.readContent(storePath);
			if (truncated) showNotice(t("editor.truncatedNotice"), 4000, "warning");
			if (!raw || raw.trim() === "") {
				setData(null);
				return;
			}
			setData(JSON.parse(raw));
			setError("");
		} catch (e) {
			const err = e as { code?: string };
			if (err?.code !== "ENOENT") {
				setError(t("mem.card.loadFailed"));
			}
		} finally {
			setLoading(false);
		}
	}, [storePath]);

	useEffect(() => {
		loadData();
	}, [loadData]);

	// 当 lines 变化时（扩展推送新数据）自动重新加载
	useEffect(() => {
		loadData();
	}, [props.lines, loadData]);

	const activeCount = data?.memories.filter((m) => m.potency >= ARCHIVE_THRESHOLD).length ?? 0;
	const hungryMemories = data?.memories.filter(
		(m) => m.potency < HUNGRY_THRESHOLD && m.potency >= ARCHIVE_THRESHOLD,
	) ?? [];
	const hungryCount = hungryMemories.length;
	const tenuredCount = data?.memories.filter((m) => m.tenured).length ?? 0;

	return (
		<div className="mem-spaced-card">
			<div className="mem-spaced-card-header">
				<button
					className="mem-spaced-card-trigger"
					onClick={() => setExpanded((prev) => !prev)}
					aria-expanded={expanded}
				>
					<ChevronDown
						size={14}
						className={`mem-spaced-card-chevron${expanded ? " open" : ""}`}
					/>
					<span className="mem-spaced-card-title">{props.widgetKey}</span>
					<span className="mem-spaced-card-status">
						<Brain size={12} />
						{loading ? "..." : t("mem.card.activeCount", { count: activeCount })}
					</span>
				</button>
				<button
					className="mem-spaced-card-close"
					onClick={props.onClose}
					title={t("mem.card.close")}
					aria-label={t("mem.card.close")}
				>
					<X size={12} strokeWidth={2} />
				</button>
			</div>
			{expanded && !loading && data && (
				<div className="mem-spaced-card-content">
					<div className="mem-spaced-card-tabs">
						<button
							className={`mem-spaced-card-tab${view === "summary" ? " active" : ""}`}
							onClick={() => setView("summary")}
						>
							{t("mem.card.tabSummary")}
						</button>
						<button
							className={`mem-spaced-card-tab${view === "low-potency" ? " active" : ""}`}
							onClick={() => setView("low-potency")}
						>
							{hungryCount > 0
								? t("mem.card.tabLowPotencyWithCount", { count: hungryCount })
								: t("mem.card.tabLowPotency")}
						</button>
						<button
							className={`mem-spaced-card-tab${view === "all" ? " active" : ""}`}
							onClick={() => setView("all")}
						>
							{t("mem.card.tabAll")}
						</button>
					</div>
					{view === "summary" && (
						<div className="mem-spaced-card-summary">
							<div className="mem-spaced-card-stat">
								<span>{t("mem.card.statTotal")}</span>
								<span>{data.memories.length}</span>
							</div>
							<div className="mem-spaced-card-stat">
								<span>{t("mem.card.statActive")}</span>
								<span>{activeCount}</span>
							</div>
							<div className="mem-spaced-card-stat">
								<span>{t("mem.card.statLow")}</span>
								<span className={hungryCount > 0 ? "mem-hungry" : ""}>{hungryCount}</span>
							</div>
							<div className="mem-spaced-card-stat">
								<span>{t("mem.card.statTenured")}</span>
								<span>{tenuredCount}</span>
							</div>
						</div>
					)}
					{view === "low-potency" && (
						<div className="mem-spaced-card-list">
							{hungryMemories.length === 0 ? (
								<div className="mem-spaced-card-empty">{t("mem.card.emptyLow")}</div>
							) : (
								<div className="mem-card-scroll">
									{hungryMemories.slice(0, 15).map((m) => {
										const badge = potencyBadge(m.potency);
										return (
											<div key={m.id} className="mem-spaced-card-item">
												<span className={`mem-badge ${badge.cls}`}>{badge.icon}</span>
												<span className="mem-item-content">
													{m.content.slice(0, 60)}
													{m.content.length > 60 ? "…" : ""}
												</span>
												<span className="mem-item-meta">
													{memoryTypeLabel(m.type)}
													{" p:"}
													{m.potency.toFixed(2)}
													{" "}
													{formatMemoryTime(m.lastInjectedAt)}
												</span>
											</div>
										);
									})}
								</div>
							)}
						</div>
					)}
					{view === "all" && (
						<div className="mem-spaced-card-list">
							{data.memories.length === 0 ? (
								<div className="mem-spaced-card-empty">{t("mem.card.emptyAll")}</div>
							) : (
								<div className="mem-card-scroll">
									{[...data.memories].sort((a, b) => b.potency - a.potency).slice(0, 50).map((m) => {
										const badge = potencyBadge(m.potency);
										const pct = Math.round(m.potency * 100);
										const typeLabel = memoryTypeLabel(m.type);
										return (
											<div key={m.id} className="mem-spaced-card-item mem-all-item">
												<span className={`mem-badge ${badge.cls}`}>{badge.icon}</span>
												<div className="mem-all-body">
													<span className="mem-item-content">
														{m.content.slice(0, 70)}
														{m.content.length > 70 ? "..." : ""}
													</span>
													<div className="mem-all-bar-wrap">
														<div className="mem-all-bar" style={{ width: `${pct}%` }} />
													</div>
												</div>
												<span className="mem-item-meta">
													{typeLabel.slice(0, 2)}
													{" "}
													{pct}%
												</span>
											</div>
										);
									})}
								</div>
							)}
						</div>
					)}
					<div className="mem-spaced-card-footer">
						<div className="mem-footer-left">
							{props.agentId && (
								<button
									className="mem-org-btn"
									title={t("mem.card.organizeTitle")}
									onClick={() => {
										window.piDesktop.agents.prompt({
											agentId: props.agentId!,
											message: t("mem.card.organizePrompt"),
											description: t("mem.card.organizeDescription"),
										});
									}}
								>
									<Bot size={14} />
									<span>{t("mem.card.organize")}</span>
								</button>
							)}
						</div>
						<div className="mem-footer-right">
							<span className="mem-spaced-card-count">{t("mem.card.countItems", { count: activeCount })}</span>
							<button
								className="mem-refresh-btn"
								title={t("mem.card.refreshTitle")}
								onClick={loadData}
							>
								<RefreshCw size={13} />
							</button>
						</div>
					</div>
				</div>
			)}
			{expanded && loading && (
				<div className="mem-spaced-card-content">
					<div className="mem-spaced-card-empty">{t("mem.card.loading")}</div>
				</div>
			)}
			{expanded && error && (
				<div className="mem-spaced-card-content">
					<div className="mem-spaced-card-empty mem-error">{error}</div>
				</div>
			)}
		</div>
	);
});
