/**
 * AFK 任务身份 (projectId, ticketRef) 与面板行投影单测。
 * 面板组件本身在 node 环境渲染不了（vitest environment=node，无 DOM），但它的行身份与
 * 增量 upsert 是纯投影（afkTaskKey / upsertAfkTask，见 shared/types/afk.ts），组件只负责把
 * 结果塞进 state —— 因此在这里直接测投影，覆盖的正是面板真实使用的口径。
 * 放在 src/main/afk 下：AFK 的全部验证收敛在 `npx vitest run src/main/afk` 一条命令里。
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	afkTaskKey,
	isProjectBound,
	upsertAfkTask,
	type AfkState,
	type AfkTask,
} from "../../shared/types";

function makeTask(overrides: Partial<AfkTask> & Pick<AfkTask, "ticketRef">): AfkTask {
	return { title: `#${overrides.ticketRef}`, status: "running", ...overrides };
}

describe("AFK 任务身份键（面板行身份 / 终止查找共用）", () => {
	test("同一编号在不同项目下是两个身份，同项目同编号才是同一个", () => {
		const a = afkTaskKey({ projectId: "proj-a", ticketRef: 42 });
		const b = afkTaskKey({ projectId: "proj-b", ticketRef: 42 });
		const aAgain = afkTaskKey({ projectId: "proj-a", ticketRef: 42 });
		assert.notEqual(a, b, "两个仓库的 #42 必须是两个身份");
		assert.equal(a, aAgain, "同项目同编号仍是同一个身份");
		assert.notEqual(afkTaskKey({ projectId: "proj-a", ticketRef: 42 }), afkTaskKey({ projectId: "proj-a", ticketRef: 43 }));
	});

	test("无项目（旧存档）的身份键不会与真实项目键相撞", () => {
		const unbound = afkTaskKey({ ticketRef: 42 });
		assert.notEqual(unbound, afkTaskKey({ projectId: "proj-a", ticketRef: 42 }));
		assert.notEqual(unbound, afkTaskKey({ projectId: "unbound", ticketRef: 42 }), "与同名项目 id 也不得相撞");
	});
});

describe("AFK 面板 upsert 投影", () => {
	const empty: AfkState = { tasks: [], enabled: true };

	test("同一编号在两个项目下产生两行", () => {
		const first = upsertAfkTask(empty, makeTask({ projectId: "proj-a", ticketRef: 42 }));
		const second = upsertAfkTask(first, makeTask({ projectId: "proj-b", ticketRef: 42 }));
		assert.equal(second.tasks.length, 2, "两个项目的 #42 应是两行，不能合并成一行");
		assert.deepEqual(
			second.tasks.map((task) => task.projectId).sort(),
			["proj-a", "proj-b"],
		);
	});

	test("同项目同编号的事件只覆盖对应那行，另一项目的行原样保留", () => {
		const state = upsertAfkTask(
			upsertAfkTask(empty, makeTask({ projectId: "proj-a", ticketRef: 42, status: "running" })),
			makeTask({ projectId: "proj-b", ticketRef: 42, status: "running" }),
		);
		const updated = upsertAfkTask(state, makeTask({ projectId: "proj-a", ticketRef: 42, status: "failed" }));

		assert.equal(updated.tasks.length, 2);
		assert.equal(updated.tasks.find((task) => task.projectId === "proj-a")!.status, "failed");
		assert.equal(updated.tasks.find((task) => task.projectId === "proj-b")!.status, "running");
	});

	test("unbound 旧任务的行身份独立于任何项目，不被同号事件覆盖", () => {
		const state = upsertAfkTask(empty, makeTask({ ticketRef: 42, status: "failed", unbound: true }));
		const withProject = upsertAfkTask(state, makeTask({ projectId: "proj-a", ticketRef: 42 }));
		assert.equal(withProject.tasks.length, 2, "无法归属的旧记录不能被同号的新任务顶掉");
	});
});

describe("AFK 任务项目绑定判定", () => {
	test("有 projectId 且未标 unbound 才算绑定（终止按钮与派发去重共用）", () => {
		assert.equal(isProjectBound(makeTask({ projectId: "proj-a", ticketRef: 1 })), true);
		assert.equal(isProjectBound(makeTask({ ticketRef: 1 })), false, "旧存档缺 projectId");
		assert.equal(isProjectBound(makeTask({ ticketRef: 1, unbound: true })), false, "已标记不可自动处理");
	});
});
