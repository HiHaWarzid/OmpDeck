import { describe, expect, it } from "vitest";
import type { AgentUiRequest } from "../../../../shared/types";
import { createSessionWorkspaceStore } from "../sessionWorkspace";
import { uiRequestActions, uiRequestSlice } from "./uiRequestSlice";

function request(overrides: Partial<AgentUiRequest> = {}): AgentUiRequest {
	return {
		requestId: "r1",
		agentId: "agent-a",
		method: "select",
		...overrides,
	} as AgentUiRequest;
}

describe("uiRequestSlice", () => {
	it("seed 返回共享空列表", () => {
		expect(uiRequestSlice.seed("tab").requests).toBe(uiRequestSlice.seed("tab").requests);
	});

	it("upsert 新增追加、同 requestId 就地替换", () => {
		let state = uiRequestSlice.seed("tab");
		const first = request({ title: "旧" });
		state = uiRequestSlice.reduce(state, uiRequestActions.upsert(first));
		const second = request({ requestId: "r2" });
		state = uiRequestSlice.reduce(state, uiRequestActions.upsert(second));
		expect(state.requests.map((item) => item.requestId)).toEqual(["r1", "r2"]);

		const updated = request({ title: "新" });
		state = uiRequestSlice.reduce(state, uiRequestActions.upsert(updated));
		expect(state.requests).toHaveLength(2);
		expect(state.requests[0].title).toBe("新");
	});

	it("同一请求对象重复到达返回原引用", () => {
		const first = request();
		const state = uiRequestSlice.reduce(uiRequestSlice.seed("tab"), uiRequestActions.upsert(first));
		expect(uiRequestSlice.reduce(state, uiRequestActions.upsert(first))).toBe(state);
	});

	it("remove 未知 requestId 与外部动作空转", () => {
		const state = uiRequestSlice.reduce(
			uiRequestSlice.seed("tab"),
			uiRequestActions.upsert(request()),
		);
		expect(uiRequestSlice.reduce(state, uiRequestActions.remove("missing"))).toBe(state);
		expect(uiRequestSlice.reduce(state, { type: "queue/append" })).toBe(state);
	});

	it("按条目隔离，agent 关闭后待答请求随条目回收", () => {
		const store = createSessionWorkspaceStore();
		store.joinTab("agent-a");
		store.joinTab("agent-b");
		store.dispatchTo("agent-a", uiRequestActions.upsert(request({ agentId: "agent-a" })));
		store.dispatchTo("agent-b", uiRequestActions.upsert(request({ agentId: "agent-b", requestId: "r2" })));
		expect(store.getSlice("agent-a", "uiRequest")?.requests).toHaveLength(1);

		store.leave("agent-a");
		expect(store.getSlice("agent-a", "uiRequest")).toBeUndefined();
		expect(store.getSlice("agent-b", "uiRequest")?.requests).toHaveLength(1);
	});
});
