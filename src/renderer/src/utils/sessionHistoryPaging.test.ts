import { describe, expect, it, vi } from "vitest";
import type { AgentHistoryPage } from "../../../shared/api";
import type { ChatMessage } from "../../../shared/types";
import {
	createSessionHistoryPaging,
	mergeOlderHistory,
	type SessionHistoryScope,
} from "./sessionHistoryPaging";

/**
 * 「更早历史」页账本的五条不变式。
 *
 * 这些规则此前是 App 里的 5 个 ref/state 加注释：单飞、作用域绑定、陈旧响应丢弃、
 * 基线失效、id 去重。任何一条改错都只表现为「翻页重复」「切会话串台」「看不到第八页」，
 * 而接口是 6728 行的 App 函数，无从测试。
 */

function message(id: string): ChatMessage {
	return { id, agentId: "a", role: "assistant", text: id, timestamp: 0 } as ChatMessage;
}

function page(ids: string[], cursor: number, hasMore = true): AgentHistoryPage {
	return { messages: ids.map(message), cursor, hasMore };
}

const scopeA: SessionHistoryScope = { agentId: "a", sessionPath: "/a.jsonl", historyHasOlder: true };
const scopeB: SessionHistoryScope = { agentId: "b", sessionPath: "/b.jsonl", historyHasOlder: true };

/** 手动控制 resolve 时机的 loader，用于构造「响应还在路上」的时序。 */
function deferredLoader() {
	const pending: Array<{
		agentId: string;
		cursor: number | undefined;
		resolve: (page: AgentHistoryPage) => void;
		reject: (error: unknown) => void;
	}> = [];
	const loadPage = vi.fn(
		(agentId: string, cursor?: number) =>
			new Promise<AgentHistoryPage>((resolve, reject) => {
				pending.push({ agentId, cursor, resolve, reject });
			}),
	);
	return { loadPage, pending };
}

