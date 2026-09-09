import {
	ensureOpenAiVersionPath,
	needsSessionBaseUrlVersionHint,
	suggestNormalizedBaseUrl,
} from "./baseUrlPath";

/**
 * provider 探测纯层（候选 4 收尾）：构造 URL + 解析响应 + 文案选择规则。
 * 从 ConfigManager 抽出——原 450 行 5 方言 + 硬编码 SDK UA 全部在此，零测试。
 *
 * 不变式：
 * 1. 零 Electron 依赖（无 net.fetch）：发射/超时仍在 ConfigManager 薄壳；
 * 2. 错误文案（含"超时不等于不兼容"）是纯函数 `connectionErrorMessage`，
 *    不再藏在 try/catch 里；
 * 3. SDK 默认 UA 规则（自定义 UA 透传 vs SDK 默认注入）与原实现逐字一致。
 */

export type NormalizedApiType =
	| "anthropic-messages"
	| "openai-codex-responses"
	| "openai-completions"
	| "openai-responses"
	| "google-generative-ai"
	| "mistral-conversations";

export interface ProbeRequest {
	url: string;
	headers: Record<string, string>;
	method?: "GET" | "POST";
	body?: string;
}

export interface ProbeTestResult {
	success: boolean;
	model?: string;
	snippet?: string;
	tokens?: { input?: number; output?: number };
	latencyMs?: number;
	error?: string;
	requestUrl?: string;
	requestBody?: string;
	/** 检测侧补了 /v1，配置仍是根路径 → 会话侧可能失败 */
	sessionBaseUrlNeedsVersion?: boolean;
	/** 建议写入配置的 baseUrl；仅 success 时由 UI 自动改写 */
	suggestedBaseUrl?: string;
}

export function normalizeApiType(apiType?: string): NormalizedApiType {
	switch (apiType) {
		case "anthropic":
		case "anthropic-messages":
			return "anthropic-messages";
		case "openai-codex-responses":
			return "openai-codex-responses";
		case "openai-chat-completions":
			// 兼容早期 pi-desktop 暴露过的别名；pi 官方 registry 名称是 openai-completions。
			return "openai-completions";
		case "openai-completions":
		case "openai-responses":
		case "google-generative-ai":
		case "mistral-conversations":
			return apiType;
		default:
			return "openai-completions";
	}
}

/**
 * 确保 OpenAI 兼容 API 的基础 URL 包含 /v1 版本路径。
 * 仅用于「获取模型 / 测试连接」；pi 会话不会走此补齐。
 */
export function ensureVersionPath(baseUrl: string): string {
	return ensureOpenAiVersionPath(baseUrl);
}

export function googleModelPath(modelId: string): string {
	return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
}

export function normalizeRequestHeaders(headers?: Record<string, string>): Record<string, string> {
	if (!headers) return {};
	return Object.fromEntries(
		Object.entries(headers).filter(
			([key, value]) =>
				key.trim().length > 0 && typeof value === "string",
		),
	);
}

export function withOpenAiSdkUserAgent(headers: Record<string, string>): Record<string, string> {
	const hasUserAgent = Object.keys(headers).some(
		(key) => key.toLowerCase() === "user-agent",
	);
	// pi 的 openai-responses provider 走 OpenAI JS SDK。部分代理会按 SDK
	// 默认 User-Agent 拦截请求，所以配置检测需要模拟该默认值，避免“检测通过、会话 403”。
	return hasUserAgent ? headers : { ...headers, "User-Agent": "OpenAI/JS 6.26.0" };
}

export function withAnthropicSdkUserAgent(headers: Record<string, string>): Record<string, string> {
	const hasUserAgent = Object.keys(headers).some(
		(key) => key.toLowerCase() === "user-agent",
	);
	// pi 的 anthropic-messages provider 走 Anthropic SDK。部分服务会验证
	// User-Agent 避免非官方客户端，所以需要模拟 SDK 的默认值。
	return hasUserAgent ? headers : { ...headers, "User-Agent": "anthropic-sdk-typescript/0.27.3" };
}

export function redactSecret(value: string, apiKey: string): string {
	if (!apiKey) return value;
	return value.split(apiKey).join("***");
}

