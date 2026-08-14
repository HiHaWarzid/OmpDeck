import { describe, expect, test } from "vitest";
import { ipcChannels, ipcTable, mainOnlyChannels } from "./ipc";

const VALID_KINDS = ["invoke", "subscribe", "send", "sendSync", "local"];
const CHANNEL_RE = /^[a-z0-9-]+:[a-z0-9-]+$/;

describe("IPC 通道表契约", () => {
	test("每个成员条目结构合法：kind 有效、非 local 必须带合法 channel", () => {
		for (const [ns, members] of Object.entries(ipcTable)) {
			for (const [member, entry] of Object.entries(members)) {
				expect(VALID_KINDS, `${ns}.${member} kind`).toContain(entry.kind);
				if (entry.kind !== "local") {
					expect(entry.channel, `${ns}.${member} channel`).toBeDefined();
					expect(entry.channel, `${ns}.${member} channel format`).toMatch(CHANNEL_RE);
				}
				if (entry.pack) {
					expect(entry.kind, `${ns}.${member} pack kind`).toBe("invoke");
				}
			}
		}
	});

	test("mainOnly 通道结构合法", () => {
		for (const entry of mainOnlyChannels) {
			expect(VALID_KINDS).toContain(entry.kind);
			expect(entry.channel).toMatch(CHANNEL_RE);
		}
	});

	test("派生 ipcChannels：键唯一、值唯一、数量 = 表通道 + mainOnly", () => {
		const entries = Object.entries(ipcChannels);
		const keys = entries.map(([k]) => k);
		const values = entries.map(([, v]) => v);
		expect(new Set(keys).size).toBe(keys.length);
		expect(new Set(values).size).toBe(values.length);
		const tableChannels = new Set<string>();
		for (const ns of Object.values(ipcTable)) {
			for (const entry of Object.values(ns)) {
				if (entry.channel) tableChannels.add(entry.channel);
			}
		}
		for (const entry of mainOnlyChannels) tableChannels.add(entry.channel);
		expect(keys.length).toBe(tableChannels.size);
	});

	test("死通道已清理、裸串通道已入表", () => {
		expect(ipcChannels.skillStoreGet).toBeUndefined();
		expect(ipcChannels.feishuQrCode).toBeUndefined();
		expect(ipcChannels.feishuAutoGroup).toBeUndefined();
		expect(ipcChannels.agentsCommands).toBe("agents:commands");
	});

	test("历史兼容键保持历史名（调用点零感知）", () => {
		expect(ipcChannels.logsSize).toBe("logs:get-size");
		expect(ipcChannels.openCodeSessionsScan).toBe("opencode-sessions:scan");
		expect(ipcChannels.rpcLoggingSet).toBe("rpc-logs:logging-set");
		expect(ipcChannels.appToggleDevTools).toBe("app:toggle-devtools");
	});

	test("双用途通道只派生一个键", () => {
		// pet:preview-mode 同时是 invoke（setPreviewMode）与 subscribe（onPreviewMode）
		expect(ipcChannels.petPreviewMode).toBe("pet:preview-mode");
		// agents:runtime-state 同时是 invoke（runtimeState）与 subscribe（onRuntimeState）
		expect(ipcChannels.agentsRuntimeState).toBe("agents:runtime-state");
	});

	test("总通道数 = 260（262 旧键 - 3 死通道 + 1 新增 agents:commands）", () => {
		expect(Object.keys(ipcChannels).length).toBe(260);
	});
});
