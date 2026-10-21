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
 * 所以截断点优先落在 `\n` 之后——这样保留区的第一行必然是完整行；整段没有换行时退回
 * 最近的 ESC（见 findSafeStart），保证不会从转义序列中间开始解析。
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
 * 单块存储上限：主进程一次性送来的回放缓冲（切回会话时）可能远超上限，
 * 若整段存成一块，淘汰时只能整块丢弃或整块切片，退化成 O(总长)。
 * 切成固定大小的块后，淘汰只碰头块，单次 push 的成本与块大小（常数）相关。
 */
const CHUNK_PIECE_MAX_CHARS = 8 * 1024;

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
 *
 * 注意：这是「纯字符串」形式，每次调用都要拼接 + 切片整段（O(总长)）。
 * 生产路径（TerminalDock）请用下面的 ScrollbackBuffer，它把追加成本降到 O(chunk)；
 * 这个函数保留给需要一次性归一化的场景与单测。
 */
export function appendScrollback(
	current: string,
	chunk: string,
	notice = "",
): string {
	return trimScrollback(current + chunk, notice);
}

/**
 * 分块存储的回放缓冲：追加 O(chunk) 摊销，只有 getText() 时才拼接。
 *
 * 旧的 appendScrollback 每次 onData 都做 `current + chunk` 再 slice，成本随缓冲总长增长，
 * 高吞吐构建日志下主线程被反复整段拷贝拖慢。这里改为「块数组 + 整块淘汰」：
 * - 追加只 push 新块（大块先按固定大小切开），不碰已有内容；
 * - 超过上限时从头部整块丢弃，只在块边界仍超限时才对头块做一次安全起点裁剪。
 */
export class ScrollbackBuffer {
	private chunks: string[] = [];
	/** 第一块有效块的下标；避免 shift() 造成 O(块数) 拷贝。 */
	private headIndex = 0;
	/** 有效内容的 UTF-16 长度，不含截断提示行。 */
	private length = 0;
	private notice = "";
	private truncated = false;

	append(chunk: string, notice = ""): void {
		// 提示文案随语言切换更新，但空串不能覆盖已有文案（裁剪发生后才需要它）
		if (notice) this.notice = notice;
		if (!chunk) return;

		// 超大块（主进程一次性回放）先切成固定大小的块，否则它永远无法被局部淘汰
		if (chunk.length <= CHUNK_PIECE_MAX_CHARS) {
			this.chunks.push(chunk);
			this.length += chunk.length;
		} else {
			for (let offset = 0; offset < chunk.length; offset += CHUNK_PIECE_MAX_CHARS) {
				const piece = chunk.slice(offset, offset + CHUNK_PIECE_MAX_CHARS);
				this.chunks.push(piece);
				this.length += piece.length;
			}
		}

		if (this.length > TERMINAL_SCROLLBACK_MAX_CHARS) this.evictOverflow();
	}

	getText(): string {
		const liveChunks = this.chunks.length - this.headIndex;
		const body =
			liveChunks <= 0
				? ""
				: liveChunks === 1
					? this.chunks[this.headIndex]
					: this.chunks.slice(this.headIndex).join("");
		// 提示行与旧实现一致：只在真的发生截断后出现，且只出现一次
		return this.truncated && this.notice
			? this.notice + NOTICE_SUFFIX + body
			: body;
	}

