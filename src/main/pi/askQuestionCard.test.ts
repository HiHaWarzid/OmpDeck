import { describe, expect, it } from "vitest";
import { buildAskCard, extractAskQuestionDetails } from "./askQuestionCard";

/**
 * omp 的 ask 超时不是「未回答」：pi 会选择 recommended（无则第一项）并写入
 * selectedOptions + timedOut。卡片必须展示该答案并标记来源，否则用户会以为
 * agent 在无答案的情况下继续执行。
 */
describe("buildAskCard timeout semantics", () => {
	it("单题超时仍展示推荐答案并标记 timedOut", () => {
		const details = extractAskQuestionDetails(
			"ask",
			{
				details: {
					question: "选择实现方向",
					options: ["方案 A", "方案 B"],
					selectedOptions: ["方案 B"],
					timedOut: true,
				},
			},
			undefined,
		);
		const card = buildAskCard(details, false) as Record<string, unknown>;

		expect(card.answered).toBe(true);
		expect(card.answer).toBe("方案 B");
		expect(card.timedOut).toBe(true);
	});

	it("批量每题独立保留超时标记", () => {
		const details = extractAskQuestionDetails(
			"ask",
			{
				details: {
					results: [
						{
							id: "q1",
							question: "第一题",
							options: ["A", "B"],
							selectedOptions: ["B"],
							timedOut: true,
						},
						{
							id: "q2",
							question: "第二题",
							options: ["C", "D"],
							selectedOptions: ["C"],
						},
					],
				},
			},
			undefined,
		);
		const card = buildAskCard(details, false) as {
			answered: boolean;
			timedOut: boolean;
			items: Array<{ answered: boolean; timedOut: boolean; answer: unknown }>;
		};

		expect(card.answered).toBe(true);
		expect(card.timedOut).toBe(true);
		expect(card.items[0]).toMatchObject({ answered: true, timedOut: true, answer: "B" });
		expect(card.items[1]).toMatchObject({ answered: true, timedOut: false, answer: "C" });
	});

	it("用户取消时仍隐藏答案且不误报超时", () => {
		const details = extractAskQuestionDetails(
			"ask",
			{
				details: {
					question: "选择实现方向",
					options: ["方案 A", "方案 B"],
					selectedOptions: ["方案 B"],
					timedOut: true,
				},
			},
			undefined,
		);
		const card = buildAskCard(details, true) as Record<string, unknown>;

		expect(card.answered).toBe(false);
		expect(card.answer).toBeNull();
		expect(card.timedOut).toBe(false);
	});
});
