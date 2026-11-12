/**
 * omp 原生 OAuth 登录浮层。
 *
 * omp 的 `login` RPC 在浏览器授权期间通过 `extension_ui_request` 推送
 * `open_url`（以及拿到回调后的非敏感 `input`）。这些请求不属于会话时间线，
 * App 的通用 UI 请求路由会忽略 `loginFlow` 标记，由本组件统一承接：
 * 自动打开系统浏览器、展示可复制的回跳地址、回传粘贴的授权码。
 *
 * 登录入口在 Auth 页；本组件常驻挂载，因此用户切到别的 tab 也不会丢回调。
 */
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import type { AgentUiRequest } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { openInSystemBrowser } from "../../../utils/openExternal";
import { writeClipboard } from "../../../utils/clipboard";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { TextField } from "../../ui/TextField";

type LoginPrompt = {
	agentId: string;
	requestId: string;
	method: "input" | "select" | "confirm" | "editor";
	title: string;
	placeholder?: string;
	options?: string[];
};

export function NativeLoginModal() {
	const [providerId, setProviderId] = useState<string | undefined>();
	const [url, setUrl] = useState<string | undefined>();
	const [launchUrl, setLaunchUrl] = useState<string | undefined>();
	const [instructions, setInstructions] = useState<string | undefined>();
	const [prompt, setPrompt] = useState<LoginPrompt | null>(null);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const openedUrls = useRef(new Set<string>());

	useEffect(() => {
		return window.piDesktop.agents.onUiRequest((request: AgentUiRequest) => {
			if (request.method === "login_flow") {
				setProviderId(request.loginProviderId);
				if (request.loginStatus === "succeeded") {
					showNotice(t("auth.loginSucceeded"));
					openedUrls.current.clear();
					setUrl(undefined);
					setLaunchUrl(undefined);
					setInstructions(undefined);
					setPrompt(null);
				} else if (request.loginStatus === "failed") {
					showNotice(request.error ?? t("auth.loginFailed"), 6000, "error");
					// 失败后必须收起 auth URL，否则浮层会停在「请完成授权」的旧地址上。
					openedUrls.current.clear();
					setUrl(undefined);
					setLaunchUrl(undefined);
					setInstructions(undefined);
					setPrompt(null);
				} else {
					// 新一次登录：清掉上一次的 URL 与去重记录，允许重新自动打开。
					openedUrls.current.clear();
					setUrl(undefined);
					setLaunchUrl(undefined);
					setInstructions(undefined);
					setPrompt(null);
				}
				return;
			}

			// 非登录流程的 open_url 不归本组件：通用 UI 路由会忽略它（历史行为），
			// 这里也不能擅自打开任意扩展 URL。
			if (request.method === "open_url") {
				if (!request.loginFlow) return;
				const target = request.launchUrl || request.url;
				setUrl(request.url);
				setLaunchUrl(request.launchUrl);
				setInstructions(request.instructions);
				setProviderId(request.loginProviderId);
				if (target && !openedUrls.current.has(target)) {
					openedUrls.current.add(target);
					openInSystemBrowser(target);
				}
				return;
			}

			if (
				request.loginFlow &&
				(request.method === "input" ||
					request.method === "select" ||
					request.method === "confirm" ||
					request.method === "editor")
			) {
				setPrompt({
					agentId: request.agentId,
					requestId: request.requestId,
					method: request.method,
					title: request.title || t("auth.loginPastePrompt"),
					placeholder: request.placeholder,
					options: request.options,
				});
				setInput("");
			}
		});
	}, []);

	const respond = async (value?: string, cancelled = false) => {
		if (!prompt) return;
		setBusy(true);
		try {
			await window.piDesktop.agents.sendUiResponse(
				prompt.agentId,
				prompt.requestId,
				cancelled
					? { cancelled: true }
					: prompt.method === "confirm"
						? { confirmed: value === "yes" }
						: { value: value ?? input },
			);
			if (!cancelled) {
				setPrompt(null);
				setInput("");
			}
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 5000, "error");
		} finally {
			setBusy(false);
		}
	};

	const target = launchUrl || url;
	const open = Boolean(target || prompt);

	return (
		<Modal
			open={open}
			onClose={() => {
				if (prompt) void respond(undefined, true);
				else {
					setUrl(undefined);
					setLaunchUrl(undefined);
					setInstructions(undefined);
				}
			}}
			title={t("auth.loginTitle", { provider: providerId ?? "" })}
			size="small"
		>
			<div className="native-login">
				{target && (
					<>
						<p className="native-login-desc">
							{t("auth.loginBrowserHint")}
						</p>
						<code className="native-login-url">{target}</code>
						<div className="native-login-actions">
							<Button
								buttonSize="sm"
								variant="primary"
								onClick={() => openInSystemBrowser(target)}
							>
								<ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
								{t("auth.openBrowser")}
							</Button>
							<Button
								buttonSize="sm"
								onClick={() => void writeClipboard(target)}
							>
								<Copy size={14} strokeWidth={2} aria-hidden="true" />
								{t("auth.copyLink")}
							</Button>
						</div>
						{instructions && (
							<p className="native-login-instructions">{instructions}</p>
						)}
					</>
				)}

				{prompt && prompt.method === "select" && prompt.options?.length ? (
					<div className="native-login-actions">
						{prompt.options.map((option) => (
							<Button
								key={option}
								buttonSize="sm"
								disabled={busy}
								onClick={() => void respond(option)}
							>
								{option}
							</Button>
						))}
					</div>
				) : prompt?.method === "confirm" ? (
					<div className="native-login-actions">
						<Button buttonSize="sm" disabled={busy} onClick={() => void respond("yes")}>
							{t("common.confirm")}
						</Button>
						<Button buttonSize="sm" variant="ghost" disabled={busy} onClick={() => void respond("no")}>
							{t("common.cancel")}
						</Button>
					</div>
				) : prompt ? (
					<div className="native-login-prompt">
						<strong>{prompt.title}</strong>
						<TextField
							label={t("auth.loginInputLabel")}
							value={input}
							placeholder={prompt.placeholder ?? t("auth.loginPastePlaceholder")}
							onChange={setInput}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !busy) void respond(input);
							}}
						/>
						<div className="native-login-actions">
							<Button
								buttonSize="sm"
								variant="primary"
								disabled={busy || !input.trim()}
								onClick={() => void respond(input)}
							>
								{t("auth.loginSubmit")}
							</Button>
							<Button
								buttonSize="sm"
								variant="ghost"
								disabled={busy}
								onClick={() => void respond(undefined, true)}
							>
								{t("common.cancel")}
							</Button>
						</div>
					</div>
				) : null}
			</div>
		</Modal>
	);
}