describe("createSessionHistoryPaging", () => {
	it("前插页并沿用同一 key 的 cursor", async () => {
		const loadPage = vi.fn(async (_agentId: string, cursor?: number) =>
			cursor === undefined ? page(["m3", "m4"], 300) : page(["m1", "m2"], 100, false),
		);
		const paging = createSessionHistoryPaging({ loadPage });

		await paging.loadNextPage(scopeA);
		expect(paging.read(scopeA).olderMessages.map((m) => m.id)).toEqual(["m3", "m4"]);
		await paging.loadNextPage(scopeA);

		expect(loadPage).toHaveBeenLastCalledWith("a", 300);
		// 更早的页必须前插，否则时间线顺序会倒过来。
		expect(paging.read(scopeA).olderMessages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
		expect(paging.read(scopeA).hasMore).toBe(false);
	});

	it("同一作用域在途时重复点击只发一次请求（单飞）", async () => {
		const { loadPage, pending } = deferredLoader();
		const paging = createSessionHistoryPaging({ loadPage });

		const first = paging.loadNextPage(scopeA);
		const second = paging.loadNextPage(scopeA);
		expect(loadPage).toHaveBeenCalledTimes(1);
		expect(paging.read(scopeA).loading).toBe(true);

		pending[0].resolve(page(["m9"], 10));
		await Promise.all([first, second]);
		expect(loadPage).toHaveBeenCalledTimes(1);
		expect(paging.read(scopeA).loading).toBe(false);
		expect(paging.read(scopeA).olderMessages.map((m) => m.id)).toEqual(["m9"]);
	});

	it("作用域切走后迟到的响应被丢弃，且不写进新会话的账本", async () => {
		const { loadPage, pending } = deferredLoader();
		const paging = createSessionHistoryPaging({ loadPage });

		void paging.loadNextPage(scopeA);
		// 用户在响应到达前切到另一个会话：在途请求被作废，loading 立刻复位。
		paging.abandonInFlight(scopeB);
		expect(paging.read(scopeB).loading).toBe(false);
		pending[0].resolve(page(["a-old"], 1));
		await Promise.resolve();
		await Promise.resolve();

		expect(paging.read(scopeA).olderMessages).toEqual([]);
		expect(paging.read(scopeB).olderMessages).toEqual([]);
		expect(paging.read(scopeB).hasMore).toBe(true);
	});

	it("同一会话的尾窗刷新（historyHasOlder 变化）不作废在途请求", async () => {
		const { loadPage, pending } = deferredLoader();
		const paging = createSessionHistoryPaging({ loadPage });

		void paging.loadNextPage(scopeA);
		// 基线刷新后 historyHasOlder 可能翻转，但用户没切会话：这一页仍然属于当前视图。
		paging.abandonInFlight({ ...scopeA, historyHasOlder: false });
		expect(paging.read(scopeA).loading).toBe(true);

		pending[0].resolve(page(["m9"], 10));
		await Promise.resolve();
		await Promise.resolve();
		expect(paging.read(scopeA).olderMessages.map((m) => m.id)).toEqual(["m9"]);
	});

	it("基线失效后旧页清空，且作废在途请求", async () => {
		const { loadPage, pending } = deferredLoader();
		const paging = createSessionHistoryPaging({ loadPage });

		void paging.loadNextPage(scopeA);
		pending[0].resolve(page(["m5"], 42));
		await Promise.resolve();
		await Promise.resolve();
		expect(paging.read(scopeA).olderMessages.map((m) => m.id)).toEqual(["m5"]);

		// 重连/压缩替换了尾窗基线：旧页与新基线之间会出现空洞。
		void paging.loadNextPage(scopeA);
		paging.invalidateBaseline();
		expect(paging.read(scopeA).olderMessages).toEqual([]);
		expect(paging.read(scopeA).loading).toBe(false);

		pending[1].resolve(page(["m4"], 20));
		await Promise.resolve();
		await Promise.resolve();
		// 失效后返回的页不能写回，否则会跨基线拼出缺口。
		expect(paging.read(scopeA).olderMessages).toEqual([]);
	});

	it("失效后的下一次请求从尾窗边界重新开始，而不是沿用旧 cursor", async () => {
		const { loadPage, pending } = deferredLoader();
		const paging = createSessionHistoryPaging({ loadPage });

		void paging.loadNextPage(scopeA);
		pending[0].resolve(page(["m5"], 42));
		await Promise.resolve();
		await Promise.resolve();

		paging.invalidateBaseline();
		void paging.loadNextPage(scopeA);
		expect(pending[1].cursor).toBeUndefined();
	});

	it("相邻页重复的消息按 id 去重", async () => {
		const loadPage = vi
			.fn(async () => page(["m2", "m3"], 5));
		const paging = createSessionHistoryPaging({ loadPage });

		await paging.loadNextPage(scopeA);
		await paging.loadNextPage(scopeA);
		expect(paging.read(scopeA).olderMessages.map((m) => m.id)).toEqual(["m2", "m3"]);
	});

	it("historyHasOlder 为 false 时不给翻页入口", async () => {
		const loadPage = vi.fn(async () => page([], 0, false));
		const paging = createSessionHistoryPaging({ loadPage });

		expect(paging.read({ ...scopeA, historyHasOlder: false }).hasMore).toBe(false);
		expect(paging.read({ agentId: null }).hasMore).toBe(false);
	});

	it("缺少 sessionPath 时不发请求（尚无会话文件）", async () => {
		const loadPage = vi.fn(async () => page([], 0, false));
		const paging = createSessionHistoryPaging({ loadPage });

		await paging.loadNextPage({ agentId: "a", sessionPath: undefined, historyHasOlder: true });
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("失败上报错误但不破坏既有页，且 loading 复位", async () => {
		const onError = vi.fn();
		const loadPage = vi
			.fn()
			.mockResolvedValueOnce(page(["m7"], 77))
			.mockRejectedValueOnce(new Error("boom"));
		const paging = createSessionHistoryPaging({ loadPage, onError });

		await paging.loadNextPage(scopeA);
		await paging.loadNextPage(scopeA);

		expect(onError).toHaveBeenCalledTimes(1);
		expect(paging.read(scopeA).olderMessages.map((m) => m.id)).toEqual(["m7"]);
		expect(paging.read(scopeA).loading).toBe(false);
		// 失败后仍可重试。
		expect(paging.read(scopeA).hasMore).toBe(true);
	});

	it("作用域与账本都不变时 read 返回同一引用（useSyncExternalStore 不抖动）", async () => {
		const loadPage = vi.fn(async () => page(["m1"], 1, false));
		const paging = createSessionHistoryPaging({ loadPage });

		await paging.loadNextPage(scopeA);
		const first = paging.read(scopeA);
		expect(paging.read({ ...scopeA })).toBe(first);
		// 账本没变就不换信封：否则订阅组件会为一次重渲染付出整棵时间线的代价。
		expect(paging.read(scopeA)).toBe(first);
		await paging.loadNextPage(scopeA);
		expect(paging.read(scopeA)).not.toBe(first);
	});
});

describe("mergeOlderHistory", () => {
	const baseline = [message("b1"), message("b2")];

	it("无旧页时原样返回基线引用", () => {
		expect(mergeOlderHistory([], baseline)).toBe(baseline);
		expect(mergeOlderHistory(undefined, baseline)).toBe(baseline);
	});

	it("旧页拼在基线前面并过滤与基线重复的消息", () => {
		expect(mergeOlderHistory([message("o1"), message("b1")], baseline).map((m) => m.id)).toEqual([
			"o1",
			"b1",
			"b2",
		]);
	});

	it("旧页全部与基线重复时不产生新数组", () => {
		expect(mergeOlderHistory([message("b1")], baseline)).toBe(baseline);
	});
});
