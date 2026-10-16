/**
 * 终端 Dock 回放缓冲（TerminalDock 里的 buffersRef）的有界化。
 *
 * 背景：每个 tab 的 PTY 输出会被累积成一个大字符串，用途只有两个——切回 tab 时重放、
 * 新建终端时的初始回放缓冲。跑了几十分钟、输出几百 MB 的构建/日志进程会让渲染进程驻留
 * 同量级的字符串，最终 render-process-gone(oom)。这里把缓冲收敛成固定上限的「尾部窗口」。
 *
 * 为什么只保留尾部：终端用户关心的永远是最近输出（提示符、报错、进度），头部是历史噪音；
 * 想完整保留就必须付出与输出总量同量级的内存，等于没设上限。
 *
 * 为什么必须按行边界（而不是按字节/字符硬切）：xterm.write 是增量解析 ANSI 转义序列的，
 * 从序列中间切开会把参数残片当可打印字符渲染（例如 `\x1b[38;2;` 被切掉后屏幕出现 `2;255;0m`），
 * 所以截断点只能落在 `\n` 之后——这样保留区的第一行必然是完整行，也不可能落在转义序列内部。
 */

/**
 * 单 tab 回放缓冲上限（UTF-16 code unit 计）。
 * 256Ki 字符 ≈ 512KB 堆内存/tab，8 个 tab 约 4MB，量级安全；同时足够回看最近几屏到几十屏输出。
 */
export const TERMINAL_SCROLLBACK_MAX_CHARS = 256 * 1024;

const ESC = "\u001b";

/** xterm 的 LF 只换行不回车（convertEol 默认 false），重放提示行要显式写 CRLF，否则提示文字会呈阶梯状 */
const NOTICE_SUFFIX = "\r\n";

/**
 * 找 >= target 的第一个「安全起点」：从这里开始保留尾部。
 * - 首选 `\n` 之后：保留区从完整行开头起，天然不可能落在转义序列中间；
 * - 尾部整段没有换行时（单行超长输出，例如 spinner / 进度条反复 `\r` 重绘），退化为从最近的
 *   ESC 重新开始：ESC 一定是完整转义序列的开头，xterm 从这里解析不会串位；
 * - 连 ESC 都没有时只能按字符切。
 */
function findSafeStart(text: string, target: number): number {
	const lineBreak = text.indexOf("\n", target);
	// lineBreak 正好是最后一个字符时保留区为空，等于丢光缓冲，此时继续走下面的兜底
	if (lineBreak !== -1 && lineBreak + 1 < text.length) return lineBreak + 1;
	const escape = text.indexOf(ESC, target);
	if (escape !== -1) return escape;
	// 兜底路径只剩字符切分：不能落在 UTF-16 代理对中间（高位 D800-DBFF + 低位 DC00-DFFF 是一个字符），
	// 否则中文、emoji 会在保留区开头变成半个字符（半个代理对）。
	const before = target > 0 ? text.charCodeAt(target - 1) : 0;
	const after = text.charCodeAt(target);
	const splitsSurrogatePair =
		before >= 0xd800 &&
		before <= 0xdbff &&
		after >= 0xdc00 &&
		after <= 0xdfff;
	return splitsSurrogatePair ? target + 1 : target;
}

/**
 * 超过上限时只保留尾部（必要时在最前面补一行截断提示），未超过时原样返回（同一引用，不拷贝）。
 * @param notice 截断提示文案（调用方传 i18n 文案）；空串表示不补提示。
 */
export function trimScrollback(text: string, notice = ""): string {
	// 先摘掉上一次截断留下的提示行，保证反复截断不会把提示叠加成多行
	const noticePrefix = notice + NOTICE_SUFFIX;
	const body =
		notice && text.startsWith(noticePrefix)
			? text.slice(noticePrefix.length)
			: text;
	if (body.length <= TERMINAL_SCROLLBACK_MAX_CHARS) return text;
	const keep = body.slice(
		findSafeStart(body, body.length - TERMINAL_SCROLLBACK_MAX_CHARS),
	);
	return notice ? notice + NOTICE_SUFFIX + keep : keep;
}

/**
 * 三个写入点（初始回放缓冲 / onData / onExit）统一走这里：追加 + 有界尾部截断。
 * 各写一遍拼接会漏掉截断（这正是 OOM 的成因），所以只保留这一个入口。
 */
export function appendScrollback(
	current: string,
	chunk: string,
	notice = "",
): string {
	return trimScrollback(current + chunk, notice);
}
