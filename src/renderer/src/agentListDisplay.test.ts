import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/types";
import {
	getProjectAgentSessionDisplay,
	sameSessionSummary,
	sameSessionSummaryList,
} from "./agentListDisplay";
function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "s1",
		filePath: "/project/s1.jsonl",
		projectPath: "/project",
		name: "s1",
		preview: "preview",
		updatedAt: 1000,
		messageCount: 3,
		...overrides,
	} as SessionSummary;
}

describe("sameSessionSummary", () => {
	it("detects preview/count/parent changes that the old 5-field guard missed", () => {
		const base = makeSession();
		expect(sameSessionSummary(base, makeSession())).toBe(true);
		expect(sameSessionSummary(base, makeSession({ preview: "new" }))).toBe(false);
		expect(sameSessionSummary(base, makeSession({ messageCount: 4 }))).toBe(false);
		expect(sameSessionSummary(base, makeSession({ parentSessionPath: "/project/p.jsonl" }))).toBe(false);
		expect(sameSessionSummary(base, makeSession({ filePath: "/project/other.jsonl" }))).toBe(false);
	});

	it("compares codex membership fields", () => {
		const base = makeSession();
		expect(
			sameSessionSummary(base, makeSession({ codexThreadSource: "subagent", codexParentThreadId: "p" })),
		).toBe(false);
	});
});

describe("sameSessionSummaryList", () => {
	it("requires same length and pairwise equality", () => {
		expect(sameSessionSummaryList([makeSession()], [makeSession()])).toBe(true);
		expect(sameSessionSummaryList([makeSession()], [])).toBe(false);
		expect(
			sameSessionSummaryList([makeSession()], [makeSession({ updatedAt: 2 })]),
		).toBe(false);
	});
});

describe("getProjectAgentSessionDisplay empty container", () => {
	it("空项目产出零子项：App 不渲染 session-card 容器", () => {
		const display = getProjectAgentSessionDisplay({ agents: [], sessions: [] });
		expect(display.children).toEqual([]);
		expect(display.visibleChildren).toEqual([]);
		expect(display.hiddenChildCount).toBe(0);
		// App 渲染条件：visibleChildren.length > 0 || hiddenChildCount > 0
		expect(
			display.visibleChildren.length > 0 || display.hiddenChildCount > 0,
		).toBe(false);
	});

	it("有子项即满足容器渲染条件", () => {
		const display = getProjectAgentSessionDisplay({
			agents: [],
			sessions: [makeSession()],
		});
		expect(
			display.visibleChildren.length > 0 || display.hiddenChildCount > 0,
		).toBe(true);
	});
});
