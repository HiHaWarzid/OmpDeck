import { useEffect, useState } from "react";
import { Copy, RotateCcw, Trash2 } from "lucide-react";
import type { PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary } from "../../../shared/types";
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
