import { describe, expect, it } from "vitest";
import {
	PROMPT_HISTORY_LIMIT,
	buildQueueRows,
	cancelPromptHistoryNavigation,
	clampSuggestionIndex,
	detectBangMode,
	historyKeyForAgent,
	IDLE_PROMPT_HISTORY_NAVIGATION,
	isSessionPathKey,
	mergePromptHistory,
	recordPromptHistory,
	resolveComposerSendRoute,
	shouldRecordPrompt,
	stepPromptHistoryNavigation,
	stepSuggestionIndex,
	streamingBehaviorForRoute,
} from "./composerModule";

describe("detectBangMode", () => {
	it("识别行首 bang / bang-bang", () => {
		expect(detectBangMode("!ls")).toBe("bang");
		expect(detectBangMode("!!ls")).toBe("bang-bang");
	});

	it("空文本与非 bang 开头都是 none", () => {
		expect(detectBangMode("")).toBe("none");
		expect(detectBangMode("echo !x")).toBe("none");
		expect(detectBangMode("  !ls")).toBe("none");
	});

	it("前缀判定优先于正文：`!!` 不会被当成单 bang", () => {
		expect(detectBangMode("!!!")).toBe("bang-bang");
	});
});

describe("mergePromptHistory", () => {
	it("incoming 优先、按 trim 去重、丢弃空白条目", () => {
		expect(mergePromptHistory(["b", "  ", "a"], ["a", "c"])).toEqual(["a", "c", "b"]);
	});

	it("缺省 existing 时等价于去重 incoming", () => {
		expect(mergePromptHistory(undefined, ["x", "x", " y "])).toEqual(["x", "y"]);
	});

	it("上限是唯一一份常量：超长结果截断到 PROMPT_HISTORY_LIMIT", () => {
		const existing = Array.from({ length: PROMPT_HISTORY_LIMIT + 20 }, (_, i) => `old-${i}`);
		const merged = mergePromptHistory(existing, ["new-1", "new-2"]);
		expect(merged).toHaveLength(PROMPT_HISTORY_LIMIT);
		expect(merged.slice(0, 2)).toEqual(["new-1", "new-2"]);
		expect(merged).not.toContain(`old-${PROMPT_HISTORY_LIMIT - 1}`);
	});
});

describe("recordPromptHistory", () => {
	it("同文本去重后置顶", () => {
		expect(recordPromptHistory(["a", "b"], "b")).toEqual(["b", "a"]);
	});

	it("遵守上限", () => {
		const existing = Array.from({ length: PROMPT_HISTORY_LIMIT }, (_, i) => `p-${i}`);
		const next = recordPromptHistory(existing, "fresh", 3);
		expect(next).toEqual(["fresh", "p-0", "p-1"]);
	});

	it("shell 命令与空白不进历史", () => {
		expect(shouldRecordPrompt("!ls")).toBe(false);
		expect(shouldRecordPrompt("   ")).toBe(false);
		expect(shouldRecordPrompt("hello")).toBe(true);
	});
});

describe("historyKeyForAgent", () => {
	it("优先 sessionPath，匿名会话退回 agentId", () => {
		const agents = [{ id: "a1", sessionPath: "C:/s/1.jsonl" }, { id: "a2" }];
		expect(historyKeyForAgent("a1", agents)).toBe("C:/s/1.jsonl");
		expect(historyKeyForAgent("a2", agents)).toBe("a2");
		expect(historyKeyForAgent("missing", agents)).toBe("missing");
	});

	it("路径键含分隔符，agentId 不含", () => {
		expect(isSessionPathKey("C:\\s\\1.jsonl")).toBe(true);
		expect(isSessionPathKey("/home/u/1.jsonl")).toBe(true);
		expect(isSessionPathKey("pending-abc")).toBe(false);
	});
});

