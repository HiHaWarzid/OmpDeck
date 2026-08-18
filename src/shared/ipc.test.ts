import { describe, expect, test } from "vitest";
import { ipcChannels, ipcTable, mainOnlyChannels, type IpcOpEntry } from "./ipc";

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

	test("裸串通道已入表（死通道清理由 subscribeEmitParity 的死通道注册表承接）", () => {
		expect(ipcChannels.agentsCommands).toBe("agents:commands");
	});

	test("历史兼容键保持历史名（调用点零感知）", () => {
		expect(ipcChannels.logsSize).toBe("logs:get-size");
		expect(ipcChannels.openCodeSessionsScan).toBe("opencode-sessions:scan");
		expect(ipcChannels.rpcLoggingSet).toBe("rpc-logs:logging-set");
		expect(ipcChannels.appToggleDevTools).toBe("app:toggle-devtools");
	});

	test("双用途通道配对显式化：pairKey 条目共享通道、只派生一个键", () => {
		// 由表推导（取代手写 pet:preview-mode / agents:runtime-state 两条硬编码）：
		// 每个 pairKey 恰两方（invoke + subscribe），共享同一通道，且该通道只派生一个扁平键。
		const pairs = new Map<string, Array<{ ns: string; member: string; entry: IpcOpEntry }>>();
		for (const [ns, members] of Object.entries(ipcTable)) {
			for (const [member, entry] of Object.entries(members)) {
				if (!entry.pairKey) continue;
				const list = pairs.get(entry.pairKey) ?? [];
				list.push({ ns, member, entry });
				pairs.set(entry.pairKey, list);
			}
		}
		expect(pairs.size, "表中应存在双用途配对（历史：pet:preview-mode、agents:runtime-state）").toBeGreaterThan(0);
		// 历史已声明的配对名保持派生形态（它们是表的直接事实，若通道改名此处同步失败）
		expect(ipcChannels.petPreviewMode).toBe("pet:preview-mode");
		expect(ipcChannels.agentsRuntimeState).toBe("agents:runtime-state");
		for (const [pairKey, entries] of pairs) {
			expect(entries, `pairKey ${pairKey} 应恰两方`).toHaveLength(2);
			expect(entries.map((e) => e.entry.kind).sort(), `pairKey ${pairKey} 应为 invoke+subscribe 对`).toEqual([
				"invoke",
				"subscribe",
			]);
			const [a, b] = entries;
			expect(a.entry.channel, `pairKey ${pairKey} 应共享同一 channel`).toBe(b.entry.channel);
			const derivedKeys = Object.entries(ipcChannels)
				.filter(([, value]) => value === a.entry.channel)
				.map(([key]) => key);
			expect(derivedKeys, `${pairKey} 双用途通道应只派生一个键`).toHaveLength(1);
		}
	});

	test("总通道数 = 260（263 - 3：删 browser:open-external，窗口三通道 minimize/toggle-maximize/close 收敛为 app:window-control）", () => {
		expect(Object.keys(ipcChannels).length).toBe(260);
	});
});
