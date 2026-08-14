import { describe, expect, test } from "vitest";
import { buildApi, type IpcBridge } from "./buildApi";
import { ipcTable, type IpcOpEntry } from "../shared/ipc";

interface BridgeCall {
	op: "invoke" | "send" | "sendSync";
	channel: string;
	args: unknown[];
}

function createFakeBridge() {
	const calls: BridgeCall[] = [];
	const listeners = new Map<string, Array<(event: unknown, payload: unknown) => void>>();
	const bridge: IpcBridge = {
		invoke: (channel, ...args) => {
			calls.push({ op: "invoke", channel, args });
			return Promise.resolve(undefined);
		},
		send: (channel, ...args) => {
			calls.push({ op: "send", channel, args });
		},
		sendSync: (channel, ...args) => {
			calls.push({ op: "sendSync", channel, args });
			return undefined;
		},
		on: (channel, listener) => {
			const list = listeners.get(channel) ?? [];
			list.push(listener);
			listeners.set(channel, list);
		},
		removeListener: (channel, listener) => {
			const list = (listeners.get(channel) ?? []).filter((l) => l !== listener);
			listeners.set(channel, list);
		},
	};
	return { bridge, calls, listeners };
}

describe("buildApi", () => {
	test("invoke member forwards channel and args", async () => {
		const { bridge, calls } = createFakeBridge();
		const api = buildApi(bridge);
		await api.editors.list();
		expect(calls[0]).toEqual({ op: "invoke", channel: "editors:list", args: [] });

		await api.files.delete("/a/b.ts", true);
		expect(calls[1]).toEqual({ op: "invoke", channel: "files:delete", args: ["/a/b.ts", true] });
	});

	test("pack member folds member args into one invoke arg", async () => {
		const { bridge, calls } = createFakeBridge();
		const api = buildApi(bridge);
		await api.skillHub.search("weather", 2, 10);
		expect(calls[0].channel).toBe("skill-hub:search");
		expect(calls[0].args).toEqual([{ query: "weather", page: 2, pageSize: 10, sortBy: undefined, order: undefined }]);

		// 缺省默认值：query 未传时打包为 {}
		await api.logs.list();
		expect(calls[1].channel).toBe("logs:list");
		expect(calls[1].args).toEqual([{}]);
	});

	test("subscribe member registers, delivers payload, and unsubscribes", () => {
		const { bridge, listeners } = createFakeBridge();
		const api = buildApi(bridge);
		const received: unknown[] = [];
		const off = api.agents.onState((payload) => received.push(payload));

		const registered = listeners.get("agents:state");
		expect(registered).toHaveLength(1);
		registered?.[0]?.({} as unknown, { id: "t1" });
		expect(received).toEqual([{ id: "t1" }]);

		off();
		expect(listeners.get("agents:state")).toHaveLength(0);
	});

	test("send member uses bridge.send", () => {
		const { bridge, calls } = createFakeBridge();
		const api = buildApi(bridge);
		api.pet.ready();
		expect(calls[0]).toEqual({ op: "send", channel: "pet:ready", args: [] });
	});

	test("local members are not generated (preload override layer owns them)", () => {
		const { bridge } = createFakeBridge();
		const api = buildApi(bridge) as unknown as Record<string, Record<string, unknown>>;
		expect(api.perf.enabled).toBeUndefined();
		expect(api.files.getPathForFile).toBeUndefined();
		expect(api.files.getClipboardPaths).toBeUndefined();
		expect(api.clipboard.writeText).toBeUndefined();
	});

	test("surface parity: every non-local table member is generated", () => {
		const { bridge } = createFakeBridge();
		const api = buildApi(bridge) as unknown as Record<string, Record<string, unknown>>;
		for (const [ns, members] of Object.entries(ipcTable)) {
			expect(api[ns], `namespace ${ns}`).toBeDefined();
			for (const [member, entry] of Object.entries(members)) {
				const op = entry as IpcOpEntry;
				if (op.kind === "local" || op.override) continue;
				expect(typeof api[ns][member], `${ns}.${member}`).toBe("function");
			}
		}
	});
});
