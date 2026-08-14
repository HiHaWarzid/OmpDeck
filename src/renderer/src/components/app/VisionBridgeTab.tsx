import { useState } from "react";
import type { AppSettings } from "../../../../shared/types";
import { t } from "../../i18n";

/**
 * 视觉桥设置 tab：给非视觉模型"眼睛"。
 * 发送带图片的消息时，主进程经 OpenAI 兼容端点把图片转成文本描述注入上下文。
 * 配置项直接写入 draftSettings.visionBridge（嵌套对象整体替换），保存时随设置弹框统一提交。
 */
export function VisionBridgeTab(props: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => void;
}) {
	const vb = props.settings.visionBridge;
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{
		ok: boolean;
		message: string;
	} | null>(null);

	const patch = (field: keyof typeof vb, value: string | boolean | number) => {
		props.onChange({ visionBridge: { ...vb, [field]: value } });
	};

	const runTest = async () => {
		setTesting(true);
		setTestResult(null);
		try {
			const result = await window.piDesktop.app.visionTest({
				baseUrl: vb.baseUrl,
				apiKey: vb.apiKey,
			});
			if (result.ok) {
				const sample = (result.models ?? []).slice(0, 8).join(", ");
				setTestResult({
					ok: true,
					message: sample
						? t("settings.vision.testSuccess", { models: sample })
						: t("settings.vision.testSuccessEmpty"),
				});
			} else {
				setTestResult({ ok: false, message: result.error ?? t("common.error") });
			}
		} catch (error) {
			setTestResult({
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="settings-section">
			<label className="setting-switch-row">
				<span>
					<strong>{t("settings.vision.enabled")}</strong>
					<small>{t("settings.vision.enabledDesc")}</small>
				</span>
				<input
					type="checkbox"
					checked={vb.enabled}
					onChange={(event) => patch("enabled", event.target.checked)}
				/>
			</label>

			<div className="setting-field">
				<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					<strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-control)", fontWeight: 500 }}>
						{t("settings.vision.baseUrl")}
					</strong>
					<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)", lineHeight: 1.4 }}>
						{t("settings.vision.baseUrlDesc")}
					</small>
				</div>
				<input
					type="text"
					value={vb.baseUrl}
					placeholder="https://api.example.com/v1"
					onChange={(event) => patch("baseUrl", event.target.value)}
					style={{
						width: "100%",
						fontFamily: "var(--font-family-mono)",
						fontSize: "var(--font-size-sm)",
						padding: "var(--space-2) var(--space-3)",
						border: "1px solid var(--color-border-subtle)",
						borderRadius: "var(--radius-sm)",
						background: "var(--color-bg-input)",
						color: "var(--color-text-primary)",
					}}
				/>
			</div>

			<div className="setting-field">
				<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					<strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-control)", fontWeight: 500 }}>
						{t("settings.vision.apiKey")}
					</strong>
					<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)", lineHeight: 1.4 }}>
						{t("settings.vision.apiKeyDesc")}
					</small>
				</div>
				<input
					type="password"
					value={vb.apiKey}
					onChange={(event) => patch("apiKey", event.target.value)}
					style={{
						width: "100%",
						fontFamily: "var(--font-family-mono)",
						fontSize: "var(--font-size-sm)",
						padding: "var(--space-2) var(--space-3)",
						border: "1px solid var(--color-border-subtle)",
						borderRadius: "var(--radius-sm)",
						background: "var(--color-bg-input)",
						color: "var(--color-text-primary)",
					}}
				/>
			</div>

			<div className="setting-field">
				<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					<strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-control)", fontWeight: 500 }}>
						{t("settings.vision.model")}
					</strong>
					<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)", lineHeight: 1.4 }}>
						{t("settings.vision.modelDesc")}
					</small>
				</div>
				<input
					type="text"
					value={vb.model}
					placeholder="gpt-4o-mini"
					onChange={(event) => patch("model", event.target.value)}
					style={{
						width: "100%",
						fontFamily: "var(--font-family-mono)",
						fontSize: "var(--font-size-sm)",
						padding: "var(--space-2) var(--space-3)",
						border: "1px solid var(--color-border-subtle)",
						borderRadius: "var(--radius-sm)",
						background: "var(--color-bg-input)",
						color: "var(--color-text-primary)",
					}}
				/>
			</div>

			<div className="setting-field">
				<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					<strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-control)", fontWeight: 500 }}>
						{t("settings.vision.prompt")}
					</strong>
					<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)", lineHeight: 1.4 }}>
						{t("settings.vision.promptDesc")}
					</small>
				</div>
				<textarea
					value={vb.prompt}
					rows={4}
					onChange={(event) => patch("prompt", event.target.value)}
					style={{
						width: "100%",
						fontFamily: "var(--font-family-mono)",
						fontSize: "var(--font-size-sm)",
						padding: "var(--space-2) var(--space-3)",
						border: "1px solid var(--color-border-subtle)",
						borderRadius: "var(--radius-sm)",
						background: "var(--color-bg-input)",
						color: "var(--color-text-primary)",
						resize: "vertical",
						lineHeight: "var(--line-height-body)",
					}}
				/>
			</div>

			<div className="setting-field">
				<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					<strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-control)", fontWeight: 500 }}>
						{t("settings.vision.timeout")}
					</strong>
					<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)", lineHeight: 1.4 }}>
						{t("settings.vision.timeoutDesc")}
					</small>
				</div>
				<input
					type="number"
					value={vb.timeoutMs}
					min={5000}
					step={1000}
					onChange={(event) => patch("timeoutMs", Math.max(5000, Number(event.target.value) || 120000))}
					style={{
						width: "140px",
						fontFamily: "var(--font-family-mono)",
						fontSize: "var(--font-size-sm)",
						padding: "var(--space-2) var(--space-3)",
						border: "1px solid var(--color-border-subtle)",
						borderRadius: "var(--radius-sm)",
						background: "var(--color-bg-input)",
						color: "var(--color-text-primary)",
					}}
				/>
			</div>

			<div className="setting-field">
				<button
					type="button"
					className="config-btn"
					disabled={testing || !vb.baseUrl.trim() || !vb.apiKey.trim()}
					onClick={runTest}
				>
					{testing ? t("settings.vision.testing") : t("settings.vision.test")}
				</button>
				{testResult && (
					<small
						style={{
							color: testResult.ok ? "var(--color-success)" : "var(--color-danger)",
							wordBreak: "break-all",
							lineHeight: 1.5,
						}}
					>
						{testResult.message}
					</small>
				)}
			</div>
		</div>
	);
}
