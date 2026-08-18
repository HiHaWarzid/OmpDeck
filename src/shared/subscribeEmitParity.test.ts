import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ipcChannels, ipcTable, type IpcOpEntry, type IpcPushSource } from "./ipc";

/**
 * 订阅通道推送源对齐测试（生成式）——死通道防线。
 *
 * 方法说明（“活 emitter”判定）：
 * - 表内每个 subscribe 条目必须声明 pushFrom（主进程推送来源模块），
 *   推送来源没有内置类型强制（条目按 IpcOpEntry 平铺），由本测试逐条核对。
 * - PUSH_SOURCE_FILES 把 pushFrom 短名映射到 src/main 下的模块文件。
 * - 判定“模块里存在活的发送点”：读取该模块源码文本，断言其中出现
 *   (a) 通道字面量（如 "agents:runtime-state"），或
 *   (b) 该通道在 ipcChannels 中的派生扁平键（如 agentsRuntimeState）——
 *   主进程侧统一经 `ipcChannels.<键>` / `C.<键>` 引用发送，故键名命中即证明
 *   该模块存在 `webContents.send(...)` / `emit(...)` 发送点。
 *   通道字面量或键名二者其一命中即通过；两者皆无 → 声明了却无人推送 → 死通道 → CI 失败。
 *
 * 双用途配对（invoke 拉取 + subscribe 推送同通道）：
 * - 以表内 pairKey 为准（约定值 = 共享通道名），取代“靠通道名巧合推断配对”的隐式耦合。
 * - 反向完整性：任何同时被 invoke 与 subscribe 使用的通道字符串不得脱离 pairKey 存在，
 *   杜绝未显式配对的同通道双用途条目。
 *
 * 死通道注册表：
 * - 历史上被清理的通道不允许重新入表（原 ipc.test.ts 手写的 3 名断言，
 *   由本注册表以可扩展列表形式承接——新增死通道只需往 KNOWN_DEAD_CHANNELS 加一行）。
 */

/** pushFrom 短名 → src/main 下模块文件（相对路径）。新增订阅通道时若推送源不在列，先扩展此映射。 */
const PUSH_SOURCE_FILES: Readonly<Record<IpcPushSource, string>> = {
	"agent-manager": "pi/AgentManager.ts",
	"feishu-bridge": "feishu/FeishuBridge.ts",
	"feishu-handlers": "ipc/feishuHandlers.ts",
	"pet-index": "pet/index.ts",
	"pet-patrol": "pet/PetPatrol.ts",
	"pet-state-bridge": "pet/PetStateBridge.ts",
	"terminal-manager": "terminal/TerminalSessionManager.ts",
	"update-manager": "update/UpdateManager.ts",
	"settings-store": "settings/SettingsStore.ts",
	"link-opener": "links/LinkOpener.ts",
	"project-handlers": "ipc/projectHandlers.ts",
	"afk-orchestrator": "afk/AfkOrchestrator.ts",
	"main-index": "index.ts",
};

/** 历史上已清理、不允许重新入表的死通道（原 ipc.test.ts 手写 3 名断言承接处）。 */
const KNOWN_DEAD_CHANNELS: readonly string[] = ["skill-store:get", "feishu:qr-code", "feishu:auto-group"];

const MAIN_ROOT = join(process.cwd(), "src", "main");

/** 该通道在 ipcChannels 中的全部派生扁平键（主进程引用形态 ipcChannels.<key>）。 */
function ipcKeysForChannel(channel: string): string[] {
	return Object.entries(ipcChannels)
		.filter(([, value]) => value === channel)
		.map(([key]) => key);
}

function collectPairedEntries(): Map<string, Array<{ ns: string; member: string; entry: IpcOpEntry }>> {
	const pairs = new Map<string, Array<{ ns: string; member: string; entry: IpcOpEntry }>>();
	for (const [ns, members] of Object.entries(ipcTable)) {
		for (const [member, entry] of Object.entries(members) as Array<[string, IpcOpEntry]>) {
			if (entry.pairKey) {
				const list = pairs.get(entry.pairKey) ?? [];
				list.push({ ns, member, entry });
				pairs.set(entry.pairKey, list);
			}
		}
	}
	return pairs;
}

