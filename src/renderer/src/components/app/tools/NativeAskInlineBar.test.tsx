// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeAskInlineBar } from "./AskQuestionCard";
import { setI18nLocale } from "../../../i18n";
import type { AgentUiAskAnswer, AgentUiAskQuestion } from "../../../../../shared/types";

const QUESTIONS: AgentUiAskQuestion[] = [
	{
		id: "scope",
		header: "范围",
		question: "先改哪些模块？",
		multi: true,
		options: [
			{ label: "主进程", description: "IPC 与进程管理" },
			{ label: "渲染层" },
		],
	},
	{
		id: "style",
		header: "风格",
		question: "选择实现风格",
		recommended: 1,
		options: [{ label: "激进重构" }, { label: "保守修复" }],
	},
];

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(textarea, value);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("NativeAskInlineBar", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		setI18nLocale("zh-CN");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("多题按顺序提交 answers：多选 + 自定义补充 + 单选推荐项", () => {
		const onSubmit = vi.fn<(answers: AgentUiAskAnswer[]) => void>();
		act(() => {
			root.render(
				<NativeAskInlineBar
					questions={QUESTIONS}
					timeout={60_000}
					onSubmit={onSubmit}
					onCancel={() => undefined}
				/>,
			);
		});

		act(() => {
			container.querySelectorAll<HTMLButtonElement>('[role="option"]')[0].click();
		});
		act(() => {
			container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1].click();
		});
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
		expect(textarea).not.toBeNull();
		setTextareaValue(textarea!, "顺带补测试");

		act(() => {
			container.querySelector<HTMLButtonElement>(".ask-batch-nav-btn.primary")?.click();
		});

		// 第二题：推荐项带 badge，点选后整份问卷可提交。
		expect(container.textContent).toContain("推荐");
		act(() => {
			container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1].click();
		});
		act(() => {
			container.querySelector<HTMLButtonElement>(".ask-batch-submit-all-btn")?.click();
		});

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).toEqual([
			{ id: "scope", selectedOptions: ["主进程", "渲染层"], customInput: "顺带补测试" },
			{ id: "style", selectedOptions: ["保守修复"] },
		]);
	});

	it("单题单选点选项即提交", () => {
		const onSubmit = vi.fn<(answers: AgentUiAskAnswer[]) => void>();
		act(() => {
			root.render(
				<NativeAskInlineBar
					questions={[QUESTIONS[1]]}
					onSubmit={onSubmit}
					onCancel={() => undefined}
				/>,
			);
		});

		act(() => {
			container.querySelectorAll<HTMLButtonElement>('[role="option"]')[0].click();
		});

		expect(onSubmit).toHaveBeenCalledWith([
			{ id: "style", selectedOptions: ["激进重构"] },
		]);
	});
});
