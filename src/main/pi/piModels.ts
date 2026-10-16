/**
 * pi 模型目录读取（跨 pi 版本）。
 *
 * pi 18.10 起 `--list-models` 被移除，改为子命令 `models --json`：
 *   - 旧版：`omp --list-models`   → 表格 `provider model context max-out thinking images`
 *   - 新版：`omp models --json`   → `{ models: [{ provider, id, name, contextWindow, maxTokens,
 *                                     reasoning, thinking[], input[], ... }] }`
 *
 * 关键：新版把 `--list-models` 当未知参数处理——stdin 是打开的管道时 pi 会转入「读取 stdin 提示词」
 * 模式并永不退出（本机复现：6s 未退出被 SIGTERM，stderr 只有 `Error: unknown flag: --list-models`；
 * 应用侧 execFile 的 15s timeout 就是运行日志里那几条 "Failed to list models"）。
 * 所以不能猜命令、也不能靠版本号硬编码，必须先读 `--help` 再决定用哪条命令。
 */
import type { AvailableModel } from "../../shared/types";

/** 探测出的模型目录命令形态。 */
export type ModelListCommand = {
	/** json = `models --json`（新）；table = `--list-models`（旧）。 */
	mode: "json" | "table";
	args: string[];
};

/**
 * 从 `omp --help` 输出判断该版 pi 支持哪种模型目录命令。
 *
 * pi 的 help 里子命令与标志位都按行列出（`  models List, search, and refresh available models`
 * / `  --list-models ...`），因此按整行匹配，避免把 `--models=<pattern>`（Ctrl+P 循环用）
 * 误认成子命令。
 */
export function detectModelListCommand(helpText: string): ModelListCommand | undefined {
	if (/^\s*--list-models\b/m.test(helpText)) return { mode: "table", args: ["--list-models"] };
	// 子命令行：缩进 + `models` + 至少两个空格 + 说明（标志位行以 `-` 开头，不会命中）。
	if (/^\s+models\s{2,}\S/m.test(helpText)) return { mode: "json", args: ["models", "--json"] };
	return undefined;
}

/** 解析 `models --json` 输出。字段名与 models.yml 的 provider/id 保持一致，便于 set_model 直接使用。 */
export function parseModelsJson(stdout: string): AvailableModel[] {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch {
		return [];
	}
	const raw = (payload as { models?: unknown } | null)?.models;
	if (!Array.isArray(raw)) return [];

	const models: AvailableModel[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as {
			provider?: unknown;
			id?: unknown;
			name?: unknown;
			contextWindow?: unknown;
			reasoning?: unknown;
			thinking?: unknown;
			input?: unknown;
		};
		// provider + id 是 set_model 的入参，缺一不可解析（目录里存在 kind != chat 的条目）。
		if (typeof item.provider !== "string" || !item.provider) continue;
		if (typeof item.id !== "string" || !item.id) continue;

		const thinkingLevels = Array.isArray(item.thinking) ? item.thinking.length : 0;
		models.push({
			provider: item.provider,
			id: item.id,
			name: typeof item.name === "string" && item.name ? item.name : `${item.provider}/${item.id}`,
			...(typeof item.contextWindow === "number" ? { contextWindow: item.contextWindow } : {}),
			// pi 用 reasoning 布尔声明是否可思考，thinking[] 是可选档位；两者取或。
			reasoning: item.reasoning === true || thinkingLevels > 0,
			supportsImages: Array.isArray(item.input) && item.input.includes("image"),
		});
	}
	return models;
}

/** 解析旧版 `--list-models` 表格（首行表头，末两列 thinking/images）。 */
export function parseLegacyModelTable(stdout: string): AvailableModel[] {
	const lines = stdout.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) return [];
	const models: AvailableModel[] = [];
	for (const line of lines.slice(1)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3) continue;
		const provider = parts[0];
		const modelId = parts[1];
		// thinking 与 images 固定在末两列，中间的 context/max-out 可能含空格对齐。
		const thinking = parts[parts.length - 2]?.toLowerCase() === "yes";
		models.push({
			provider,
			id: modelId,
			name: `${provider}/${modelId}`,
			reasoning: thinking,
			supportsImages: parts[parts.length - 1]?.toLowerCase() === "yes",
		});
	}
	return models;
}
