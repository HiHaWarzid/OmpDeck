import assert from "node:assert/strict";
import { test } from "vitest";
import {
	TERMINAL_SCROLLBACK_MAX_CHARS,
	appendScrollback,
	trimScrollback,
} from "./scrollbackBuffer";

const MAX = TERMINAL_SCROLLBACK_MAX_CHARS;
/** 测试固定文案；生产调用传 i18n 文案（terminal.scrollbackTruncated） */
const NOTICE = "[scrollback trimmed]";

/** 造 count 行等宽文本，用于验证「首个保留行是完整行」 */
function textLines(count: number, prefix = "line-"): string {
	let text = "";
	for (let index = 0; index < count; index += 1) {
		text += `${prefix}${String(index).padStart(6, "0")}\n`;
	}
	return text;
}

test("under the cap the text is returned unchanged", () => {
	const text = "\u001b[32mok\u001b[0m\ndone\n";
	// 字符串是原始值，等值即等价于「没有重新构造缓冲」
	assert.equal(trimScrollback(text), text);
	assert.equal(appendScrollback(text, "tail\n"), `${text}tail\n`);
	// 恰好等于上限也不截断（边界不抖动）
	const exact = "x".repeat(MAX);
	assert.equal(trimScrollback(exact), exact);
	// 未触发截断时不补提示行
	assert.equal(trimScrollback("short output", NOTICE), "short output");
});

test("over the cap keeps a complete tail and drops the head", () => {
	const text = textLines(60000);
	assert.ok(text.length > MAX);
	const kept = trimScrollback(text);
	assert.ok(kept.length <= MAX, `kept ${kept.length} <= ${MAX}`);
	// 首个保留行是完整行：行首 + 行尾换行都在
	assert.match(kept.slice(0, 12), /^line-\d{6}\n$/);
	// 只保留尾部：最后一行必须还在，头部行被丢弃
	assert.ok(kept.endsWith("line-059999\n"));
	assert.ok(!kept.includes("line-000000\n"));
	// 截断后仍是完整行序，没有被切走的半行（行首字符一定是 'l'）
	assert.equal(kept.indexOf("\n") > 0, true);
});

test("multi-byte characters are never split across the cut", () => {
	let text = "";
	for (let index = 0; index < 40000; index += 1) {
		text += `第${index}行 🙂 中文输出\n`;
	}
	assert.ok(text.length > MAX);
	const kept = trimScrollback(text);
	assert.ok(kept.length <= MAX);
	// encodeURIComponent 遇到孤立代理对（半个 emoji/生僻字）会抛 URIError
	assert.doesNotThrow(() => encodeURIComponent(kept));
	assert.match(kept.slice(0, 2), /^第/);
	assert.ok(kept.endsWith("中文输出\n"));
});

test("a long single line with no newline never trims to an empty buffer", () => {
	const text = "x".repeat(MAX + 4096);
	const kept = trimScrollback(text);
	assert.equal(kept.length, MAX);
	assert.equal(kept, text.slice(text.length - MAX));
	// 切点恰好落在最后一个 \n 的极端输入也不能丢光缓冲
	const keptWithTrailingBreak = trimScrollback(`${text}\n`);
	assert.ok(keptWithTrailingBreak.length > 0);
	assert.ok(keptWithTrailingBreak.endsWith("\n"));
});

test("without a line break the cut falls back to an escape-sequence boundary", () => {
	// spinner/进度条：反复 ESC[2K\r 重绘，整段没有 \n
	const frame = "\u001b[2K\rworking 42%";
	let text = "";
	while (text.length <= MAX + 1000) text += frame;
	const kept = trimScrollback(text);
	assert.ok(kept.length <= MAX);
	assert.equal(kept[0], "\u001b", "保留区必须从转义序列开头起");
	// 单个超长行里若插了 emoji 且切点落在代理对中间，也要整字符对齐
	const emoji = "😀";
	const wide = `head${emoji.repeat(MAX / 2 + 8)}`;
	const keptWide = trimScrollback(wide);
	assert.doesNotThrow(() => encodeURIComponent(keptWide));
	assert.ok(keptWide.length <= MAX);
});

test("the truncation notice is emitted once and never accumulates", () => {
	const text = textLines(60000);
	const once = trimScrollback(text, NOTICE);
	assert.ok(once.startsWith(`${NOTICE}\r\n`));
	assert.equal(once.split(NOTICE).length - 1, 1);
	// 反复截断（每次写入点都会跑一遍）不能让提示叠加
	const again = appendScrollback(once, "more\n", NOTICE);
	assert.equal(again.split(NOTICE).length - 1, 1);
	assert.ok(again.length <= MAX + NOTICE.length + 2);
});

test("append trims when the accumulated buffer passes the cap", () => {
	const base = "y".repeat(MAX - 4);
	const chunk = "z".repeat(64);
	const kept = appendScrollback(base, chunk);
	assert.ok(kept.length <= MAX);
	assert.ok(kept.endsWith("z".repeat(60)));
});
