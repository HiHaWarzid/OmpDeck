/**
 * 注册循环的失败契约收口（batch 6a）。
 *
 * 断言三件事：
 * 1. invoke 成员的 handler 全部被同一包装收敛：成功 → { ok: true, value }，
 *    抛错 → { ok: false, kind, message }，message 是原始干净信息（不含 Electron 包装）。
 * 2. 命令层已分类的 CommandError.kind（timeout / not-found / command）原样过界，其余归 "unknown"。
 * 3. 「不允许有 handler 绕过包装」是行为证明而非源码正则：用真实通道表生成的全部 invoke 成员
 *    注册后，ipcMain.handle 的调用恰好等于表内 invoke 条目数，且逐个调用都返回 envelope；
 *    send 成员则只出现在 ipcMain.on 上（形状与历史一致）。
 */
import { describe, expect, test, vi } from "vitest";

interface Registration {
	channel: string;
	fn: (event: unknown, ...args: unknown[]) => unknown;
}

// 假 ipcMain 记录注册面；vi.mock 工厂先于普通 import 执行，故状态放 vi.hoisted 里共享。
const { handleCalls, onCalls } = vi.hoisted(() => ({
	handleCalls: [] as Array<{ channel: string; fn: (event: unknown, ...args: unknown[]) => unknown }>,
	onCalls: [] as Array<{ channel: string; fn: (event: unknown, ...args: unknown[]) => unknown }>,
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
			handleCalls.push({ channel, fn });
		},
		on: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
			onCalls.push({ channel, fn });
		},
	},
}));

import { ipcTable, type IpcOpEntry } from "../../shared/ipc";
import { CommandError } from "../utils/CommandRunner";
import { registerIpcHandlers, type IpcHandlerMaps } from "./registerIpc";

const table = ipcTable as Record<string, Record<string, IpcOpEntry>>;

function channelOf(namespace: string, member: string): string {
	const channel = table[namespace]?.[member]?.channel;
	if (!channel) throw new Error(`通道表缺少 ${namespace}.${member}`);
	return channel;
}

/** 三个分类各挑一个真实 invoke 成员做断言样本，其余成员统一抛 command 类错误。 */
const SUCCESS_MEMBER = "editors.list";
const TIMEOUT_MEMBER = "files.delete";
const NOT_FOUND_MEMBER = "git.branches";
const PLAIN_ERROR_MEMBER = "settings.get";

/** 上面四个样本成员由各自用例逐一断言，sweep 只覆盖其余 invoke 成员。 */
const SAMPLE_MEMBERS: Record<string, true> = {
	[SUCCESS_MEMBER]: true,
	[TIMEOUT_MEMBER]: true,
	[NOT_FOUND_MEMBER]: true,
	[PLAIN_ERROR_MEMBER]: true,
};

const ENVELOPE_VALUE = { editors: ["vscode"] };

/**
 * 用真实通道表生成 map：每个 invoke 成员一个 handler（样本成员按上面挑分类，其余抛 command），
 * 另加一个 send 成员证明 send 系不经 envelope。
 */
function handlerMapsFromTable(): IpcHandlerMaps {
	const maps: IpcHandlerMaps = {};
	for (const [namespace, members] of Object.entries(table)) {
		const invokes: Record<string, (...args: never[]) => unknown> = {};
		for (const [member, entry] of Object.entries(members)) {
			if (entry.kind !== "invoke") continue;
			const key = `${namespace}.${member}`;
			if (key === SUCCESS_MEMBER) {
				invokes[member] = async () => ENVELOPE_VALUE;
			} else if (key === TIMEOUT_MEMBER) {
				invokes[member] = async () => {
					throw new CommandError("timeout", "git status timed out after 30000ms: ");
				};
			} else if (key === NOT_FOUND_MEMBER) {
				invokes[member] = async () => {
					throw new CommandError("not-found", "git status failed: spawn git ENOENT，请检查 PATH 或是否安装 git");
				};
			} else if (key === PLAIN_ERROR_MEMBER) {
				invokes[member] = async () => {
					throw new Error("boom");
				};
			} else {
				invokes[member] = async () => {
					throw new CommandError("command", `${key} failed`);
				};
			}
		}
		if (Object.keys(invokes).length > 0) maps[namespace] = invokes;
	}
	return maps;
}

