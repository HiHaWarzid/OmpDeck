import { useState } from "react";
import type { AppSettings } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";

/**
 * 视觉桥设置 tab：给非视觉模型"眼睛"。
 * 发送带图片的消息时，主进程经 OpenAI 兼容端点把图片转成文本描述注入上下文。
 * 配置项直接写入 draftSettings.visionBridge（嵌套对象整体替换），保存时随设置弹框统一提交。
 * 结构与其余设置 tab 一致：settings-section 分区 + TextField/Button 共享组件。
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
		<section className="settings-section">
			<div className="settings-section-header">
				<strong>{t("settings.vision.section")}</strong>
			</div>
			<div className="settings-section-body">
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

				{/* 端点/Key/模型 ID 属技术文本，用等宽字体；类名由 .setting-field--mono 提供，其余样式走共享 TextField */}
				<TextField
					className="setting-field setting-field--after-switch setting-field--mono"
					label={t("settings.vision.baseUrl")}
					description={t("settings.vision.baseUrlDesc")}
					value={vb.baseUrl}
					placeholder="https://api.example.com/v1"
					onChange={(value) => patch("baseUrl", value)}
				/>
				<TextField
					className="setting-field setting-field--mono"
					label={t("settings.vision.apiKey")}
					description={t("settings.vision.apiKeyDesc")}
					value={vb.apiKey}
					type="password"
					onChange={(value) => patch("apiKey", value)}
				/>
				<TextField
					className="setting-field setting-field--mono"
					label={t("settings.vision.model")}
					description={t("settings.vision.modelDesc")}
					value={vb.model}
					placeholder="gpt-4o-mini"
					onChange={(value) => patch("model", value)}
				/>

				{/* 提示词：版式与设置页其他 textarea（SettingTextarea）保持一致 */}
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

				<TextField
					className="setting-field setting-field--mono"
					label={t("settings.vision.timeout")}
					description={t("settings.vision.timeoutDesc")}
					value={String(vb.timeoutMs)}
					type="number"
					min={5000}
					step={1000}
					onChange={(value) => patch("timeoutMs", Math.max(5000, Number(value) || 120000))}
				/>

				<div className="setting-field">
					<Button
						buttonSize="sm"
						loading={testing}
						disabled={!vb.baseUrl.trim() || !vb.apiKey.trim()}
						onClick={runTest}
					>
						{testing ? t("settings.vision.testing") : t("settings.vision.test")}
					</Button>
					{testResult && (
						<small
							className={`setting-status ${testResult.ok ? "success" : "error"}`}
							style={{ wordBreak: "break-all" }}
						>
							{testResult.message}
						</small>
					)}
				</div>
			</div>
		</section>
	);
}
