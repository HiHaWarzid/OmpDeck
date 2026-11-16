import { describe, expect, it } from "vitest";
import {
	adoptDraft,
	commitDraft,
	createDraft,
	dirtyPaths,
	draftChanges,
	draftPatch,
	hasDraftChanges,
	isFieldDirty,
	patchDraft,
	rebaseDraft,
	resetDraft,
	setDraftValue,
} from "./configDraft";

type Sample = {
	theme: string;
	zoomFactor: number;
	afk: { enabled: boolean; targetProjectIds: string[] };
	retry: { maxRetries: number; baseDelayMs: number };
};

const seed = (): Sample => ({
	theme: "dark",
	zoomFactor: 1,
	afk: { enabled: false, targetProjectIds: ["a", "b"] },
	retry: { maxRetries: 3, baseDelayMs: 500 },
});

describe("值 diff 判脏", () => {
	it("刚建的草稿是干净的", () => {
		const draft = createDraft(seed());
		expect(hasDraftChanges(draft)).toBe(false);
		expect(dirtyPaths(draft)).toEqual([]);
	});

	it("只把真正改动的键报成脏，其它键不受影响", () => {
		const draft = patchDraft(createDraft(seed()), { theme: "light" });
		expect(dirtyPaths(draft)).toEqual(["theme"]);
		expect(isFieldDirty(draft, "theme")).toBe(true);
		expect(isFieldDirty(draft, "zoomFactor")).toBe(false);
		expect(draftChanges(draft)).toEqual({ theme: "light" });
	});

	it("嵌套映射按键的内容比较，键顺序不同不算改动", () => {
		const base = createDraft(seed());
		const reordered = patchDraft(base, {
			afk: { targetProjectIds: ["a", "b"], enabled: false },
		});
		expect(hasDraftChanges(reordered)).toBe(false);
		expect(dirtyPaths(reordered)).toEqual([]);
	});

	it("数组按顺序比较：换序算改动，内容相同不算", () => {
		const base = createDraft(seed());
		const swapped = patchDraft(base, {
			afk: { enabled: false, targetProjectIds: ["b", "a"] },
		});
		expect(dirtyPaths(swapped)).toEqual(["afk"]);

		const rebuilt = patchDraft(base, {
			afk: { enabled: false, targetProjectIds: ["a", "b"] },
		});
		expect(hasDraftChanges(rebuilt)).toBe(false);
	});
});

describe("revert 清脏", () => {
	it("把字段改回原值后不再算脏（不再依赖「改过哪些字段」的集合）", () => {
		const base = createDraft(seed());
		const edited = patchDraft(base, { theme: "light", zoomFactor: 1.25 });
		expect(dirtyPaths(edited)).toEqual(["theme", "zoomFactor"]);

		const reverted = patchDraft(edited, { theme: "dark", zoomFactor: 1 });
		expect(hasDraftChanges(reverted)).toBe(false);
		expect(draftChanges(reverted)).toEqual({});
	});

	it("嵌套对象改回原值同样清脏（深层值比较，而不是引用比较）", () => {
		const base = createDraft(seed());
		const edited = patchDraft(base, {
			afk: { enabled: true, targetProjectIds: ["a", "b"] },
		});
		expect(isFieldDirty(edited, "afk")).toBe(true);

		const reverted = patchDraft(edited, { afk: { enabled: false, targetProjectIds: ["a", "b"] } });
		expect(hasDraftChanges(reverted)).toBe(false);
	});
});

describe("commit 推进基线", () => {
	it("落盘成功后基线前移，草稿变干净", () => {
		const saved = commitDraft(patchDraft(createDraft(seed()), { theme: "light" }));
		expect(hasDraftChanges(saved)).toBe(false);
		expect(saved.base.theme).toBe("light");
		expect(saved.value.theme).toBe("light");
	});

	it("commit 后 reset 回到新的基线，而不是打开弹框时的旧值", () => {
		const committed = commitDraft(patchDraft(createDraft(seed()), { theme: "light" }));
		const dirtyAgain = patchDraft(committed, { theme: "light-blue" });
		expect(resetDraft(dirtyAgain).value.theme).toBe("light");
	});

	it("只推进真正落盘的键：请求在途时的新编辑仍是 dirty", () => {
		const draft = patchDraft(createDraft(seed()), { theme: "light", zoomFactor: 1.25 });
		const savedInFlight = draftPatch(draft, ["theme"]);
		const committed = commitDraft(draft, ["theme"]);

		expect(savedInFlight).toEqual({ set: [{ path: "theme", value: "light" }], unset: [] });
		expect(committed.base.theme).toBe("light");
		expect(isFieldDirty(committed, "theme")).toBe(false);
		expect(isFieldDirty(committed, "zoomFactor")).toBe(true);
	});

	/**
	 * 基线必须对齐**落盘值**而不是当前 value。保存是异步的：调用方先算 patch 再 await，
	 * 期间用户继续输入会让 value 超前于 patch。若从 value 取基线，那段从未发送出去的
	 * 文本会变成「已保存」，关闭弹层即静默丢失。
	 */
	it("请求在途期间继续编辑同一字段：基线取落盘值，未发送的尾部仍是 dirty", () => {
		const draft = patchDraft(createDraft(seed()), { theme: "light" });
		const submitted = draftChanges(draft);
		// 请求在途：用户又改了同一个键，但这份新值没有被提交。
		const newest = patchDraft(draft, { theme: "solarized" });
		const committed = commitDraft(newest, ["theme"], submitted);

		expect(committed.base.theme).toBe("light");
		expect(committed.value.theme).toBe("solarized");
		expect(isFieldDirty(committed, "theme")).toBe(true);
	});
});

