import assert from "node:assert/strict";
import { test } from "vitest";
import {
	normalizeRendererConsoleMessage,
	rendererConsoleKey,
	RendererConsoleLimiter,
	type RendererConsoleEntry,
	type RendererConsoleEvent,
} from "./rendererConsoleLimiter";

const WINDOW_MS = 60_000;
const BASE = 1_700_000_000_000;

function entry(message: string, level = "warning"): RendererConsoleEntry {
	return { level, message, line: 42, sourceId: "http://localhost/assets/index.js" };
}

/** KaTeX 严格模式告警（与 app 日志里的整行形态一致）：只有引号里的字符不同。 */
function katexWarning(char: string): string {
	return `LaTeX-incompatible input and strict mode is set to 'warn': Unicode text character "${char}" used in math mode [unicodeTextInMathMode]`;
}

function types(events: RendererConsoleEvent[]): string[] {
	return events.map((event) => event.type);
}

test("同消息窗口内聚合：首条落盘、第二条静默、第三条 repeated", () => {
	const limiter = new RendererConsoleLimiter();
	const message = "Cannot read properties of undefined (reading 'foo')";

	assert.deepEqual(types(limiter.record(entry(message), BASE)), ["entry"]);
	assert.deepEqual(limiter.record(entry(message), BASE + 1), []);
	const third = limiter.record(entry(message), BASE + 2);
	assert.deepEqual(types(third), ["repeated"]);
	assert.deepEqual(third[0], { type: "repeated", entry: entry(message), repeated: 3 });
	// 第 4、5 条静默，不再刷屏。
	assert.deepEqual(limiter.record(entry(message), BASE + 3), []);
	assert.deepEqual(limiter.record(entry(message), BASE + 4), []);
});

test("不同具体字符（KaTeX 逐字符告警）归一化后聚合到同一 key", () => {
	const comma = katexWarning("，");
	const period = katexWarning("。");
	const quote = katexWarning("<");
	// 真实日志整行超过 key 的 120 字符截断长度：说明归一化发生在截断之前，否则字符差异会落在截断窗口内。
	assert.ok(comma.length > 120);
	assert.equal(rendererConsoleKey(entry(comma)), rendererConsoleKey(entry(period)));
	assert.equal(rendererConsoleKey(entry(comma)), rendererConsoleKey(entry(quote)));

	const limiter = new RendererConsoleLimiter();
	assert.deepEqual(types(limiter.record(entry(comma), BASE)), ["entry"]);
	assert.deepEqual(limiter.record(entry(period), BASE + 1), []);
	assert.deepEqual(types(limiter.record(entry(quote), BASE + 2)), ["repeated"]);
});

test("key 归一化只抹平短引号/尖括号内容，长内容原样保留并截断到 120 字符", () => {
	assert.equal(
		normalizeRendererConsoleMessage('Unicode text character "，" used in math mode'),
		'Unicode text character "*" used in math mode',
	);
	assert.equal(normalizeRendererConsoleMessage("Unexpected token <x>"), "Unexpected token <*>");
	assert.equal(
		normalizeRendererConsoleMessage('Unrecognized node type "example"'),
		'Unrecognized node type "example"',
	);
	assert.equal(normalizeRendererConsoleMessage("x".repeat(300)).length, 120);
});

test("超窗口总量上限：不再逐条落盘，窗口结束时只出一条含 suppressed 的汇总", () => {
	const limiter = new RendererConsoleLimiter({ windowMs: WINDOW_MS, windowTotalMax: 3 });
	const messages = ["e1", "e2", "e3", "e4", "e5"];

	assert.deepEqual(types(limiter.record(entry(messages[0]), BASE)), ["entry"]);
	assert.deepEqual(types(limiter.record(entry(messages[1]), BASE + 1)), ["entry"]);
	assert.deepEqual(types(limiter.record(entry(messages[2]), BASE + 2)), ["entry"]);
	// 第 4、5 条超上限：完全不落盘，也不产生 repeated。
	assert.deepEqual(limiter.record(entry(messages[3]), BASE + 3), []);
	assert.deepEqual(limiter.record(entry(messages[4]), BASE + 4), []);

	// 窗口过期后的下一条事件先补汇总，再落盘自身。
	const atWindowEnd = BASE + WINDOW_MS;
	const events = limiter.record(entry("e6"), atWindowEnd);
	assert.deepEqual(types(events), ["suppressed-summary", "entry"]);
	assert.deepEqual(events[0], {
		type: "suppressed-summary",
		suppressed: 2,
		total: 5,
		windowMs: WINDOW_MS,
	});
	// 汇总只出一次：新窗口内继续静默。
	assert.deepEqual(limiter.record(entry("e6"), atWindowEnd + 1), []);
});

test("默认上限为 30 条/分钟：第 31 条起被抑制并计入汇总", () => {
	const limiter = new RendererConsoleLimiter();
	let loggedEntries = 0;
	for (let i = 0; i < 35; i++) {
		const events = limiter.record(entry(`noise-${i}`), BASE + i);
		loggedEntries += events.filter((event) => event.type === "entry").length;
	}
	assert.equal(loggedEntries, 30);

	const events = limiter.record(entry("noise-next"), BASE + WINDOW_MS);
	assert.deepEqual(types(events), ["suppressed-summary", "entry"]);
	assert.deepEqual(events[0], {
		type: "suppressed-summary",
		suppressed: 5,
		total: 35,
		windowMs: WINDOW_MS,
	});
});

test("窗口过期后聚合状态重置：同一 key 重新落盘首条（而不是继续静默）", () => {
	const limiter = new RendererConsoleLimiter();
	const message = "ResizeObserver loop completed with undelivered notifications.";

	assert.deepEqual(types(limiter.record(entry(message), BASE)), ["entry"]);
	assert.deepEqual(limiter.record(entry(message), BASE + 10), []);
	assert.deepEqual(types(limiter.record(entry(message), BASE + 20)), ["repeated"]);

	// 窗口过期（无抑制条目 → 不产生汇总），同一 key 重新算首条。
	const events = limiter.record(entry(message), BASE + WINDOW_MS);
	assert.deepEqual(types(events), ["entry"]);
});