describe("subscribe 通道推送源对齐", () => {
	test("每个 subscribe 条目声明 pushFrom，且命名模块内存在活发送点（无死通道）", () => {
		let annotatedCount = 0;
		for (const [ns, members] of Object.entries(ipcTable)) {
			for (const [member, entry] of Object.entries(members) as Array<[string, IpcOpEntry]>) {
				if (entry.kind !== "subscribe") continue;
				annotatedCount += 1;
				expect(entry.channel, `${ns}.${member} subscribe 必须带 channel`).toBeDefined();
				expect(entry.pushFrom, `${ns}.${member} subscribe 必须声明 pushFrom`).toBeDefined();
				const source = entry.pushFrom!;
				const relPath = PUSH_SOURCE_FILES[source];
				expect(relPath, `${ns}.${member} pushFrom '${source}' 未在 PUSH_SOURCE_FILES 登记`).toBeDefined();
				const filePath = join(MAIN_ROOT, relPath);
				expect(existsSync(filePath), `推送源文件不存在: ${filePath}`).toBe(true);
				const sourceText = readFileSync(filePath, "utf8");
				const keys = ipcKeysForChannel(entry.channel!);
				const hasLiveSend =
					sourceText.includes(entry.channel!) || keys.some((key) => sourceText.includes(key));
				expect(
					hasLiveSend,
					`${ns}.${member} 声明通道 ${entry.channel}（源 ${source}）在 ${relPath} 中找不到发送引用 ` +
						`(无通道字面量，也无 ipcChannels.${keys.join("/")} 派生引用)——死通道`,
				).toBe(true);
			}
		}
		expect(annotatedCount).toBeGreaterThan(20); // 防误删：订阅通道规模回归护栏
	});

	test("非 subscribe 条目不得声明 pushFrom", () => {
		for (const [ns, members] of Object.entries(ipcTable)) {
			for (const [member, entry] of Object.entries(members) as Array<[string, IpcOpEntry]>) {
				if (entry.pushFrom) {
					expect(entry.kind, `${ns}.${member} pushFrom 仅限 subscribe 条目`).toBe("subscribe");
				}
			}
		}
	});

	test("死通道注册表：历史死通道不得重新入表", () => {
		const tableChannels = new Set<string>();
		for (const members of Object.values(ipcTable)) {
			for (const entry of Object.values(members) as IpcOpEntry[]) {
				if (entry.channel) tableChannels.add(entry.channel);
			}
		}
		for (const channel of KNOWN_DEAD_CHANNELS) {
			expect(tableChannels.has(channel), `死通道 ${channel} 不得重新入表`).toBe(false);
			expect(ipcKeysForChannel(channel), `死通道 ${channel} 不得重新出现在 ipcChannels`).toHaveLength(0);
		}
	});
});

describe("双用途通道配对显式化（pairKey）", () => {
	test("每个 pairKey 恰为 invoke+subscribe 两方，共享同一通道，pairKey = 通道名", () => {
		const pairs = collectPairedEntries();
		expect(pairs.size, "表中应存在双用途配对").toBeGreaterThan(0);
		for (const [pairKey, entries] of pairs) {
			expect(entries, `pairKey ${pairKey} 应恰有 invoke+subscribe 两方`).toHaveLength(2);
			const kinds = entries.map((e) => e.entry.kind).sort();
			expect(kinds, `pairKey ${pairKey} 应为 invoke + subscribe 对`).toEqual(["invoke", "subscribe"]);
			const [a, b] = entries;
			expect(a.entry.channel, `pairKey ${pairKey} 两方须共享同一 channel`).toBe(b.entry.channel);
			expect(pairKey, "pairKey 约定值 = 共享通道名").toBe(a.entry.channel);
			// 共享通道只派生一个键（值唯一性已被 ipcChannels 契约测试覆盖，这里补配对上下文断言）
			expect(ipcKeysForChannel(a.entry.channel!)).toHaveLength(1);
		}
	});

	test("同通道 invoke+subscribe 组合必须显式配对（无隐式双用途）", () => {
		const kindsByChannel = new Map<string, Set<string>>();
		for (const members of Object.values(ipcTable)) {
			for (const entry of Object.values(members) as IpcOpEntry[]) {
				if (!entry.channel) continue;
				const kinds = kindsByChannel.get(entry.channel) ?? new Set<string>();
				kinds.add(entry.kind);
				kindsByChannel.set(entry.channel, kinds);
			}
		}
		const pairedKeys = new Set(collectPairedEntries().keys());
		for (const [channel, kinds] of kindsByChannel) {
			if (kinds.has("invoke") && kinds.has("subscribe")) {
				expect(
					pairedKeys.has(channel),
					`通道 ${channel} 同时被 invoke+subscribe 使用，必须在表中显式声明 pairKey（不得靠通道名巧合隐式配对）`,
				).toBe(true);
			}
		}
	});
});