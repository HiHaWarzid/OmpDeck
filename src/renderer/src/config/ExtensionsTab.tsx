import { useEffect, useState } from "react";
import { Copy, Download, RotateCcw, Trash2 } from "lucide-react";
import type { PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiPackageInfo } from "../../../shared/types";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";

type ExtensionsApi = {
	list: () => Promise<PiExtensionListResult>;
	uninstall: (source: string, scope?: "user" | "project" | "unknown") => Promise<void>;
	install: (source: string) => Promise<string>;
	removeBuiltIn: (source: string) => Promise<void>;
	restoreBuiltIn: (source: string) => Promise<void>;
	update: () => Promise<PiCliUpdateResult>;
};

function getExtensionsApi(): ExtensionsApi {
	const api = (window as unknown as { piDesktop?: { extensions?: ExtensionsApi } })
		.piDesktop?.extensions;
	if (!api) throw new Error("OmpDeck extensions API is not available");
	return api;
}

/** OmpDeck 已移除内置扩展（omp 提供原生能力替代） */
const PIDEK_BUILTIN_SOURCE: Record<string, string> = {};

/** 预设推荐扩展包 */
const RECOMMENDED_PACKAGES: PiPackageInfo[] = [
	{
		name: "context-mode",
		description: "MCP 插件，可节省 98% 的上下文窗口。沙箱代码执行、FTS5 知识库和意图驱动搜索。",
		installCmd: "npm:context-mode",
		tags: ["extension"],
		downloads: "107K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/context-mode",
		repoUrl: "https://github.com/mksglu/context-mode",
	},
	{
		name: "pi-web-access",
		description: "网络搜索、URL 抓取、GitHub 仓库克隆、PDF 提取、YouTube 视频理解和本地视频分析。",
		installCmd: "npm:pi-web-access",
		tags: ["extension"],
		downloads: "99K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-web-access",
		repoUrl: "https://github.com/nicobailon/pi-web-access",
	},
	{
		name: "pi-mcp-adapter",
		description: "MCP（Model Context Protocol）适配器扩展，让 omp 可以连接任何 MCP 服务器。",
		installCmd: "npm:pi-mcp-adapter",
		tags: ["extension"],
		downloads: "99K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
		repoUrl: "https://github.com/nicobailon/pi-mcp-adapter",
	},
	{
		name: "pi-subagents",
		description: "任务委派扩展，支持链式、并行执行和 TUI 澄清。可将复杂任务拆解给多个子 Agent。",
		installCmd: "npm:pi-subagents",
		tags: ["extension"],
		downloads: "92K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-subagents",
		repoUrl: "https://github.com/nicobailon/pi-subagents",
	},
];

/** 从扩展来源提取简短描述名 */
function shortName(source: string): string {
	return source
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "");
}

