import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import {
	classifyPiFailure,
	decodePiFrame,
	readAgentEndReport,
	retryStatusText,
	normalizePiQueue,
	normalizeUsageLimit,
	type PiEffect,
} from "./piProtocol";

/** 取一帧的效果；断言帧本身被识别（`undefined` 只代表「不是对象」）。 */
function effectOf(event: unknown): PiEffect | undefined {
	const frame = decodePiFrame(event, 1_700_000_000_000);
	assert.ok(frame, "expected the frame to be decoded");
	return frame.effect;
}

describe("decodePiFrame 活性标记", () => {
	it("非对象输入不解码，调用方连活性戳都不该刷", () => {
		expect(decodePiFrame(null, 0)).toBeUndefined();
		expect(decodePiFrame("agent_start", 0)).toBeUndefined();
		expect(decodePiFrame(["agent_start"], 0)).toBeUndefined();
	});

	it("元数据帧算「是帧」但不算用户可感知的工作", () => {
		// 这三类帧若刷新活性戳，「已完成」通知的静默窗口会被无限推迟。
		for (const type of ["session_info_update", "session_info_changed", "available_commands_update"]) {
			const frame = decodePiFrame({ type }, 0);
			assert.ok(frame);
			expect(frame.work).toBe(false);
		}
	});

	it("真正的运行帧算工作", () => {
		expect(decodePiFrame({ type: "agent_start" }, 0)?.work).toBe(true);
		expect(decodePiFrame({ type: "agent_end" }, 0)?.work).toBe(true);
	});

	it("空标题不产生效果：抹掉已有标题比保留旧标题更糟", () => {
		expect(effectOf({ type: "session_info_update", name: "   " })).toBeUndefined();
		const effect = effectOf({ type: "session_info_changed", name: "  修 好 标题 " });
		expect(effect).toEqual({ kind: "title", name: "修 好 标题" });
	});

	it("未知帧名只留下活性标记", () => {
		const frame = decodePiFrame({ type: "some_future_frame" }, 0);
		assert.ok(frame);
		expect(frame.effect).toBeUndefined();
	});
});

describe("助手子事件相位", () => {
	it("text_delta 归为增量，且不假设 partialMessage 存在", () => {
		const effect = effectOf({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hi" },
		});
		expect(effect).toEqual({
			kind: "assistant-event",
			event: { phase: "text-delta", delta: "hi", message: undefined, content: undefined },
		});
	});

	it("message_end 归为终态相位", () => {
		const effect = effectOf({
			type: "message_update",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "message_end" },
		});
		assert.equal(effect?.kind, "assistant-event");
		if (effect?.kind !== "assistant-event") throw new Error("unreachable");
		expect(effect.event.phase).toBe("final");
		expect(effect.event.message).toEqual({ role: "assistant" });
	});

	it("缺少 assistantMessageEvent 的 message_update 不产生效果", () => {
		expect(effectOf({ type: "message_update" })).toBeUndefined();
	});
});

describe("agent_end 错误阶梯", () => {
	it("优先顶层 errorMessage", () => {
		const report = readAgentEndReport({ type: "agent_end", errorMessage: "boom" });
		expect(report).toEqual({ errorMessage: "boom", hadError: false, willRetry: false });
	});

	it("只从最后一条 assistant 的 error 内容块取错，避免旧输出被当成本次失败", () => {
		const report = readAgentEndReport({
			errorMessage: undefined,
			messages: [
				{
					role: "assistant",
					content: [{ type: "error", text: "old failure" }],
				},
				{ role: "assistant", content: [{ type: "text", text: "all good" }] },
			],
		});
		expect(report.errorMessage).toBeUndefined();
		expect(report.hadError).toBe(false);
	});

	it("stopReason=error 但无错误文本时报「有错」，由调用方补通用文案", () => {
		const report = readAgentEndReport({ type: "agent_end", stopReason: "error" });
		expect(report.errorMessage).toBeUndefined();
		expect(report.hadError).toBe(true);
	});
});

describe("扩展错误帧", () => {
	// 扩展抛出的 error 可能是字符串，也可能是 { message } 对象。丢成
	// "Extension error" 会让用户看不到扩展抛出的真实原因。
	it("字符串与对象两种 error 都取到可读文本", () => {
		expect(effectOf({ type: "extension_error", error: "boom" })).toEqual({
			kind: "extension-error",
			message: "boom",
		});
		expect(effectOf({ type: "extension_error", error: { message: "boom" } })).toEqual({
			kind: "extension-error",
			message: "boom",
		});
		expect(effectOf({ type: "extension_error" })).toEqual({
			kind: "extension-error",
			message: "Extension error",
		});
	});
});

describe("自动重试卡片", () => {
	it("重试帧缺字段时保持 undefined，让调用方回退到卡片 meta", () => {
		const effect = effectOf({ type: "auto_retry_start", attempt: 2, maxAttempts: 5 });
		expect(effect).toEqual({ kind: "retry-start", attempt: 2, maxAttempts: 5 });
	});

	it("文案按秒向上取整，未知上限只写次数", () => {
		expect(
			retryStatusText({ status: "running", attempt: 1, maxAttempts: 3, delayMs: 400, reason: "限流" }),
		).toBe("正在自动重试 1/3，1 秒后重试\n原因：限流");
		expect(
			retryStatusText({ status: "error", attempt: 2, maxAttempts: 0, delayMs: 0, reason: "超时" }),
		).toBe("自动重试失败，已重试 2 次\n原因：超时");
	});
});

