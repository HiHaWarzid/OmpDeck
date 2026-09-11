import assert from "node:assert/strict";
import { test } from "vitest";
import { createSingleFlight } from "./singleFlight";

/**
 * 单飞 + 尾随重跑契约。
 *
 * 对应 App 的失同步自愈：若不去重，每个 50ms delta 都会发起一次全量 transcript
 * IPC；若只是丢弃重复触发，则最后一次失同步可能永远得不到补拉。
 *
 * 全部用 deferred 驱动、以「执行发生」为同步点，不引入真实计时器。
 */

test("executes immediately on first call", async () => {
	const run = createSingleFlight();
	const done = Promise.withResolvers<void>();
	run("a", async () => {
		done.resolve();
	});
	await done.promise;
});

test("coalesces concurrent calls into one in-flight execution plus one trailing run", async () => {
	const run = createSingleFlight();
	const gate = Promise.withResolvers<void>();
	const trailing = Promise.withResolvers<void>();
	let calls = 0;
	const fn = async () => {
		calls += 1;
		if (calls === 1) {
			await gate.promise;
			return;
		}
		trailing.resolve();
	};
	run("a", fn);
	// 在途期间连打三次：合并为一次尾随执行，而不是三次。
	run("a", fn);
	run("a", fn);
	run("a", fn);
	assert.equal(calls, 1, "only one execution while in flight");
	gate.resolve();
	await trailing.promise;
	assert.equal(calls, 2, "trailing run happens exactly once");
});

test("keys are independent", async () => {
	const run = createSingleFlight();
	const gate = Promise.withResolvers<void>();
	const started: string[] = [];
	const bDone = Promise.withResolvers<void>();
	run("a", async () => {
		started.push("a");
		await gate.promise;
	});
	run("b", async () => {
		started.push("b");
		bDone.resolve();
	});
	await bDone.promise;
	assert.deepEqual(started, ["a", "b"], "a different key must not be blocked");
	gate.resolve();
});

test("a rejected execution still releases the key", async () => {
	const run = createSingleFlight();
	const failed = Promise.withResolvers<void>();
	const recovered = Promise.withResolvers<void>();
	let calls = 0;
	run("a", async () => {
		calls += 1;
		failed.resolve();
		throw new Error("boom");
	});
	await failed.promise;
	run("a", async () => {
		calls += 1;
		recovered.resolve();
	});
	await recovered.promise;
	assert.equal(calls, 2, "failure must not wedge the key");
});
