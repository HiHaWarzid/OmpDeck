import assert from "node:assert/strict";
import { test } from "vitest";

import type { AgentRuntimeState } from "../../shared/types";
import { AgentControl, normalizeTodoPhases, type AgentControlHost, type ControlRuntime } from "./agentControl";
import type { RpcResponse } from "./PiRpcClient";

type Recorded = { command: Record<string, unknown>; timeoutMs?: number };

/** 最小运行时替身：只实现控制模块用到的 request / lastModelSelection。 */
function makeControl(respond: (command: Record<string, unknown>) => RpcResponse | Promise<RpcResponse>) {
	const requests: Recorded[] = [];
	const runtime = {
		slot: {
			process: {
				client: {
					request: async (command: Record<string, unknown>, timeoutMs?: number) => {
						requests.push({ command, timeoutMs });
						return respond(command);
					},
				},
			},
		},
		lastModelSelection: undefined as ControlRuntime["lastModelSelection"],
	};
	const reloaded: string[] = [];
	let stateReads = 0;
	let emitted = 0;
	const state = { agentId: "a1", status: "idle" } as unknown as AgentRuntimeState;
	const host: AgentControlHost = {
		runtime: () => runtime,
		readState: async () => {
			stateReads += 1;
			return state;
		},
		reloadTranscript: async (agentId) => {
			reloaded.push(agentId);
		},
		emitState: () => {
			emitted += 1;
		},
	};
	return {
		control: new AgentControl(host),
		requests,
		runtime,
		state,
		readonly: {
			stateReads: () => stateReads,
			emitted: () => emitted,
			reloaded: () => reloaded,
		},
	};
}

const ok = (data?: unknown): RpcResponse => ({ type: "response", command: "", success: true, data });

test("apply：写操作以 get_state 回读为准，并记住用户显式选择的模型", async () => {
	const { control, requests, runtime, state } = makeControl(() => ok());
	const result = await control.apply("a1", { kind: "model", provider: "anthropic", modelId: "claude" });

	assert.equal(result, state);
	assert.deepEqual(requests[0], {
		command: { type: "set_model", provider: "anthropic", modelId: "claude" },
		timeoutMs: 60_000,
	});
	assert.deepEqual(runtime.lastModelSelection, { provider: "anthropic", modelId: "claude" });
});

test("apply：服务档 success:false 必须抛错，不能静默当成成功", async () => {
	const { control, readonly } = makeControl((command) =>
		command.type === "set_fast_mode"
			? { type: "response", command: "set_fast_mode", success: false, error: " provider has no priority tier " }
			: ok(),
	);

	await assert.rejects(
		() => control.apply("a1", { kind: "service-tier", tier: "fast", enabled: true }),
		/provider has no priority tier/,
	);
	assert.equal(readonly.stateReads(), 0);
});

test("apply：todos 下发前做五态归一化，非法条目被丢弃", async () => {
	const { control, requests } = makeControl(() => ok());
	await control.apply("a1", {
		kind: "todos",
		phases: [
			{
				name: "P",
				tasks: [
					{ content: "X", status: "in_progress", blocker: "waiting CI" },
					{ content: "Y", status: "bogus" as never },
					{ content: "", status: "pending" },
				],
			},
		],
	});

	assert.deepEqual(requests[0]?.command, {
		type: "set_todos",
		phases: [{ name: "P", tasks: [{ content: "X", status: "in_progress", blocker: "waiting CI" }] }],
	});
});

test("models：非 chat 条目被过滤，旧目录缺 kind 时按可对话保留", async () => {
	const { control } = makeControl(() =>
		ok({
			models: [
				{ provider: "p", id: "chat-model", kind: "chat" },
				{ provider: "p", id: "embed", kind: "embedding" },
				{ provider: "p", id: "legacy" },
			],
		}),
	);

	const models = await control.models("a1");
	assert.deepEqual(models.map((model) => model.id), ["chat-model", "legacy"]);
});

test("thinkingLevels：老版本返回形状不对时退化成空数组，让渲染层回退内置档位", async () => {
	const { control } = makeControl(() => ok({ levels: "high" }));
	assert.deepEqual(await control.thinkingLevels("a1"), []);
});

test("refresh：reload_config 不可用时不重载会话，但状态仍然可用", async () => {
	const { control, readonly, state: expected } = makeControl(() => {
		throw new Error("unknown command");
	});

	const state = await control.refresh("a1");
	assert.equal(state, expected);
	assert.deepEqual(readonly.reloaded(), []);
	assert.equal(readonly.emitted(), 1);
});

test("refresh：reload_config 成功后重载会话消息", async () => {
	const { control, readonly } = makeControl(() => ok());
	await control.refresh("a1");
	assert.deepEqual(readonly.reloaded(), ["a1"]);
});

test("normalizeTodoPhases：保留 blocker/details/notes，未知状态不写入会话", () => {
	const phases = normalizeTodoPhases([
		{
			name: "P",
			tasks: [
				{ content: "A", status: "blocked", blocker: "need key", details: "d", notes: ["n", 3] },
				{ content: "B", status: "unknown" },
			],
		},
		{ name: 42, tasks: [] },
	]);

	assert.deepEqual(phases, [
		{ name: "P", tasks: [{ content: "A", status: "blocked", blocker: "need key", details: "d", notes: ["n"] }] },
	]);
});
