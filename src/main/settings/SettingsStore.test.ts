/**
 * SettingsStore afk 块归一化单测：normalizeAfkSettings 是 load()/update() 的单一事实源，
 * 覆盖旧 targetProjectId 单值迁移、非数组回落、非法数值钳制、默认补齐、字符串校验。
 * electron 仅被 mock 为模块加载所需的最小面（normalize 本身是纯函数，不触达 app）。
 */
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { normalizeAfkSettings, type AfkSettingsInput } from "./SettingsStore";

vi.mock("electron", () => ({
	app: {
		getPath: () => "C:/vitest-settings-userdata",
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