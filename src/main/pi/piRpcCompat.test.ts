import { describe, expect, it } from "vitest";
import type { PiRpcClient, RpcResponse } from "./PiRpcClient";
import { classifyPiFailure, requestPiCommand } from "./piRpcCompat";

/** 只实现 request 的假客户端：按命令名返回预设响应，并记录调用顺序。 */
function fakeClient(responses: Record<string, RpcResponse>) {
	const calls: Array<{ type: string; timeoutMs?: number }> = [];
	const client = {
		request: async (request: Record<string, unknown>, timeoutMs?: number) => {
			const type = String(request.type);
			calls.push({ type, timeoutMs });
			const response = responses[type];
			if (!response) return { type: "response", command: type, success: false, error: `Unknown command: ${type}` } satisfies RpcResponse;
			return response;
		},
	} as unknown as PiRpcClient;
	return { client, calls };
}

const ok = (command: string, data?: unknown): RpcResponse => ({ type: "response", command, success: true, data });

describe("classifyPiFailure", () => {
	it("separates unknown command from transport limit and other errors", () => {
		expect(classifyPiFailure({ type: "response", command: "x", success: false, error: "Unknown command: get_commands" })).toBe("unknown-command");
		expect(classifyPiFailure({ type: "response", command: "x", success: false, error: "Response exceeded transport limit" })).toBe("transport-limit");
		expect(classifyPiFailure({ type: "response", command: "x", success: false, error: "session busy" })).toBe("other");
		expect(classifyPiFailure(undefined)).toBe("other");
	});
});

describe("requestPiCommand", () => {
	it("uses the new command name and never touches the legacy alias", async () => {
		const { client, calls } = fakeClient({ get_available_commands: ok("get_available_commands", { commands: [] }) });
		const result = await requestPiCommand(client, "get_available_commands");
		expect(result.command).toBe("get_available_commands");
		expect(calls.map((call) => call.type)).toEqual(["get_available_commands"]);
	});

	it("falls back to the legacy name only on Unknown command", async () => {
		const { client, calls } = fakeClient({ get_commands: ok("get_commands", { commands: [{ name: "x" }] }) });
		const result = await requestPiCommand(client, "get_available_commands");
		expect(result.command).toBe("get_commands");
		expect(result.response.success).toBe(true);
		expect(calls.map((call) => call.type)).toEqual(["get_available_commands", "get_commands"]);
	});

	it("does not retry the legacy name on real failures (timeout, busy session)", async () => {
		const { client, calls } = fakeClient({
			fork: { type: "response", command: "fork", success: false, error: "session is busy" },
		});
		const result = await requestPiCommand(client, "fork", { params: { entryId: "e1" } });
		expect(result.response.success).toBe(false);
		expect(result.response.error).toBe("session is busy");
		expect(calls.map((call) => call.type)).toEqual(["fork"]);
	});

	it("caches the resolved name per client so later calls stop issuing failing requests", async () => {
		const { client, calls } = fakeClient({ clone: ok("clone") });
		await requestPiCommand(client, "fork");
		await requestPiCommand(client, "fork");
		expect(calls.map((call) => call.type)).toEqual(["fork", "clone", "clone"]);
	});

	it("reports the last failure when no candidate name is known by this pi", async () => {
		const { client } = fakeClient({});
		const result = await requestPiCommand(client, "get_branch_messages");
		expect(result.response.success).toBe(false);
		expect(classifyPiFailure(result.response)).toBe("unknown-command");
	});
});
