/**
 * SettingsStore afk 块归一化单测：normalizeAfkSettings 是 load()/update() 的单一事实源，
 * 覆盖旧 targetProjectId 单值迁移、非数组回落、非法数值钳制、默认补齐、字符串校验。
 * electron 仅被 mock 为模块加载所需的最小面（normalize 本身是纯函数，不触达 app）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, vi } from "vitest";
import { normalizeAfkSettings, SettingsStore, type AfkSettingsInput } from "./SettingsStore";

// userData 用可变持有者：save/load 往返用例要指向独立临时目录
// （vi.mock 工厂先于普通 const 执行 → vi.hoisted）。
const settingsPaths = vi.hoisted(() => ({ userData: "C:/vitest-settings-userdata" }));

vi.mock("electron", () => ({
	app: {
		getPath: () => settingsPaths.userData,
	},
	Menu: {
		setApplicationMenu: () => {},
	},
}));

const DEFAULTS = {
	pollIntervalMs: 60_000,
	timeoutMs: 30 * 60_000,
};

describe("normalizeAfkSettings", () => {
	test("空输入：整体回落默认值，enabled 为 false，targetProjectIds 为空数组", () => {
		const result = normalizeAfkSettings({});
		assert.deepEqual(result, {
			enabled: false,
			targetProjectIds: [],
			pollIntervalMs: DEFAULTS.pollIntervalMs,
			timeoutMs: DEFAULTS.timeoutMs,
		});
	});

	test("legacy 迁移：单值 targetProjectId 迁移为 targetProjectIds 数组", () => {
		const input: AfkSettingsInput = { targetProjectId: "proj-1", enabled: true };
		const result = normalizeAfkSettings(input);
		assert.deepEqual(result.targetProjectIds, ["proj-1"]);
		assert.equal(result.enabled, true);
	});

	test("非数组 targetProjectIds 回落：字符串/对象/数字形状 → []", () => {
		assert.deepEqual(normalizeAfkSettings({ targetProjectIds: "proj-1" as unknown as string[] }).targetProjectIds, []);
		assert.deepEqual(normalizeAfkSettings({ targetProjectIds: 42 as unknown as string[] }).targetProjectIds, []);
		assert.deepEqual(normalizeAfkSettings({ targetProjectIds: { 0: "x" } as unknown as string[] }).targetProjectIds, []);
	});

	test("数组内元素只保留字符串：混入数字/null/undefined 被过滤", () => {
		const result = normalizeAfkSettings({
			targetProjectIds: ["a", 123, null, undefined, "b"] as unknown as string[],
		});
		assert.deepEqual(result.targetProjectIds, ["a", "b"]);
	});

	test("legacy 单值优先于非数组 targetProjectIds（旧存档两字段并存时取迁移值）", () => {
		const result = normalizeAfkSettings({
			targetProjectId: "legacy-id",
			targetProjectIds: "stale" as unknown as string[],
		});
		assert.deepEqual(result.targetProjectIds, ["legacy-id"]);
	});

	test("非法数值钳制：0/负数/NaN/非数字回落默认，正数保留", () => {
		assert.equal(normalizeAfkSettings({ pollIntervalMs: 0 }).pollIntervalMs, DEFAULTS.pollIntervalMs);
		assert.equal(normalizeAfkSettings({ pollIntervalMs: -5 }).pollIntervalMs, DEFAULTS.pollIntervalMs);
		assert.equal(normalizeAfkSettings({ timeoutMs: 0 }).timeoutMs, DEFAULTS.timeoutMs);
		assert.equal(normalizeAfkSettings({ timeoutMs: Number.NaN }).timeoutMs, DEFAULTS.timeoutMs);
		assert.equal(normalizeAfkSettings({ timeoutMs: "x" as unknown as number }).timeoutMs, DEFAULTS.timeoutMs);
		assert.equal(normalizeAfkSettings({ pollIntervalMs: 5000 }).pollIntervalMs, 5000);
		assert.equal(normalizeAfkSettings({ timeoutMs: 3_600_000 }).timeoutMs, 3_600_000);
	});

	test("未显式传字段时补默认：只传 enabled 也会带全量默认字段", () => {
		const result = normalizeAfkSettings({ enabled: true });
		assert.equal(result.enabled, true);
		assert.deepEqual(result.targetProjectIds, []);
		assert.equal(result.pollIntervalMs, DEFAULTS.pollIntervalMs);
		assert.equal(result.timeoutMs, DEFAULTS.timeoutMs);
	});

	test("幂等：已归一化的形状再归一化不改变结果", () => {
		const once = normalizeAfkSettings({ targetProjectIds: ["a", "b"], pollIntervalMs: 7000, timeoutMs: 900_000, enabled: true });
		const twice = normalizeAfkSettings(once);
		assert.deepEqual(twice, once);
	});
});

describe("SettingsStore 原子落盘与重读", () => {
	/** 每个用例独立 userData；afterEach 恢复默认避免污染其它用例。 */
	async function withTempUserData(run: (dir: string) => Promise<void>): Promise<void> {
		const dir = await mkdtemp(join(tmpdir(), "settings-store-"));
		settingsPaths.userData = dir;
		try {
			await run(dir);
		} finally {
			settingsPaths.userData = "C:/vitest-settings-userdata";
			await rm(dir, { recursive: true, force: true });
		}
	}

	test("save/load 往返：update 的字段落盘后新实例读回，showThinking 不落盘", async () => {
		await withTempUserData(async (dir) => {
			const store = new SettingsStore();
			await store.load();
			await store.update({ theme: "dark", uiFontSize: "large" });
			await store.flushSave();

			const onDisk: unknown = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
			assert.equal((onDisk as { theme?: string }).theme, "dark");
			// showThinking 由 pi agent 的 hideThinkingBlock 决定，不属于桌面持久化字段
			assert.equal("showThinking" in (onDisk as Record<string, unknown>), false);

			const reloaded = new SettingsStore();
			await reloaded.load();
			assert.equal(reloaded.get().theme, "dark");
			assert.equal(reloaded.get().uiFontSize, "large");
		});
	});

	test("损坏的 settings.json 整体回落默认值，不抛错", async () => {
		await withTempUserData(async (dir) => {
			await writeFile(join(dir, "settings.json"), "{ 半个 JSON", "utf8");
			const store = new SettingsStore();
			await store.load();
			assert.equal(store.get().theme, "system");
		});
	});
});