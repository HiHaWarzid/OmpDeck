import assert from "node:assert/strict";
import { test } from "vitest";
import {
	EDITOR_TAB_LIMIT,
	EDITOR_TAB_TEXT_BUDGET,
	activeTabOf,
	closeTab,
	openTab,
	resetTabs,
	selectTab,
	type EditorTabLedger,
	type OpenTabRequest,
} from "./editorTabLedger";

const open = (ledger: EditorTabLedger, path: string, extra: Partial<OpenTabRequest> = {}) =>
	openTab(ledger, { id: `id-${path}`, filePath: path, mode: "view", ...extra });

const paths = (ledger: EditorTabLedger) => ledger.tabs.map((tab) => tab.filePath);
const ids = (ledger: EditorTabLedger) => ledger.tabs.map((tab) => tab.id);

test("打开文件后成为活跃 tab", () => {
	const ledger = open(resetTabs(), "a.ts");
	assert.deepEqual(paths(ledger), ["a.ts"]);
	assert.equal(activeTabOf(ledger)?.filePath, "a.ts");
});

test("重复打开同一路径复用同一个 tab,不新增条目", () => {
	let ledger = open(resetTabs(), "a.ts");
	ledger = open(ledger, "a.ts", { mode: "diff", originalContent: "old", modifiedContent: "new" });
	assert.deepEqual(ids(ledger), ["id-a.ts"], "id 必须保留,关闭回调按 id 定位");
	assert.equal(ledger.tabs[0].mode, "diff");
	assert.equal(ledger.tabs[0].originalContent, "old");
	assert.equal(ledger.tabs[0].modifiedContent, "new");
});

test("同一路径不同 tabKey 是两个 tab(历史提交 diff 互不覆盖)", () => {
	let ledger = open(resetTabs(), "a.ts", { tabKey: "commit1" });
	ledger = open(ledger, "a.ts", { tabKey: "commit2" });
	assert.equal(ledger.tabs.length, 2);
});

test("超过条数上限时淘汰最久未访问的,并保留刚打开的", () => {
	let ledger = resetTabs();
	for (let i = 0; i < EDITOR_TAB_LIMIT + 2; i += 1) ledger = open(ledger, `f${i}.ts`);
	assert.equal(ledger.tabs.length, EDITOR_TAB_LIMIT);
	assert.deepEqual(paths(ledger), ["f2.ts", "f3.ts", "f4.ts", "f5.ts", "f6.ts"]);
	assert.equal(activeTabOf(ledger)?.filePath, "f6.ts");
});

test("访问过的 tab 不会先被淘汰(切回旧 tab 后它变新)", () => {
	let ledger = resetTabs();
	for (let i = 0; i < EDITOR_TAB_LIMIT; i += 1) ledger = open(ledger, `f${i}.ts`);
	// 重新选中 f0,它成为最新;再开两个,被淘汰的应是 f1/f2 而不是 f0。
	ledger = selectTab(ledger, "id-f0.ts");
	ledger = open(ledger, "f5.ts");
	ledger = open(ledger, "f6.ts");
	assert.ok(paths(ledger).includes("f0.ts"), "刚选过的 tab 必须留下");
	assert.ok(!paths(ledger).includes("f1.ts"));
	assert.ok(!paths(ledger).includes("f2.ts"));
});

test("正文预算超限时按 LRU 淘汰,即使条数还没到上限", () => {
	// 每条占「预算/4 + 2 字节」：3 条在预算内，第 4 条越界必须淘汰。
	const big = "x".repeat(EDITOR_TAB_TEXT_BUDGET / 8 + 1);
	let ledger = open(resetTabs(), "a.ts", { originalContent: big });
	ledger = open(ledger, "b.ts", { originalContent: big });
	ledger = open(ledger, "c.ts", { originalContent: big });
	assert.equal(ledger.tabs.length, 3, "3 条合计仍在预算内");
	ledger = open(ledger, "d.ts", { originalContent: big });
	assert.equal(ledger.tabs.length, 3, "第 4 个必须先淘汰一个");
	assert.deepEqual(paths(ledger), ["b.ts", "c.ts", "d.ts"]);
});

test("单个文件自己就超预算时仍然显示(淘汰留 1 条下限)", () => {
	const huge = "x".repeat(EDITOR_TAB_TEXT_BUDGET);
	let ledger = open(resetTabs(), "a.ts");
	ledger = open(ledger, "huge.ts", { originalContent: huge });
	assert.deepEqual(paths(ledger), ["huge.ts"]);
	assert.equal(activeTabOf(ledger)?.filePath, "huge.ts");
});

test("关闭非活跃 tab 不动活跃项", () => {
	let ledger = open(resetTabs(), "a.ts");
	ledger = open(ledger, "b.ts");
	ledger = open(ledger, "c.ts");
	ledger = closeTab(ledger, "id-a.ts");
	assert.equal(ledger.activeId, "id-c.ts");
	assert.deepEqual(paths(ledger), ["b.ts", "c.ts"]);
});

test("关闭活跃 tab 选同位置邻居:右移一位", () => {
	let ledger = open(resetTabs(), "a.ts");
	ledger = open(ledger, "b.ts");
	ledger = open(ledger, "c.ts");
	ledger = selectTab(ledger, "id-b.ts");
	ledger = closeTab(ledger, "id-b.ts");
	assert.equal(activeTabOf(ledger)?.filePath, "c.ts");
});

test("关闭最后一个位置的活跃 tab 回到左邻居", () => {
	let ledger = open(resetTabs(), "a.ts");
	ledger = open(ledger, "b.ts");
	ledger = closeTab(ledger, "id-b.ts");
	assert.equal(activeTabOf(ledger)?.filePath, "a.ts");
});

test("关闭最后一个 tab 后活跃项为空,上层据此收起编辑器", () => {
	const ledger = closeTab(open(resetTabs(), "a.ts"), "id-a.ts");
	assert.equal(ledger.tabs.length, 0);
	assert.equal(ledger.activeId, null);
	assert.equal(activeTabOf(ledger), null);
});

test("关闭不存在的 tab 是空操作,不改变任何字段", () => {
	const ledger = open(resetTabs(), "a.ts");
	assert.equal(closeTab(ledger, "missing"), ledger);
});

test("切换到不存在的 tab 不制造悬空活跃 id", () => {
	const ledger = open(resetTabs(), "a.ts");
	assert.equal(selectTab(ledger, "missing"), ledger);
	assert.equal(activeTabOf(ledger)?.filePath, "a.ts");
});

test("关闭活跃 tab 时用执行时的账本算邻居,而不是调用时的闭包快照", () => {
	// 场景:A/B 两个 tab,活跃 A;连点关闭 B 与 A,第二次调用拿到的账本必须已经只有 A。
	let ledger = open(resetTabs(), "a.ts");
	ledger = open(ledger, "b.ts");
	ledger = selectTab(ledger, "id-a.ts");
	ledger = closeTab(ledger, "id-b.ts");
	ledger = closeTab(ledger, "id-a.ts");
	assert.equal(ledger.activeId, null, "连点两次关闭不应留下指向已关节点的活跃 id");
	assert.equal(ledger.tabs.length, 0);
});

test("resetTabs 清空且后续打开继续工作", () => {
	let ledger = open(resetTabs(), "a.ts");
	ledger = resetTabs();
	assert.deepEqual(ledger.tabs, []);
	assert.equal(ledger.activeId, null);
	ledger = open(ledger, "b.ts");
	assert.equal(activeTabOf(ledger)?.filePath, "b.ts");
});