describe("失败保留草稿", () => {
	it("不 commit 时草稿与 dirty 都原样保留", () => {
		const draft = patchDraft(createDraft(seed()), { theme: "light" });
		// 保存失败 = 没有 commit：value 仍是用户输入，base 仍是磁盘真值
		expect(draft.value.theme).toBe("light");
		expect(isFieldDirty(draft, "theme")).toBe(true);
		expect(draft.base.theme).toBe("dark");
	});
});

describe("点路径补丁（config.yml）", () => {
	it("只包含改动路径，嵌套路径写到叶子", () => {
		const base = createDraft<Record<string, unknown>>({
			retry: { maxRetries: 3, baseDelayMs: 500 },
			afk: { enabled: false },
		});
		const edited = setDraftValue(base, {
			retry: { maxRetries: 5, baseDelayMs: 500 },
			afk: { enabled: false },
		});
		expect(draftPatch(edited, ["retry.maxRetries", "retry.baseDelayMs"])).toEqual({
			set: [{ path: "retry.maxRetries", value: 5 }],
			unset: [],
		});
		expect(dirtyPaths(edited, ["retry.maxRetries", "retry.baseDelayMs"])).toEqual([
			"retry.maxRetries",
		]);
	});

	it("删除键报成 unset，未改动的路径不出现", () => {
		const base = createDraft<Record<string, unknown>>({
			retry: { maxRetries: 3, baseDelayMs: 500 },
			compaction: { enabled: true },
		});
		const edited = setDraftValue(base, { compaction: { enabled: true } });
		expect(draftPatch(edited, ["retry.maxRetries", "retry.baseDelayMs", "compaction.enabled"])).toEqual({
			set: [],
			unset: ["retry.maxRetries", "retry.baseDelayMs"],
		});
	});
});

describe("采信外部真值", () => {
	it("adopt 同时更新 base 与 value，字段随之变干净", () => {
		const draft = patchDraft(createDraft(seed()), { zoomFactor: 1.25 });
		const adopted = adoptDraft(draft, { zoomFactor: 1.1 });

		expect(adopted.value.zoomFactor).toBe(1.1);
		expect(adopted.base.zoomFactor).toBe(1.1);
		expect(hasDraftChanges(adopted)).toBe(false);
	});
});

describe("落盘后按路径回读", () => {
	it("只校准已落盘的路径，同时编辑中的其它路径保持未保存", () => {
		// 用户同时改了 retry.maxRetries（本次提交）与 theme（还在编辑，没提交）。
		const draft = patchDraft(createDraft(seed()), { theme: "light" });
		const edited = {
			base: draft.base,
			value: { ...draft.value, retry: { maxRetries: 5, baseDelayMs: 500 } },
		};

		// 保存后被 omp 规范化成 4，回读只应影响 retry.maxRetries。
		const fresh: Sample = {
			...seed(),
			theme: "dark",
			retry: { maxRetries: 4, baseDelayMs: 500 },
		};
		const rebased = rebaseDraft(edited, fresh, ["retry.maxRetries"]);

		expect(rebased.value.retry.maxRetries).toBe(4);
		expect(rebased.base).not.toBe(edited.base);
		// 编辑中的字段既不能被磁盘值覆盖，也不能被标成干净。
		expect(rebased.value.theme).toBe("light");
		expect(dirtyPaths(rebased)).toEqual(["theme"]);
	});

	it("回读期间又改了同一个字段时保留新编辑，不拿更早的磁盘值盖掉", () => {
		// 提交的是 retry.maxRetries=5；请求在途时用户又把它改成 9。
		const draft = createDraft(seed());
		const submitted = { retry: { maxRetries: 5 } } as Partial<Sample>;
		const edited = {
			base: draft.base,
			value: { ...draft.value, retry: { maxRetries: 9, baseDelayMs: 500 } },
		};

		// 磁盘回读到的是「那次已发出的 5」（omp 可能规范化，这里取 5 本身）。
		const fresh: Sample = { ...seed(), retry: { maxRetries: 5, baseDelayMs: 500 } };
		const rebased = rebaseDraft(edited, fresh, ["retry.maxRetries"], submitted);

		// 基线推进到落盘值，但值仍是用户最后输入的 9，且继续显示为未保存。
		expect(rebased.base.retry.maxRetries).toBe(5);
		expect(rebased.value.retry.maxRetries).toBe(9);
		expect(dirtyPaths(rebased, ["retry.maxRetries"])).toEqual(["retry.maxRetries"]);
	});

	it("回读期间没再动那个字段时对齐到磁盘真值并变干净", () => {
		const draft = patchDraft(createDraft(seed()), { retry: { maxRetries: 5, baseDelayMs: 500 } });
		const submitted = { retry: { maxRetries: 5 } } as Partial<Sample>;
		// omp 把 5 规范成了 4：没在途编辑时应当采信磁盘值。
		const fresh: Sample = { ...seed(), retry: { maxRetries: 4, baseDelayMs: 500 } };
		const rebased = rebaseDraft(draft, fresh, ["retry.maxRetries"], submitted);

		expect(rebased.base.retry.maxRetries).toBe(4);
		expect(rebased.value.retry.maxRetries).toBe(4);
		expect(dirtyPaths(rebased)).toEqual([]);
	});

	it("磁盘上键已不存在时，把该路径写成 undefined", () => {
		const draft = patchDraft(createDraft(seed()), { afk: { enabled: true, targetProjectIds: [] } });
		const rebased = rebaseDraft(draft, { ...seed(), afk: undefined } as unknown as Sample, [
			"afk",
		]);

		expect(rebased.value.afk).toBeUndefined();
		expect(rebased.base.afk).toBeUndefined();
		expect(hasDraftChanges(rebased)).toBe(false);
	});
});
