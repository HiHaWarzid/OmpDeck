import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLogger } from "./AppLogger";

// AppLogger 在字段初始化时读 app.getPath("userData")；必须让它在临时目录落盘，
// 否则测试会污染真实应用日志。
const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
	app: { getPath: () => state.dir },
	shell: { openPath: async () => "" },
}));

function readErrorLike(value: unknown): { message: string; stack?: string; code?: string } {
	if (typeof value !== "object" || value === null || !("message" in value) || typeof value.message !== "string") {
		throw new Error("不是合法的 error 形状");
	}
	const result: { message: string; stack?: string; code?: string } = { message: value.message };
	if ("stack" in value && typeof value.stack === "string") result.stack = value.stack;
	if ("code" in value && typeof value.code === "string") result.code = value.code;
	return result;
}

function nestedError(detail: unknown): unknown {
	if (typeof detail !== "object" || detail === null || !("error" in detail)) {
		throw new Error("日志 detail 缺少 error");
	}
	return detail.error;
}

describe("AppLogger", () => {
	beforeEach(async () => {
		state.dir = await mkdtemp(join(tmpdir(), "ompdeck-log-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("落盘时保留 detail 里嵌套 Error 的 message/stack/code", async () => {
		const logger = new AppLogger();
		const error = Object.assign(new Error("ENOENT: no such file or directory"), {
			code: "ENOENT",
		});
		await logger.info("session", "Failed to list sessions", { projectId: "p1", error });

		const [entry] = await logger.list({ limit: 1 });
		expect(entry?.message).toBe("Failed to list sessions");
		const detail = readErrorLike(nestedError(entry?.detail));
		expect(detail.message).toContain("ENOENT");
		expect(detail.code).toBe("ENOENT");
		// 关键回归点：修复前这里是 {}，stack 完全丢失
		expect(detail.stack).toContain("AppLogger.test");
	});

	it("顶层 Error 仍然按 name/message/stack 记录", async () => {
		const logger = new AppLogger();
		await logger.warn("session", "scan failed", new RangeError("bad window"));
		const [entry] = await logger.list({ limit: 1 });
		const detail = readErrorLike(entry?.detail);
		expect(detail.message).toBe("bad window");
		expect(detail.stack).toBeTypeOf("string");
	});
});