describe("prompt history navigation", () => {
	it("↑ 首次进入导航时快照草稿并回到最新一条", () => {
		const step = stepPromptHistoryNavigation({
			state: IDLE_PROMPT_HISTORY_NAVIGATION,
			direction: "up",
			history: ["newest", "older"],
			draft: "typing",
		});
		expect(step).toEqual({
			state: { index: 0, navigating: true, savedPrompt: "typing" },
			text: "newest",
		});
	});

	it("↑ 到顶后不再变化（返回 null，不 preventDefault）", () => {
		const step = stepPromptHistoryNavigation({
			state: { index: 1, navigating: true, savedPrompt: "typing" },
			direction: "up",
			history: ["newest", "older"],
			draft: "ignored",
		});
		expect(step).toBeNull();
	});

	it("↓ 从最旧一条恢复原始草稿并退出导航", () => {
		const step = stepPromptHistoryNavigation({
			state: { index: 0, navigating: true, savedPrompt: "typing" },
			direction: "down",
			history: ["newest", "older"],
			draft: "ignored",
		});
		expect(step).toEqual({ state: IDLE_PROMPT_HISTORY_NAVIGATION, text: "typing" });
	});

	it("未导航时 ↓ 不生效；无历史时 ↑ 不生效", () => {
		expect(
			stepPromptHistoryNavigation({
				state: IDLE_PROMPT_HISTORY_NAVIGATION,
				direction: "down",
				history: ["a"],
				draft: "",
			}),
		).toBeNull();
		expect(
			stepPromptHistoryNavigation({
				state: IDLE_PROMPT_HISTORY_NAVIGATION,
				direction: "up",
				history: [],
				draft: "",
			}),
		).toBeNull();
	});

	it("ESC 恢复导航前的草稿", () => {
		expect(
			cancelPromptHistoryNavigation({ index: 1, navigating: true, savedPrompt: "draft" }),
		).toEqual({ state: IDLE_PROMPT_HISTORY_NAVIGATION, text: "draft" });
		expect(cancelPromptHistoryNavigation(IDLE_PROMPT_HISTORY_NAVIGATION)).toBeNull();
	});
});

describe("suggestion index", () => {
	it("钳制到 [0, length-1]，空列表为 0", () => {
		expect(clampSuggestionIndex(-3, 5)).toBe(0);
		expect(clampSuggestionIndex(99, 5)).toBe(4);
		expect(clampSuggestionIndex(2, 0)).toBe(0);
	});

	it("上下移动在边界停住，不循环", () => {
		expect(stepSuggestionIndex(0, 3, -1)).toBe(0);
		expect(stepSuggestionIndex(2, 3, 1)).toBe(2);
		expect(stepSuggestionIndex(1, 3, 1)).toBe(2);
		expect(stepSuggestionIndex(0, 0, 1)).toBe(0);
	});
});

describe("send route", () => {
	const base = { agentId: "a1", activeAgentId: "a1" };

	it("空闲发送不带 streamingBehavior", () => {
		const route = resolveComposerSendRoute({ ...base, busy: false });
		expect(route).toBe("send");
		expect(streamingBehaviorForRoute(route)).toBeUndefined();
	});

	it("活跃且忙碌默认 steer", () => {
		const route = resolveComposerSendRoute({ ...base, busy: true });
		expect(route).toBe("steer");
		expect(streamingBehaviorForRoute(route)).toBe("steer");
	});

	it("后台 agent 的忙碌态不借用前台", () => {
		expect(
			resolveComposerSendRoute({ agentId: "a2", activeAgentId: "a1", busy: true }),
		).toBe("send");
	});

	it("显式 followUp 覆盖默认路线，即使空闲", () => {
		expect(
			resolveComposerSendRoute({ ...base, busy: false, explicit: "followUp" }),
		).toBe("followUp");
		expect(
			streamingBehaviorForRoute(
				resolveComposerSendRoute({ ...base, busy: true, explicit: "followUp" }),
			),
		).toBe("followUp");
	});
});

describe("buildQueueRows", () => {
	it("steering 在前、followUp 在后，重复文本 key 不碰撞，未知提示排最后", () => {
		const rows = buildQueueRows(
			{ steering: ["dup", "dup"], followUp: ["later"] },
			[{ id: "u1", text: "lost", error: "timeout" }],
		);
		expect(rows.map((row) => row.kind)).toEqual([
			"queued",
			"queued",
			"queued",
			"uncertain",
		]);
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
		expect(rows[2]).toMatchObject({ queue: "followUp", text: "later" });
	});

	it("空队列产出空行", () => {
		expect(buildQueueRows(undefined)).toEqual([]);
	});
});