export function ExtensionsTab(props: {
	data: PiExtensionListResult;
	loading: boolean;
	uninstallingSource: string | null;
	onRefresh: () => void;
	onUninstall: (extension: PiExtensionSummary) => void;
}) {
	const [installingSources, setInstallingSources] = useState<Set<string>>(() => new Set());
	const [restoringBuiltIn, setRestoringBuiltIn] = useState<string | null>(null);
	const [removingBuiltIn, setRemovingBuiltIn] = useState<string | null>(null);

	// 首次加载或列表刷新时展示扩展冲突通知
	useEffect(() => {
		if (!props.data.conflicts || props.data.conflicts.length === 0) return;
		for (const c of props.data.conflicts) {
			showNotice(
				t("config.extensionConflict", {
					builtIn: shortName(c.builtIn),
					thirdParty: shortName(c.thirdParty),
				}),
				8000,
				"warning",
			);
		}
	}, [props.data.conflicts]);

	const handleRemoveBuiltIn = async (extension: PiExtensionSummary) => {
		if (removingBuiltIn) return;
		setRemovingBuiltIn(extension.source);
		try {
			await getExtensionsApi().removeBuiltIn(extension.source);
			props.onRefresh();
		} catch (e) {
			alert(t("config.installFailed") + ": " + (e instanceof Error ? e.message : String(e)));
		} finally {
			setRemovingBuiltIn(null);
		}
	};

	const handleRestoreBuiltIn = async (extension: PiExtensionSummary) => {
		if (restoringBuiltIn) return;
		setRestoringBuiltIn(extension.source);
		try {
			await getExtensionsApi().restoreBuiltIn(extension.source);
			props.onRefresh();
		} catch (e) {
			alert(t("config.installFailed") + ": " + (e instanceof Error ? e.message : String(e)));
		} finally {
			setRestoringBuiltIn(null);
		}
	};
	const [updating, setUpdating] = useState<string | null>(null);
	const [updateResult, setUpdateResult] = useState<PiCliUpdateResult | null>(null);
	const [showUpdateDialog, setShowUpdateDialog] = useState(false);

	const handleInstall = async (pkg: PiPackageInfo) => {
		setInstallingSources((current) => new Set(current).add(pkg.installCmd));
		try {
			// 对已移除的内置扩展，走恢复流程而非 npm 安装
			const builtInSource = pkg.name.startsWith("pi-deck-") ? PIDEK_BUILTIN_SOURCE[pkg.name] : undefined;
			if (builtInSource) {
				await getExtensionsApi().restoreBuiltIn(builtInSource);
			} else {
				await getExtensionsApi().install(pkg.installCmd);
			}
			props.onRefresh();
		} catch (e) {
			alert(t("config.installFailed") + ": " + (e instanceof Error ? e.message : String(e)));
		} finally {
			setInstallingSources((current) => {
				const next = new Set(current);
				next.delete(pkg.installCmd);
				return next;
			});
		}
	};

	const handleUpdateExtensions = async () => {
		setUpdating("all");
		setUpdateResult(null);
		setShowUpdateDialog(true);
		try {
			const result = await getExtensionsApi().update();
			setUpdateResult(result);
		} catch (e) {
			alert(t("settings.extensionsUpdateFailed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setUpdating(null);
		}
	};

	return (
		<div className="extensions-tab">
			{showUpdateDialog && (
				<div className="config-update-dialog-backdrop" role="dialog" aria-modal="true">
					<div className="config-update-dialog">
						<div className="config-update-dialog-header">
							<strong>{t("settings.updateExtensionsAll")}</strong>
							<button
								className="config-icon-btn"
								onClick={() => {
									setShowUpdateDialog(false);
									props.onRefresh();
								}}
								disabled={Boolean(updating)}
							>
								×
							</button>
						</div>
						<p className="config-im-form-hint">
							{updating ? t("settings.extensionsUpdatingDesc") : t("settings.extensionsUpdateResultHint")}
						</p>
						<pre className="setting-update-output">
							{updateResult ? `${updateResult.command}\n${updateResult.output}` : t("settings.extensionsUpdating")}
						</pre>
						<div className="config-update-dialog-actions">
							<button
								className="config-btn primary"
								onClick={() => {
									setShowUpdateDialog(false);
									props.onRefresh();
								}}
								disabled={Boolean(updating)}
							>
								{t("common.close")}
							</button>
						</div>
					</div>
				</div>
			)}
			{/* 预设推荐扩展 — 大列表简洁显示 */}
			<div className="config-section" style={{ marginBottom: 20 }}>
				<div className="config-toolbar">
					<h3 className="extensions-installed-title">{t("config.recommendedPackages")}</h3>
				</div>
				<p className="config-im-form-hint" style={{ marginBottom: 12 }}>
					{t("config.recommendedPackagesHint")}
				</p>
				<div className="extensions-recommended-list">
					{RECOMMENDED_PACKAGES.map((pkg) => {
						// 内置扩展按 source 文件名匹配，npm 扩展按 installCmd 匹配
						const builtInSource = pkg.name.startsWith("pi-deck-") ? PIDEK_BUILTIN_SOURCE[pkg.name] : undefined;
						const builtInExt = builtInSource
							? props.data.extensions.find((ext) => ext.builtIn && ext.source === builtInSource)
							: undefined;
						// 已部署（非移除状态）视为已安装；已移除的内置扩展允许恢复安装
						const alreadyInstalled = builtInExt
							? builtInExt.enabled !== false
							: props.data.extensions.some((ext) => ext.source === pkg.installCmd);
						const installing = installingSources.has(pkg.installCmd);
						return (
						<div
							key={pkg.name}
							className="extensions-recommended-row"
							onClick={() => {
								// pi.dev 的详情路由使用 npm 包名,但查询参数可能是扩展内部展示名。
								const packageName = pkg.piPackageName ?? pkg.name;
								window.open(`https://pi.dev/packages/${pkg.name}?name=${packageName}`, '_blank');
							}}
							title={`${t("config.openPackageDetail")}: ${pkg.name}`}
						>
							<div className="extensions-recommended-info">
								<div className="extensions-recommended-name">
									<strong>{pkg.name}</strong>
									{alreadyInstalled && <span className="config-im-connected-badge" style={{ marginLeft: 8 }}>{t("config.installed")}</span>}
								</div>
								<div className="extensions-recommended-desc">
									{pkg.description}
								</div>
							</div>
							<div className="extensions-recommended-action" onClick={(e) => e.stopPropagation()}>
								{/* 安装中保持与图标按钮同尺寸，避免 config-btn 文本把操作区撑开错位 */}
								<button
									className="config-icon-btn"
									title={installing ? t("config.installing") : alreadyInstalled ? t("config.installed") : t("config.install")}
									onClick={() => handleInstall(pkg)}
									disabled={alreadyInstalled || installing}
									aria-busy={installing}
								>
									{installing ? (
										<span className="skillhub-installing-dot" aria-hidden="true" />
									) : (
										<Download size={15} strokeWidth={1.8} aria-hidden="true" />
									)}
								</button>
								<button
									className="config-icon-btn"
									title={t("common.copy")}
									onClick={(e) => {
										e.stopPropagation();
										const cmd = `omp install ${pkg.installCmd}`;
										writeClipboard(cmd);
										showNotice(t("app.codeCopied"), 1200);
									}}
								>
									<Copy size={14} strokeWidth={1.8} />
								</button>
							</div>
						</div>
					);
					})}
				</div>
			</div>

			<hr className="extensions-divider" />

			{/* 已安装扩展列表 */}
			<div className="config-section">
				<h3 className="extensions-installed-title">{t("config.installedExtensions")}</h3>
				<div className="config-toolbar" style={{ marginTop: 8 }}>
					<div>
						<span className="config-count">
							{t("config.count.extensions", { count: props.data.extensions.length })}
						</span>
						<small className="skills-restart-hint">
							{t("config.extensionRestartHint")}
						</small>
					</div>
					<div className="skills-toolbar-actions">
						<button className="config-btn" onClick={handleUpdateExtensions} disabled={props.loading || Boolean(updating)}>
							{updating ? t("settings.updating") : t("settings.updateExtensionsAll")}
						</button>
						<button className="config-btn" onClick={props.onRefresh} disabled={props.loading}>
							{t("common.refresh")}
						</button>
					</div>
				</div>
				<div className="skills-list">
					{props.loading ? (
						<div className="config-loading">{t("config.loadingExtensions")}</div>
					) : props.data.extensions.length === 0 ? (
						<div className="config-empty">{t("config.emptyExtensions")}</div>
					) : (
						props.data.extensions.map((extension) => (
							<ExtensionCard
								key={extension.id}
								extension={extension}
								uninstalling={props.uninstallingSource === extension.source}
								onUninstall={props.onUninstall}
								onRemoveBuiltIn={handleRemoveBuiltIn}
								onRestoreBuiltIn={handleRestoreBuiltIn}
								removingBuiltIn={removingBuiltIn === extension.source}
								restoringBuiltIn={restoringBuiltIn === extension.source}
							/>
						))
					)}
				</div>
			</div>
		</div>
	);
}

function ExtensionCard(props: {
	extension: PiExtensionSummary;
	uninstalling: boolean;
	onUninstall: (extension: PiExtensionSummary) => void;
	onRemoveBuiltIn: (extension: PiExtensionSummary) => void;
	onRestoreBuiltIn: (extension: PiExtensionSummary) => void;
	removingBuiltIn?: boolean;
	restoringBuiltIn?: boolean;
}) {
	const { extension } = props;
	const name = extension.source.replace(/^(?:npm|file|github|git):/i, "");
	return (
		<article
			className={`session-card skill-card extension-card${props.uninstalling ? " extension-removing" : ""}`}
			aria-busy={props.uninstalling}
		>
			<div className="session-card-display">
				<div className="session-card-inner skill-card-main">
					<div className="session-card-title skill-title-row">
						<strong>{name}</strong>
						<div className="skill-badges">
							{extension.builtIn && (
								<span className="skill-state enabled">{t("common.builtIn")}</span>
							)}
							<span className={`skill-state ${extension.enabled === false ? "disabled" : "enabled"}`}>
								{extension.enabled !== false ? t("common.enabled") : t("common.disabled")}
							</span>
							<span className="skill-state enabled">
								{extension.scope === "project"
									? t("common.project")
									: t("common.global")}
							</span>
						</div>
					</div>
					<small>{extension.source}</small>
					{!extension.builtIn && (
						<small>
							{t("config.extensionVersions", {
								current: extension.currentVersion ?? "-",
								latest: extension.latestVersion ?? "-",
							})}
							{extension.hasUpdate ? ` · ${t("config.extensionUpdateAvailable")}` : ""}
						</small>
					)}
					{extension.updateError && <small className="setting-status error">{extension.updateError}</small>}
					{extension.path && <small>{extension.path}</small>}
				</div>
				<div className="prompts-list-item-actions">
					{/* 内置扩展：移除（禁止自动部署）或恢复 */}
					{extension.builtIn && extension.enabled !== false && (
						<button
							className="config-icon-btn"
							disabled={props.removingBuiltIn}
							onClick={() => props.onRemoveBuiltIn(extension)}
							title={props.removingBuiltIn ? t("config.uninstalling") : t("config.uninstall")}
						>
							<Trash2 size={14} strokeWidth={1.8} />
						</button>
					)}
					{extension.builtIn && extension.enabled === false && (
						<button
							className="config-icon-btn"
							style={{ color: "var(--color-accent)" }}
							disabled={props.restoringBuiltIn}
							onClick={() => props.onRestoreBuiltIn(extension)}
							title={t("config.restoreBuiltIn")}
						>
							<RotateCcw size={14} strokeWidth={1.8} />
						</button>
					)}
					{/* 三方扩展：卸载 */}
					{!extension.builtIn && (
						<button
							className="config-icon-btn danger"
							disabled={props.uninstalling}
							onClick={() => props.onUninstall(extension)}
							title={props.uninstalling ? t("config.uninstalling") : t("config.uninstall")}
						>
							<Trash2 size={14} strokeWidth={1.8} />
						</button>
					)}
				</div>
			</div>
		</article>
	);
}