describe("工具与压缩帧", () => {
	it("工具边沿原样交给调用方，读字段规则不在这里猜", () => {
		const event = { type: "tool_execution_end", toolCallId: "t1", isError: true };
		expect(effectOf(event)).toEqual({ kind: "tool-end", event });
	});

	it("压缩起止按 pi/omp 两套帧名收敛到同一效果", () => {
		expect(effectOf({ type: "auto_compaction_start", reason: "overflow" })).toEqual({
			kind: "compaction-start",
			reason: "overflow",
		});
		expect(effectOf({ type: "compaction_end", result: true })).toEqual({
			kind: "compaction-end",
			reason: "",
			result: true,
			aborted: false,
			willRetry: false,
			skipped: false,
		});
	});

	it("omp 的 result 是 CompactionResult 对象，不能被压成 failed", () => {
		// omp 线格式：result: CompactionResult | undefined（对象），不是布尔。
		// 用 readBool（`=== true`）会把成功压缩判成失败，只影响日志却误导排查。
		expect(effectOf({ type: "auto_compaction_end", result: { summary: "…" } })).toMatchObject({
			kind: "compaction-end",
			result: true,
		});
		expect(effectOf({ type: "auto_compaction_end", result: undefined })).toMatchObject({
			kind: "compaction-end",
			result: false,
		});
		// 良性跳过不是失败：omp 用 result: undefined + skipped: true 表达「没压，但不是坏了」。
		expect(effectOf({ type: "auto_compaction_end", aborted: false, skipped: true })).toMatchObject({
			kind: "compaction-end",
			result: false,
			skipped: true,
		});
	});

	it("自动重试失败的终态优先最终错误文本（agent_end 的补卡片路径不带 finalError）", () => {
		// auto_retry_start 只带 errorMessage，auto_retry_end 只带 finalError：
		// 两者分开取，缺失时保持 undefined 让调用方回退卡片 meta。
		expect(effectOf({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "429" }))
			.toMatchObject({ kind: "retry-start", reason: "429" });
		expect(effectOf({ type: "auto_retry_end", success: false, attempt: 3, finalError: "boom" }))
			.toMatchObject({ kind: "retry-end", success: false, reason: "boom" });
	});

	it("两帧同时带 errorMessage 与 finalError 时各自取权威字段", () => {
		// omp 线格式里 auto_retry_start 带 errorMessage、auto_retry_end 带 finalError；
		// 若某版本两个都带，起帧信 errorMessage、终帧信 finalError。
		// 注意这与迁移前不同：旧实现的重试卡片统一取 errorMessage，而失败文案取
		// finalError，两处文案可能各说各话；现在终帧统一取 finalError，卡片与
		// 「请求失败：…」一致。
		expect(effectOf({ type: "auto_retry_start", errorMessage: "429", finalError: "boom" }))
			.toMatchObject({ kind: "retry-start", reason: "429" });
		expect(effectOf({ type: "auto_retry_end", success: false, errorMessage: "429", finalError: "boom" }))
			.toMatchObject({ kind: "retry-end", reason: "boom" });
	});

	it("旧 pi 的 agent_settled 与新 pi 的 session_settled 是同一个稳定点", () => {
		expect(effectOf({ type: "agent_settled" })).toEqual({ kind: "settled" });
		expect(effectOf({ type: "session_settled" })).toEqual({ kind: "settled" });
	});

	it("缓存预热把非 hit 的停止原因带到效果上，供日志诊断", () => {
		const effect = effectOf({
			type: "cache_warming_end",
			outcome: "error",
			provider: "anthropic",
			model: "claude",
			warmingStopReason: "aborted",
		});
		expect(effect).toMatchObject({
			kind: "cache-warming",
			warmingStopReason: "aborted",
			state: { phase: "done", outcome: "error", provider: "anthropic", model: "claude" },
		});
	});
});

describe("get_state 擦洗", () => {
	it("队列缺失或含非字符串项都收敛为空列表", () => {
		expect(normalizePiQueue(undefined)).toEqual({ steering: [], followUp: [] });
		expect(normalizePiQueue({ steering: ["a", 3, ""], followUp: "nope" })).toEqual({
			steering: ["a"],
			followUp: [],
		});
	});

	it("usageLimit 只认同两种 stage，字符串数字仍可读", () => {
		expect(normalizeUsageLimit({ stage: "weird" })).toBeUndefined();
		expect(
			normalizeUsageLimit({ stage: "low_priority", resetsAtSec: "123", allowanceLeftPercent: 42 }),
		).toEqual({ stage: "low_priority", resetsAtSec: 123, allowanceLeftPercent: 42 });
	});
});

describe("失败响应类别", () => {
	it("按 pi 的文案区分换名重试、传输上限与真实错误", () => {
		expect(classifyPiFailure({ error: "Unknown command: get_commands" })).toBe("unknown-command");
		expect(classifyPiFailure({ error: "Response exceeded transport limit" })).toBe("transport-limit");
		expect(classifyPiFailure({ error: "session busy" })).toBe("other");
		// 超时后 client 可能没有响应体：不能当成命令名不兼容去换名重试。
		expect(classifyPiFailure(undefined)).toBe("other");
	});
});
