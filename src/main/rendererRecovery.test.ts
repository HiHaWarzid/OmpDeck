import assert from "node:assert/strict";
import { test } from "vitest";

import {
	RENDERER_RECOVERY_MAX_ATTEMPTS,
	RENDERER_RECOVERY_WINDOW_MS,
	decideRendererRecovery,
} from "./rendererRecovery";

test("窗口内前几次崩溃自动恢复，达到上限后交回用户", () => {
	let attempts: number[] = [];
	let now = 1_000_000;
	for (let i = 1; i <= RENDERER_RECOVERY_MAX_ATTEMPTS; i += 1) {
		const decision = decideRendererRecovery(attempts, now);
		assert.equal(decision.action, "reload");
		assert.equal(decision.attempts.length, i);
		attempts = decision.attempts;
		now += 1_000;
	}

	const exhausted = decideRendererRecovery(attempts, now);
	assert.equal(exhausted.action, "prompt");
	// 超限分支不追加时间戳，避免用户点「再试一次」后立刻又落到超限
	assert.deepEqual(exhausted.attempts, attempts);
});

test("滑出窗口的旧尝试不再计数：长时间稳定运行后的新崩溃仍会自动恢复", () => {
	const attempts = [1_000_000, 1_000_100, 1_000_200];
	const decision = decideRendererRecovery(attempts, 1_000_200 + RENDERER_RECOVERY_WINDOW_MS + 1);

	assert.equal(decision.action, "reload");
	assert.deepEqual(decision.attempts, [1_000_200 + RENDERER_RECOVERY_WINDOW_MS + 1]);
});

test("窗口边界：恰好等于窗口的尝试不再计入，本次仍可自动恢复", () => {
	const attempts = [0, 1, 2];
	const now = RENDERER_RECOVERY_WINDOW_MS;
	const decision = decideRendererRecovery(attempts, now);

	assert.equal(decision.action, "reload");
	// 时间戳 0 恰好滑出窗口（now - 0 === 窗口宽度），只剩 1、2 与本次
	assert.deepEqual(decision.attempts, [1, 2, now]);
});