/**
 * 根据 API 类型构造获取模型列表的 URL 列表（含优先路径和回退路径）。
 *
 * 各厂商获取模型列表的支持情况：
 *
 * | API 类型 | 优先路径 | 回退路径 |
 * |----------|---------|---------|
 * | OpenAI Chat Completions | /v1/models | /models |
 * | OpenAI Responses / Codex | /v1/models | /models |
 * | Anthropic Messages | /v1/models | /models |
 * | Google Gemini | /v1beta/models | - |
 * | Mistral Conversations | /v1/models | /models |
 *
 * OpenAI 生态（Chat Completions / Responses / Codex / Mistral）统一通过
 * GET /v1/models 获取模型列表。
 * 虽然 Anthropic 官方未公开 models 端点，但大部分兼容 Anthropic 协议的
 * 第三方网关同样支持 /v1/models。优先尝试 /v1/models，再回退到 /models。
 * Google Gemini 使用独立的 /v1beta/models。
 */
export function buildModelsRequest(
	baseUrl: string,
	apiKey: string,
	apiType?: string,
	requestHeaders?: Record<string, string>,
): ProbeRequest[] {
	const api = normalizeApiType(apiType);
	const extraHeaders = normalizeRequestHeaders(requestHeaders);

	if (api === "google-generative-ai") {
		// Google Gemini：使用独立的 v1beta 路径
		const u = baseUrl.replace(/\/+$/, "");
		const needsPrefix = !/[/]v\d+(alpha|beta)?$/.test(u);
		const versioned = needsPrefix ? `${u}/v1beta` : u;
		return [{
			url: `${versioned}/models?key=${encodeURIComponent(apiKey)}`,
			headers: { ...extraHeaders, "Content-Type": "application/json" },
		}];
	}

	if (api === "anthropic-messages") {
		// Anthropic：优先尝试 /v1/models（兼容大部分第三方网关），
		// 再回退到 /models（原生 Anthropic API 或旧实现）
		const u = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
		const headers = withAnthropicSdkUserAgent({
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
			...extraHeaders,
		});
		const primaryUrl = `${u}/v1/models`;
		const fallbackUrl = `${u}/models`;
		return primaryUrl === fallbackUrl
			? [{ url: primaryUrl, headers }]
			: [
				{ url: primaryUrl, headers },
				{ url: fallbackUrl, headers },
			];
	}

	// OpenAI 兼容 API（Chat Completions / Responses / Codex / Mistral）：
	// 优先尝试 ensureVersionPath 补齐后的路径，再回退到原始 baseUrl + /models
	const headers = withOpenAiSdkUserAgent({
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		...extraHeaders,
	});
	const u = baseUrl.replace(/\/+$/, "");
	const primaryUrl = `${ensureVersionPath(baseUrl)}/models`;
	const fallbackUrl = `${u}/models`;

	return primaryUrl === fallbackUrl
		? [{ url: primaryUrl, headers }]
		: [
			{ url: primaryUrl, headers },
			{ url: fallbackUrl, headers },
		];
}

