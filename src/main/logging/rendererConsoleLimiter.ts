/**
 * renderer console 转发限流（纯逻辑，不依赖 Electron / appLogger，便于单测）。
 *
 * 背景：主窗口 renderer 的 console warning/error 会经 `console-message` 转发到主进程日志。
 * KaTeX 严格模式告警这类噪音会在流式渲染期间反复出现（含中文/全角标点的 `$...$` 文本，
 * 每个字符一条 `Unicode text character "X" used in math mode`），旧实现按
 * `level + message.slice(0,120)` 做 key，字符一变就是新 key，结果同一类告警逐条落盘刷屏。
 *
 * 这里做三件事（`record()` 返回的处置由调用方翻译成日志）：
 * 1. key 归一化：抹平消息里引号/尖括号包裹的具体字符，同类告警聚合到同一 key；
 * 2. 同 key 窗口内聚合：只落盘首条，第 `perKeyMax` 条补一条 repeated 标记；
 * 3. 窗口内**总量**上限：超过后不再逐条落盘，改为在窗口结束时记一条含 suppressed 计数的汇总。
 */

/** 一条 renderer console 事件里需要落盘 / 参与聚合的字段（Electron `console-message` 事件的子集）。 */
export interface RendererConsoleEntry {
	level: string;
	message: string;
	line?: number;
	sourceId?: string;
}

/** 限流器给出的处置：调用方按顺序翻译成 appLogger 调用即可。 */
export type RendererConsoleEvent =
	/** 落盘首条：`level/message/line/sourceId` 原样写入 detail。 */
	| { type: "entry"; entry: RendererConsoleEntry }
	/** 同 key 在窗口内第 `perKeyMax` 条：补一条 repeated 标记，之后静默。 */
	| { type: "repeated"; entry: RendererConsoleEntry; repeated: number }
	/** 窗口结束时的汇总：本窗口有 `suppressed` 条因超总量上限未逐条落盘。 */
	| { type: "suppressed-summary"; suppressed: number; total: number; windowMs: number };

export interface RendererConsoleLimiterOptions {
	/** 聚合窗口长度，默认 60s。 */
	windowMs?: number;
	/** 同 key 窗口内第几条补记 repeated，默认第 3 条。 */
	perKeyMax?: number;
	/** 窗口内允许逐条落盘的总条数上限，默认 30 条/分钟。 */
	windowTotalMax?: number;
}

/** 聚合窗口：保持旧实现行为（60s）。 */
const DEFAULT_WINDOW_MS = 60_000;
/** 同 key 窗口内第 3 条补记 repeated：保持旧实现行为。 */
const DEFAULT_PER_KEY_MAX = 3;
/**
 * 窗口内逐条落盘的总量上限，取 30 条/分钟：
 * 正常运行时 renderer console 的 warning/error 远低于此；一旦持续超过，
 * 说明是同一类噪音（如 KaTeX 逐字符告警）在重复，逐条落盘对定位问题没有增量价值，
 * 反而会淹没真实错误——此时只保留一条带计数的汇总。
 */
const DEFAULT_WINDOW_TOTAL_MAX = 30;
/** per-key 状态表过大时清理过期条目的阈值：保持旧实现行为。 */
const MAX_TRACKED_KEYS = 200;
/** 归一化后参与聚合的消息前缀长度：保持旧实现的 120 字符截断。 */
const MESSAGE_KEY_LENGTH = 120;

/**
 * 归一化 console 消息里“具体字符”的差异：KaTeX 严格告警形如
 * `LaTeX-incompatible input and strict mode is set to 'warn': Unicode text character "，" used in math mode`，
 * 每个字符一条消息、只有引号里的字符不同。把 ≤4 字符的引号/尖括号包裹内容抹成 `*`，
 * 使这类告警聚合到同一 key（更长的引号内容通常是真实上下文，保持原样以免把不同错误合并）。
 */
export function normalizeRendererConsoleMessage(message: string): string {
	return message
		.replace(/(["'`“”‘’])([^"'`“”‘’\n]{1,4})\1/g, "$1*$1")
		.replace(/<([^<>\n]{1,4})>/g, "<*>")
		.slice(0, MESSAGE_KEY_LENGTH);
}

/** 聚合 key：级别 + 归一化后的消息前缀。 */
export function rendererConsoleKey(entry: RendererConsoleEntry): string {
	return `${entry.level}:${normalizeRendererConsoleMessage(entry.message)}`;
}

interface KeyState {
	count: number;
	lastAt: number;
}

export class RendererConsoleLimiter {
	readonly #windowMs: number;
	readonly #perKeyMax: number;
	readonly #windowTotalMax: number;
	readonly #perKey = new Map<string, KeyState>();
	#windowStartedAt: number | null = null;
	#windowTotal = 0;
	#windowSuppressed = 0;

	constructor(options: RendererConsoleLimiterOptions = {}) {
		this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.#perKeyMax = options.perKeyMax ?? DEFAULT_PER_KEY_MAX;
		this.#windowTotalMax = options.windowTotalMax ?? DEFAULT_WINDOW_TOTAL_MAX;
	}

	/**
	 * 记一条事件，返回需要落盘的处置（可能同时含“上窗口汇总”与“本条事件”两条）。
	 * `now` 可注入，便于测试窗口边界。
	 */
	record(entry: RendererConsoleEntry, now: number = Date.now()): RendererConsoleEvent[] {
		const events: RendererConsoleEvent[] = [];
		if (this.#windowStartedAt === null) {
			this.#windowStartedAt = now;
		} else if (now - this.#windowStartedAt >= this.#windowMs) {
			// 窗口结束：若有被总量上限抑制的条目，先补一条汇总，再开启新窗口。
			// 汇总在下一条事件到达时落盘（应用持续有 console 事件，汇总不会丢失）。
			if (this.#windowSuppressed > 0) {
				events.push({
					type: "suppressed-summary",
					suppressed: this.#windowSuppressed,
					total: this.#windowTotal,
					windowMs: this.#windowMs,
				});
			}
			this.#windowStartedAt = now;
			this.#windowTotal = 0;
			this.#windowSuppressed = 0;
			// per-key 聚合状态随窗口一起重置，保证窗口过期后同一 key 重新落盘一条。
			this.#perKey.clear();
		}

		this.#windowTotal += 1;
		if (this.#windowTotal > this.#windowTotalMax) {
			// 超总量上限：不再逐条落盘，也不维护 per-key 计数，只在窗口结束时汇总一条。
			this.#windowSuppressed += 1;
			return events;
		}

		const key = rendererConsoleKey(entry);
		const agg = this.#perKey.get(key);
		if (agg && now - agg.lastAt < this.#windowMs) {
			agg.count += 1;
			agg.lastAt = now;
			if (agg.count === this.#perKeyMax) {
				events.push({ type: "repeated", entry, repeated: agg.count });
			}
			return events;
		}
		if (this.#perKey.size > MAX_TRACKED_KEYS) {
			for (const [trackedKey, state] of this.#perKey) {
				if (now - state.lastAt >= this.#windowMs) this.#perKey.delete(trackedKey);
			}
		}
		this.#perKey.set(key, { count: 1, lastAt: now });
		events.push({ type: "entry", entry });
		return events;
	}
}
