import { describe, expect, it } from "vitest";
import { serializeLogDetail } from "./logDetail";

/** 从序列化结果里取出嵌套 error 的 stack；结构不符直接报错，避免测试静默通过。 */
function readErrorStack(value: unknown): string {
	if (typeof value !== "object" || value === null || !("error" in value)) {
		throw new Error("serialized detail 缺少 error");
	}
	const error = value.error;
	if (typeof error !== "object" || error === null || !("stack" in error) || typeof error.stack !== "string") {
		throw new Error("serialized error 缺少 stack");
	}
	return error.stack;
}

describe("serializeLogDetail", () => {
	it("保留嵌套在对象里的 Error 根因", () => {
		const error = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		const serialized = serializeLogDetail({ projectId: "p1", error });
		expect(serialized).toMatchObject({
			projectId: "p1",
			error: { name: "Error", message: "ENOENT: no such file", code: "ENOENT" },
		});
		// stack 是排查问题的关键，不能被丢掉
		expect(readErrorStack(serialized)).toContain("logDetail.test");
	});

	it("循环引用不抛错", () => {
		const node: Record<string, unknown> = { name: "root" };
		node.self = node;
		expect(serializeLogDetail(node)).toEqual({ name: "root", self: "[Circular]" });
	});

	it("超长字符串、超长数组和超深对象被截断", () => {
		const deep = { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } };
		expect(JSON.stringify(serializeLogDetail(deep))).toContain("[MaxDepth]");
		expect((serializeLogDetail("x".repeat(5000)) as string).length).toBeLessThan(5000);
		const list = serializeLogDetail(Array.from({ length: 60 }, (_, i) => i)) as unknown[];
		expect(list).toHaveLength(51);
		expect(list[50]).toBe("…(60 items)");
	});

	it("不可 JSON 化的标量转成可读字符串", () => {
		expect(serializeLogDetail(10n)).toBe("10n");
		expect(serializeLogDetail(() => 1)).toBe("[Function]");
	});
});