	private evictOverflow(): void {
		this.truncated = true;
		let lastEvictedChar = "";
		// 整块淘汰：只要丢弃头块后仍有 >= 上限的尾部，就说明丢掉它不会让保留窗口低于上限。
		// 这样每次淘汰的成本只与块大小有关（摊销 O(1)/块），不会重写整段缓冲。
		while (this.chunks.length - this.headIndex > 1) {
			const headLength = this.chunks[this.headIndex].length;
			if (this.length - headLength < TERMINAL_SCROLLBACK_MAX_CHARS) break;
			const dropped = this.chunks[this.headIndex];
			lastEvictedChar = dropped.charAt(dropped.length - 1);
			// 清掉引用让旧块可被 GC；物理裁剪交给 compact()
			this.chunks[this.headIndex] = "";
			this.headIndex += 1;
			this.length -= headLength;
		}

		if (this.length > TERMINAL_SCROLLBACK_MAX_CHARS) {
			// 只淘汰一块就会低于上限：改为在头块内部裁剪掉溢出的前缀。
			this.trimHead(this.length - TERMINAL_SCROLLBACK_MAX_CHARS);
		} else if (lastEvictedChar && lastEvictedChar !== "\n") {
			// 恰好落在上限时没有块内裁剪，整块边界可能落在行中或转义序列中，需要退到安全起点
			this.alignHead(lastEvictedChar);
		}
		this.compact();
	}

	/**
	 * 从头块裁掉 overflow 个字符（overflow < 头块长度）。
	 *
	 * 安全起点可能不在头块内部：spinner/进度条每帧都是一次 append，头块整块没有 `\n`，
	 * 但下一块的开头恰好是新的转义序列。因此把头块和下一块拼成一次「窗口」交给
	 * findSafeStart；拼的块数固定（最多两块），成本仍只与块大小有关，与缓冲总长无关。
	 */
	private trimHead(overflow: number): void {
		const head = this.chunks[this.headIndex];
		const next = this.chunks[this.headIndex + 1];
		const cut = findSafeStart(next === undefined ? head : head + next, overflow);
		if (next !== undefined && cut >= head.length) {
			// 安全起点落在下一块：整块丢掉头块，再从下一块开头裁掉多余前缀
			this.chunks[this.headIndex] = "";
			this.headIndex += 1;
			this.length -= head.length;
			const rest = cut - head.length;
			if (rest > 0) {
				this.chunks[this.headIndex] = next.slice(rest);
				this.length -= rest;
			}
			return;
		}
		if (cut > 0) {
			this.chunks[this.headIndex] = head.slice(cut);
			this.length -= cut;
		}
	}

	/**
	 * 整块淘汰的边界落在 PTY 数据块之间，可能切在半行或半个转义序列上。
	 * xterm.write 从半行/半个转义序列开始解析会渲染出乱码（旧实现按字符裁剪时不存在此问题），
	 * 所以保留区必须回到安全起点：优先「本块第一个换行之后」，其次「本块第一个 ESC」，
	 * 都没有（单行进度条）时只需保证不切开代理对。
	 *
	 * 已知局限：如果块边界恰好落在转义序列内部、而头块里再没有 ESC，残片无法与本块开头区分，
	 * 只能原样保留。块大小固定（8K）且转义序列很短，命中概率很低；跨块安全起点由 trimHead
	 * 的「头块 + 下一块」窗口负责，不需要在这里拼整段。
	 */
	private alignHead(previousChar: string): void {
		const head = this.chunks[this.headIndex];
		if (!head || previousChar === "\n") return;
		const lineBreak = head.indexOf("\n");
		if (lineBreak !== -1) {
			// 丢弃残留的半行（含行尾 \n），保留区从下一整行开始
			this.chunks[this.headIndex] = head.slice(lineBreak + 1);
			this.length -= lineBreak + 1;
			return;
		}
		const escape = head.indexOf(ESC);
		if (escape > 0) {
			this.chunks[this.headIndex] = head.slice(escape);
			this.length -= escape;
			return;
		}
		const before = previousChar.charCodeAt(0);
		const after = head.charCodeAt(0);
		if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
			this.chunks[this.headIndex] = head.slice(1);
			this.length -= 1;
		}
	}

	/** 数组本身不能无限增长：被淘汰的块只在引用上层清空，前缀占到一半时做一次物理裁剪。 */
	private compact(): void {
		if (this.headIndex >= 32 && this.headIndex * 2 >= this.chunks.length) {
			this.chunks = this.chunks.slice(this.headIndex);
			this.headIndex = 0;
		}
	}
}
