import { describe, expect, it } from "vitest";
import { nextWindowAfterCountChange } from "./useMessagePagination";

/**
 * 窗口锚定规则单测。
 *
 * 这套规则是渲染进程内存上限的守门人：长会话里窗口一旦失控（跟随尾部无限扩窗），
 * 上千条消息（含内嵌图片）会全量进 DOM，正是渲染进程 OOM 的主因。
 */
const base = { initialPageSize: 50, maxVisible: 200 };

describe("nextWindowAfterCountChange", () => {
	it("批量灌入（首屏/基线重推）跟随尾部且窗口大小不变", () => {
		const next = nextWindowAfterCountChange({
			...base,
			prev: { start: 0, size: 50 },
			prevLen: 50,
			len: 600,
			followTail: true,
		});
		expect(next).toEqual({ start: 550, size: 50 });
	});

	it("贴底跟随时流式追加按新增条数扩窗", () => {
		const next = nextWindowAfterCountChange({
			...base,
			prev: { start: 40, size: 50 },
			prevLen: 90,
			len: 91,
			followTail: true,
		});
		expect(next).toEqual({ start: 40, size: 51 });
	});

	it("回看历史（followTail=false）时窗口冻结，新消息不进 DOM", () => {
		const prev = { start: 300, size: 200 };
		const next = nextWindowAfterCountChange({
			...base,
			prev,
			prevLen: 500,
			len: 503,
			followTail: false,
		});
		expect(next).toBe(prev);
	});

	it("窗口停在历史中间（已翻页）时新消息不改变窗口", () => {
		const prev = { start: 100, size: 50 };
		const next = nextWindowAfterCountChange({
			...base,
			prev,
			prevLen: 600,
			len: 601,
			followTail: true,
		});
		expect(next).toBe(prev);
	});

	it("历史分页头部插入时保留阅读位置并从顶部纳入新页", () => {
		const atTop = nextWindowAfterCountChange({
			...base,
			prev: { start: 0, size: 50 },
			prevLen: 50,
			len: 90,
			followTail: false,
			prependCount: 40,
		});
		expect(atTop).toEqual({ start: 0, size: 90 });

		const midHistory = nextWindowAfterCountChange({
			...base,
			prev: { start: 100, size: 50 },
			prevLen: 300,
			len: 340,
			followTail: false,
			prependCount: 40,
		});
		expect(midHistory).toEqual({ start: 140, size: 90 });
	});

	it("到上限后自动从顶部上收，窗口条数恒定", () => {
		let win = { start: 0, size: 200 };
		for (let len = 200; len < 260; len++) {
			const next = nextWindowAfterCountChange({
				...base,
				prev: win,
				prevLen: len,
				len: len + 1,
				followTail: true,
			});
			expect(next.size).toBe(200);
			expect(next.start).toBe(len + 1 - 200);
			win = next;
		}
		expect(win).toEqual({ start: 60, size: 200 });
	});

	it("消息被裁剪变短时夹取回有效区间", () => {
		const next = nextWindowAfterCountChange({
			...base,
			prev: { start: 400, size: 200 },
			prevLen: 600,
			len: 120,
			followTail: true,
		});
		expect(next).toEqual({ start: 0, size: 120 });
	});

	it("空会话只保留最小窗口，不产生负下标", () => {
		expect(
			nextWindowAfterCountChange({
				...base,
				prev: { start: 30, size: 50 },
				prevLen: 80,
				len: 0,
				followTail: true,
			}),
		).toEqual({ start: 0, size: 1 });
	});

	it("总数未变化时原样返回（引用不变，避免多余重渲染）", () => {
		const prev = { start: 10, size: 50 };
		expect(
			nextWindowAfterCountChange({
				...base,
				prev,
				prevLen: 60,
				len: 60,
				followTail: true,
			}),
		).toBe(prev);
	});
});