export function parseModelsResponse(
	body: Record<string, unknown>,
	apiType?: string,
): Array<{ id: string; name?: string }> {
	const api = normalizeApiType(apiType);
	const rawData = Array.isArray(body.data) ? body.data : Array.isArray(body)
		? body
		: body.models && Array.isArray(body.models)
			? body.models
			: [];

	return (rawData as Array<Record<string, unknown>>)
		.map((model) => {
			const rawId =
				typeof model.id === "string"
					? model.id
					: typeof model.name === "string"
						? model.name
						: "";
			const id =
				api === "google-generative-ai"
					? rawId.replace(/^models\//, "")
					: rawId;
			const name =
				typeof model.displayName === "string"
					? model.displayName
					: typeof model.name === "string"
						? model.name.replace(/^models\//, "")
						: id;
			return { id, name };
		})
		.filter((model) => model.id.length > 0);
}

export function buildTestRequest(
	baseUrl: string,
	apiKey: string,
	modelId: string,
	apiType: string,
	requestHeaders?: Record<string, string>,
): { url: string; headers: Record<string, string>; body: string } {
	const api = normalizeApiType(apiType);
	const extraHeaders = normalizeRequestHeaders(requestHeaders);

	switch (api) {
		case "openai-responses":
		case "openai-codex-responses":
			return {
				url: `${ensureVersionPath(baseUrl)}/responses`,
				headers: withOpenAiSdkUserAgent({
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					...extraHeaders,
				}),
				body: JSON.stringify({
					model: modelId,
					// 连接测试只验证接口是否可调用，不测试推理或工具能力；极短输入能减少
					// reasoning 模型的思考时间，避免把慢响应误判为兼容模式不可用。
					input: "Hi",
					max_output_tokens: 1,
				}),
			};

		case "anthropic-messages":
			// Anthropic Messages API 的聊天端点在 /v1/messages
			// 自动补齐 v1（Anthropic 文档示例：https://api.anthropic.com/v1/messages）
			return {
				url: `${ensureVersionPath(baseUrl)}/messages`,
				headers: withAnthropicSdkUserAgent({
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json",
					...extraHeaders,
				}),
				body: JSON.stringify({
					model: modelId,
					messages: [{ role: "user", content: "Hi" }],
					// 部分代理与 Claude 模型对 max_tokens 有最低要求，设为 10 避免 400/404。
					max_tokens: 10,
				}),
			};

		case "google-generative-ai":
			// Gemini 的 API key 作为查询参数
			// 自动补齐 v1beta（如果 baseUrl 不包含版本路径）
			// Google 文档示例：https://generativelanguage.googleapis.com/v1beta
			{
				const u = baseUrl.replace(/\/+$/, "");
				const needsPrefix = !/[/]v\d+(alpha|beta)?$/.test(u);
				const versioned = needsPrefix ? `${u}/v1beta` : u;
				return {
					url: `${versioned}/${googleModelPath(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
					headers: {
						"Content-Type": "application/json",
						...extraHeaders,
					},
					body: JSON.stringify({
						contents: [
							{
								role: "user",
								parts: [{ text: "Hi" }],
							},
						],
						generationConfig: { maxOutputTokens: 1 },
					}),
				};
			}

		case "mistral-conversations":
			return {
				url: `${baseUrl.replace(/\/+$/, "")}/conversations`,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					...extraHeaders,
				},
				body: JSON.stringify({
					model: modelId,
					inputs: "Hi",
					store: false,
				}),
			};

		default:
			// openai-completions 是 pi 官方名称，对应 OpenAI Chat Completions 接口。
			return {
				url: `${ensureVersionPath(baseUrl)}/chat/completions`,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					...extraHeaders,
				},
				body: JSON.stringify({
					model: modelId,
					// Chat Completions 兼容网关常接入 reasoning 模型，测试时只要拿到
					// 一个最小响应即可，不要求完整回答，降低超时和 token 消耗。
					messages: [{ role: "user", content: "Hi" }],
					max_tokens: 1,
				}),
			};
	}
}

/**
 * 连接测试的错误文案选择规则（纯函数）：区分超时（AbortError）与其它错误。
 * 超时文案明确"超时不等于不兼容"，避免误导用户改错配置。
 */
export function connectionErrorMessage(
	error: unknown,
	timeoutSeconds: number,
): string {
	const msg =
		error instanceof Error
			? error.name === "AbortError"
				? `请求超时（${timeoutSeconds} 秒）。这不一定代表兼容模式不支持或配置错误，可能是模型首包较慢、上游排队、代理/网络波动，或 reasoning 模型仍在内部思考。请稍后重试，或换用更轻量模型测试；如果模型列表可正常拉取，也可以保存配置后直接启动会话验证。`
				: error.message
			: String(error);
	return msg;
}

/**
 * 从连接测试的 HTTP 错误体提取诊断后缀（纯函数）。
 */
export function extractHttpErrorDetail(
	errBody: Record<string, unknown>,
): string {
	const errMsg =
		(errBody.error as Record<string, unknown>)?.message ??
		errBody.message ??
		"";
	return errMsg ? ` — ${String(errMsg)}` : "";
}

/**
 * 根据 API 类型从响应中提取模型名、文本片段和 token 用量。
 */
export function parseTestResponse(
	body: Record<string, unknown>,
	modelId: string,
	apiType: string,
): { model: string; snippet: string; tokens?: { input?: number; output?: number } } {
	const api = normalizeApiType(apiType);
	switch (api) {
		case "openai-completions": {
			const choices = body.choices as Array<Record<string, unknown>> | undefined;
			const text = (choices?.[0]?.text as string) ?? "(空响应)";
			const usage = body.usage as Record<string, unknown> | undefined;
			return {
				model: (body.model as string) ?? modelId,
				snippet: text,
				tokens: {
					input: usage?.prompt_tokens as number | undefined,
					output: usage?.completion_tokens as number | undefined,
				},
			};
		}

		case "openai-responses":
		case "openai-codex-responses": {
			const output = body.output as Array<Record<string, unknown>> | undefined;
			const content = output?.[0]?.content as Array<Record<string, unknown>> | undefined;
			const functionCall = output?.find(
				(item) => item.type === "function_call",
			);
			const text =
				(content?.[0]?.text as string | undefined) ??
				(functionCall
					? `工具调用兼容：${String(functionCall.name ?? "function_call")}`
					: "(空响应)");
			const usage = body.usage as Record<string, unknown> | undefined;
			return {
				model: (body.model as string) ?? modelId,
				snippet: text,
				tokens: {
					input: usage?.input_tokens as number | undefined,
					output: usage?.output_tokens as number | undefined,
				},
			};
		}

		case "anthropic-messages": {
			const content = body.content as Array<Record<string, unknown>> | undefined;
			const text = (content?.[0]?.text as string) ?? "(空响应)";
			const usage = body.usage as Record<string, unknown> | undefined;
			return {
				model: (body.model as string) ?? modelId,
				snippet: text,
				tokens: {
					input: usage?.input_tokens as number | undefined,
					output: usage?.output_tokens as number | undefined,
				},
			};
		}

		case "google-generative-ai": {
			const candidates = body.candidates as Array<Record<string, unknown>> | undefined;
			const parts = candidates?.[0]?.content as Record<string, unknown> | undefined;
			const text = (parts?.parts as Array<Record<string, unknown>>)?.[0]?.text as string ?? "(空响应)";
			const usage = body.usageMetadata as Record<string, unknown> | undefined;
			return {
				model: (body.modelVersion as string) ?? modelId,
				snippet: text,
				tokens: {
					input: usage?.promptTokenCount as number | undefined,
					output: usage?.candidatesTokenCount as number | undefined,
				},
			};
		}

		case "mistral-conversations": {
			const outputs = body.outputs as Array<Record<string, unknown>> | undefined;
			const firstOutput = outputs?.[0];
			const content = firstOutput?.content;
			const text = Array.isArray(content)
				? content
					.map((item) =>
						item && typeof item === "object"
							? String((item as Record<string, unknown>).text ?? "")
							: String(item ?? ""),
					)
					.filter(Boolean)
					.join(" ")
				: typeof content === "string"
					? content
					: (body.response as string | undefined) ?? "(空响应)";
			const usage = body.usage as Record<string, unknown> | undefined;
			return {
				model: (body.model as string) ?? modelId,
				snippet: text,
				tokens: {
					input: usage?.prompt_tokens as number | undefined,
					output: usage?.completion_tokens as number | undefined,
				},
			};
		}

		default:
			// openai-chat-completions
		{
			const choices = body.choices as Array<Record<string, unknown>> | undefined;
			const message = choices?.[0]?.message as Record<string, unknown> | undefined;
			const text = (message?.content as string) ?? "(空响应)";
			const usage = body.usage as Record<string, unknown> | undefined;
			return {
				model: (body.model as string) ?? modelId,
				snippet: text,
				tokens: {
					input: usage?.prompt_tokens as number | undefined,
					output: usage?.completion_tokens as number | undefined,
				},
			};
		}
	}
}

/**
 * 连接测试前置建议：检测用了补齐路径、配置仍是根路径时给出建议 baseUrl。
 */
export function sessionBaseUrlHint(
	baseUrl: string,
	requestUrl: string,
	api: string,
): { needsVersion: boolean; suggestedBaseUrl?: string } {
	return {
		needsVersion: needsSessionBaseUrlVersionHint(baseUrl, requestUrl),
		suggestedBaseUrl: suggestNormalizedBaseUrl(baseUrl, requestUrl, api) ?? undefined,
	};
}

/**
 * 诊断字段脱敏（统一收口 apiKey，避免每个返回点各自 redact）。
 */
export function redactDiagnostics(
	value: string,
	apiKey: string,
): string {
	return redactSecret(value, apiKey);
}
