/**
 * pi 内置 provider 的 per-model api 路由。
 *
 * 背景：pi 0.80.x 对内置 provider（如 commandcode）按 model id 选端点，而
 * `models.json` 里的 provider 级别 `api` 字段被忽略。这意味着 OmpDeck 的
 * 「测试连接」如果只看用户写的 `api`，会与实际会话去打不同的端点：测试 200、
 * 会话 400/404（典型：deepseek-v4-flash 在 commandcode 走 `/v1/responses`，
 * 用户配 `api: openai-completions` 让测试去 `/v1/chat/completions`）。
 *
 * 范围控制：仅 hardcode 已知会出问题的内置 provider + 关键路由。其它内置
 * provider 的路由不在此表，返回 undefined 让探测继续用 `apiType` 字段
 * （行为与改前一致）。待 kdl 抽取工具稳定后再扩到全集。
 *
 * 数据源（截至 pi 0.80.10，command-code@1.67.0）：
 * - runtime/behavior.kdl `api-routes provider="commandcode"`
 *   default=openai-completions；prefix claude- → anthropic-messages；
 *   exact 列表 → openai-responses（含 deepseek/deepseek-v4-flash、
 *   deepseek/deepseek-v4.1-flash、meta/muse-spark-1.3-contributor 等）。
 */

export type BuiltinApiRouteApi =
	| "anthropic-messages"
	| "openai-codex-responses"
	| "openai-completions"
	| "openai-responses"
	| "google-generative-ai"
	| "mistral-conversations";

interface BuiltinApiRouteTable {
	default: BuiltinApiRouteApi;
	prefixRoutes?: Record<string, BuiltinApiRouteApi>;
	exactRoutes?: Record<string, BuiltinApiRouteApi>;
}

const BUILTIN_PROVIDER_API_ROUTES: Record<string, BuiltinApiRouteTable> = {
	commandcode: {
		default: "openai-completions",
		prefixRoutes: { "claude-": "anthropic-messages" },
		exactRoutes: {
			"deepseek/deepseek-v4-flash": "openai-responses",
			"deepseek/deepseek-v4-flash-vision-exp": "openai-responses",
			"deepseek/deepseek-v4-pro": "openai-responses",
			"deepseek/deepseek-v4.1-flash": "openai-responses",
			"deepseek/deepseek-v4.1-flash-fast": "openai-responses",
			"moonshotai/Kimi-K3": "openai-responses",
			"z-ai/glm-5.3-flash": "openai-responses",
			"z-ai/glm-5.3-flashx": "openai-responses",
			"zai-org/GLM-5.2": "openai-responses",
			"zai-org/GLM-5.3": "openai-responses",
			"google/gemini-3.1-flash-lite": "openai-responses",
			"google/gemini-3.5-flash": "openai-responses",
			"google/gemini-3.5-flash-lite": "openai-responses",
			"google/gemini-3.6-flash": "openai-responses",
			"google/gemini-3.8-flash": "openai-responses",
			"MiniMaxAI/MiniMax-M3": "openai-responses",
			"stepfun/Step-5-Preview": "openai-responses",
			"xai/grok-4.5": "openai-responses",
			"xai/grok-4.6": "openai-responses",
			"xai/grok-4.7": "openai-responses",
			"meta/muse-spark-1.1": "openai-responses",
			"meta/muse-spark-1.2": "openai-responses",
			"meta/muse-spark-1.2-contributor": "openai-responses",
			"meta/muse-spark-1.3": "openai-responses",
			"meta/muse-spark-1.3-contributor": "openai-responses",
			"stealth/pixel-canary": "openai-responses",
			"sakana/fugu-ultra": "openai-responses",
		},
	},
};

/**
 * 内置 provider 的 model → api 路由查表。返回 undefined 表示该 provider 不在
 * 内置表里，调用方应回退到用户配置的 `apiType` 字段。
 */
export function lookupBuiltinApiRoute(
	providerName: string,
	modelId: string,
): BuiltinApiRouteApi | undefined {
	const table = BUILTIN_PROVIDER_API_ROUTES[providerName];
	if (!table) return undefined;
	if (table.exactRoutes && table.exactRoutes[modelId]) return table.exactRoutes[modelId];
	if (table.prefixRoutes) {
		for (const [prefix, api] of Object.entries(table.prefixRoutes)) {
			if (modelId.startsWith(prefix)) return api;
		}
	}
	return table.default;
}
