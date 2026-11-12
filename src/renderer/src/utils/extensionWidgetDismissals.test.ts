import { describe, expect, it } from "vitest";
import {
	dismissWidgetKeys,
	isWidgetDismissed,
	normalizeDismissedWidgets,
	restoreWidgetKey,
} from "./extensionWidgetDismissals";

describe("normalizeDismissedWidgets", () => {
	it("丢弃非对象、非数组项与非字符串键，保留合法会话", () => {
		expect(normalizeDismissedWidgets(null)).toBeUndefined();
		expect(normalizeDismissedWidgets([])).toBeUndefined();
		expect(normalizeDismissedWidgets({ a: "x", b: ["t", 2, ""], c: ["u"] })).toEqual({
			b: ["t"],
			c: ["u"],
		});
	});

	it("空列表的会话不写入（等价于未关闭）", () => {
		expect(normalizeDismissedWidgets({ a: [] })).toEqual({});
	});
});

describe("dismissWidgetKeys", () => {
	it("追加去重；全部已存在时返回原引用", () => {
		const first = dismissWidgetKeys({}, "s1", ["todo"]);
		expect(first).toEqual({ s1: ["todo"] });
		const again = dismissWidgetKeys(first, "s1", ["todo", "plan"]);
		expect(again).toEqual({ s1: ["todo", "plan"] });
		expect(dismissWidgetKeys(again, "s1", ["todo"])).toBe(again);
	});

	it("无会话键或空列表时不产生新对象", () => {
		const record = { s1: ["todo"] };
		expect(dismissWidgetKeys(record, undefined, ["todo"])).toBe(record);
		expect(dismissWidgetKeys(record, "s1", [])).toBe(record);
	});

	it("按会话隔离：同名 widget 在另一会话仍可见", () => {
		const record = dismissWidgetKeys({}, "s1", ["todo"]);
		expect(isWidgetDismissed(record, "s1", "todo")).toBe(true);
		expect(isWidgetDismissed(record, "s2", "todo")).toBe(false);
		expect(isWidgetDismissed(record, undefined, "todo")).toBe(false);
	});
});

describe("restoreWidgetKey", () => {
	it("解除关闭；该会话无剩余关闭项时整键删除", () => {
		const one = dismissWidgetKeys({}, "s1", ["todo"]);
		const two = dismissWidgetKeys(one, "s1", ["plan"]);
		expect(restoreWidgetKey(two, "s1", "todo")).toEqual({ s1: ["plan"] });
		expect(restoreWidgetKey(one, "s1", "todo")).toEqual({});
	});

	it("未关闭时返回原引用（widget 推送高频路径不触发落盘）", () => {
		const record = { s1: ["plan"] };
		expect(restoreWidgetKey(record, "s1", "todo")).toBe(record);
		expect(restoreWidgetKey(record, "missing", "plan")).toBe(record);
	});
});
