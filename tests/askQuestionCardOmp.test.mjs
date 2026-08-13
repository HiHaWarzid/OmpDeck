import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadAskModule() {
	const source = readFileSync("src/main/pi/askQuestionCard.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "askQuestionCard.ts",
	});
	return sandbox.exports;
}

test("omp ask 单题：selectedOptions + customInput 映射为答案", () => {
	const { extractAskQuestionDetails, buildAskCard } = loadAskModule();
	const details = extractAskQuestionDetails(
		"ask",
		{
			content: [{ type: "text", text: "Selected: A" }],
			details: {
				question: "选择认证方式",
				options: ["A", "B"],
				multi: false,
				selectedOptions: ["A"],
				customInput: undefined,
				note: undefined,
			},
		},
		{ questions: [{ id: "auth", question: "选择认证方式", options: [{ label: "A" }, { label: "B" }] }] },
	);
	assert.ok(details);
	assert.equal(details.question, "选择认证方式");
	assert.equal(details.answer, "A");
	assert.equal(details.answered, true);
	assert.equal(details.answerLabel, "A");
	assert.deepEqual(details.options, ["A", "B"]);

	const card = buildAskCard(details, false);
	assert.ok(card);
	assert.equal(card.answerLabel, "A");
	assert.equal(card.answered, true);
});

test("omp ask 单题：customInput 作为答案，无答案时未回答", () => {
	const { extractAskQuestionDetails } = loadAskModule();
	const withCustom = extractAskQuestionDetails(
		"ask",
		{ details: { question: "自定义输入", options: [], multi: false, selectedOptions: [], customInput: "我输入的内容" } },
		undefined,
	);
	assert.equal(withCustom.answer, "我输入的内容");
	assert.equal(withCustom.answered, true);

	const unanswered = extractAskQuestionDetails(
		"ask",
		{ details: { question: "未答", options: ["A"], multi: false, selectedOptions: [], customInput: undefined, timedOut: true } },
		undefined,
	);
	assert.equal(unanswered.answered, false);
});

test("omp ask 批量：results 映射为 questions + answers", () => {
	const { extractAskQuestionDetails, buildAskCard } = loadAskModule();
	const details = extractAskQuestionDetails(
		"ask",
		{
			content: [{ type: "text", text: "User answers: ..." }],
			details: {
				results: [
					{ id: "q1", question: "第一个问题", options: ["A", "B"], multi: false, selectedOptions: ["B"], customInput: undefined },
					{ id: "q2", question: "第二个问题", options: [], multi: true, selectedOptions: [], customInput: "补充说明" },
				],
			},
		},
		undefined,
	);
	assert.ok(details);
	assert.equal(details.questions.length, 2);
	assert.equal(details.answers.length, 2);
	assert.equal(details.answers[0].id, "q1");
	assert.equal(details.answers[0].value, "B");
	assert.equal(details.answers[1].value, "补充说明");

	const card = buildAskCard(details, false);
	assert.ok(card);
	assert.equal(card.type, "batch");
	assert.equal(card.items.length, 2);
	assert.equal(card.items[0].answered, true);
	assert.equal(card.items[0].answerLabel, "B");
	assert.equal(card.items[1].answerLabel, "补充说明");
});

test("非 ask 工具不匹配（read 不返回详情）", () => {
	const { extractAskQuestionDetails } = loadAskModule();
	assert.equal(extractAskQuestionDetails("read", { details: { question: "x" } }, {}), undefined);
	assert.equal(extractAskQuestionDetails("todo", { details: { results: [] } }, {}), undefined);
});

test("旧 ask_question 格式仍然兼容", () => {
	const { extractAskQuestionDetails } = loadAskModule();
	const details = extractAskQuestionDetails(
		"ask_question",
		{ details: { question: "旧格式问题", type: "input", answer: "旧答案", answered: true } },
		{},
	);
	assert.equal(details.question, "旧格式问题");
	assert.equal(details.answer, "旧答案");
});