const invokeEntries = Object.entries(table).flatMap(([namespace, members]) =>
	Object.entries(members)
		.filter(([, entry]) => entry.kind === "invoke")
		.map(([member]) => ({ namespace, member, channel: channelOf(namespace, member) })),
);

registerIpcHandlers(handlerMapsFromTable(), { pet: { ready: () => {} } });

// 冻结注册快照：后续「表外成员抛错」用例会再调一次 registerIpcHandlers（它只抛错不注册）
const registeredHandles: Registration[] = [...handleCalls];
const registeredOns: Registration[] = [...onCalls];

function callHandler(channel: string, ...args: unknown[]): Promise<unknown> {
	const registration = registeredHandles.find((call) => call.channel === channel);
	if (!registration) throw new Error(`未注册 invoke 通道: ${channel}`);
	return Promise.resolve(registration.fn({}, ...args));
}

describe("registerIpcHandlers：invoke 统一收敛成失败契约", () => {
	test("成功 → { ok: true, value }，value 即 handler 原始返回值", async () => {
		const result = await callHandler(channelOf("editors", "list"));
		expect(result).toEqual({ ok: true, value: ENVELOPE_VALUE });
	});

	test("CommandError(timeout) → kind 保持 timeout，message 为原始干净信息", async () => {
		const result = await callHandler(channelOf("files", "delete"), "/a/b.ts", true);
		expect(result).toEqual({
			ok: false,
			kind: "timeout",
			message: "git status timed out after 30000ms: ",
		});
	});

	test("CommandError(not-found) → kind 保持 not-found（git 未安装的安装指引不被丢弃）", async () => {
		const result = await callHandler(channelOf("git", "branches"), "p1");
		expect(result).toEqual({
			ok: false,
			kind: "not-found",
			message: "git status failed: spawn git ENOENT，请检查 PATH 或是否安装 git",
		});
	});

	test("普通 Error → kind unknown，message 不含 Electron 的包装文本", async () => {
		const result = await callHandler(channelOf("settings", "get"));
		expect(result).toEqual({ ok: false, kind: "unknown", message: "boom" });
		// 失败以返回值过界，Electron 无从包装：message 里必然找不到包装句子
		expect(JSON.stringify(result)).not.toContain("invoking remote method");
	});

	test("send 成员只注册到 ipcMain.on，不经 envelope（形状与历史一致）", () => {
		expect(registeredOns.map((call) => call.channel)).toEqual([channelOf("pet", "ready")]);
		expect(registeredHandles.map((call) => call.channel)).not.toContain(channelOf("pet", "ready"));
	});

	test("表内每个 invoke 成员都被包装：handle 调用数 = invoke 条目数，逐个调用都返回 envelope", async () => {
		expect(invokeEntries.length).toBeGreaterThan(0);
		// 恰好一次/成员：没有成员漏包装，也没有包装之外的第二次 handle 注册
		expect(registeredHandles.map((call) => call.channel).sort()).toEqual(
			invokeEntries.map((entry) => entry.channel).sort(),
		);

		let swept = 0;
		for (const entry of invokeEntries) {
			const key = `${entry.namespace}.${entry.member}`;
			if (SAMPLE_MEMBERS[key]) continue;
			const result = await callHandler(entry.channel);
			expect(result, key).toEqual({ ok: false, kind: "command", message: `${key} failed` });
			swept++;
		}
		// 覆盖度自检：除四个样本外全部成员都真的走了一遍 envelope
		expect(swept).toBe(invokeEntries.length - Object.keys(SAMPLE_MEMBERS).length);
	});

	test("表外成员直接抛错（防止裸注册绕过通道表）", () => {
		expect(() => registerIpcHandlers({ editors: { notInTable: () => undefined } })).toThrow(
			"IPC 通道表缺失条目: editors.notInTable",
		);
	});
});
