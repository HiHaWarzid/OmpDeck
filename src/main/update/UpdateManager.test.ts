import assert from "node:assert/strict";
import { test } from "node:test";

import {
	normalizeVersion,
	parseVersion,
	compareVersions,
	selectRecommendedAsset,
} from "./UpdateManager";
import type { AppUpdateAsset } from "../../shared/types";

// ── normalizeVersion ───────────────────────────────────

test("normalizeVersion removes v prefix", () => {
	assert.equal(normalizeVersion("v1.0.0"), "1.0.0");
	assert.equal(normalizeVersion("V2.3.4"), "2.3.4");
});

test("normalizeVersion trims whitespace", () => {
	assert.equal(normalizeVersion("  1.0.0  "), "1.0.0");
	assert.equal(normalizeVersion("\t1.0.0\n"), "1.0.0");
});

test("normalizeVersion leaves bare version unchanged", () => {
	assert.equal(normalizeVersion("1.0.0"), "1.0.0");
});

// ── parseVersion ───────────────────────────────────────

test("parseVersion parses simple semver", () =>	assert.deepEqual(parseVersion("1.2.3"), { main: [1, 2, 3], pre: [] }));

test("parseVersion parses pre-release", () => {
	const result = parseVersion("1.2.3-beta.1");
	assert.deepEqual(result.main, [1, 2, 3]);
	assert.deepEqual(result.pre, ["beta", 1]);
});

test("parseVersion handles v prefix and whitespace", () => {
	assert.deepEqual(parseVersion(" v1.0.0 "), { main: [1, 0, 0], pre: [] });
});

test("parseVersion treats pre-release separators consistently", () => {
	// 1.0.0-rc.2 has pre = ["rc", 2]
	const result = parseVersion("1.0.0-rc.2");
	assert.deepEqual(result.pre, ["rc", 2]);
});

// ── compareVersions ────────────────────────────────────

test("compareVersions returns 0 for equal versions", () => {
	assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
	assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
	assert.equal(compareVersions("  0.6.7 ", "0.6.7"), 0);
});

test("compareVersions distinguishes major/minor/patch", () => {
	assert.ok(compareVersions("2.0.0", "1.0.0") > 0);
	assert.ok(compareVersions("1.1.0", "1.0.0") > 0);
	assert.ok(compareVersions("1.0.1", "1.0.0") > 0);
	assert.ok(compareVersions("1.0.0", "2.0.0") < 0);
	assert.ok(compareVersions("1.0.0", "1.1.0") < 0);
	assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
});

test("compareVersions treats release > pre-release", () => {
	// 正式版 > pre-release
	assert.ok(compareVersions("1.0.0", "1.0.0-beta.1") > 0);
	assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
});

test("compareVersions compares pre-release segments", () => {
	// 数字 pre-release 按数值比较
	assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.1") > 0);
	assert.ok(compareVersions("1.0.0-beta.1", "1.0.0-beta.2") < 0);
	// 字符串 pre-release 按字典序
	assert.ok(compareVersions("1.0.0-rc.1", "1.0.0-beta.1") > 0);
	assert.ok(compareVersions("1.0.0-beta.1", "1.0.0-rc.1") < 0);
});

test("compareVersions handles different segment counts", () => {
	// 1.0 vs 1.0.0 → 缺失段视为 0
	assert.equal(compareVersions("1.0", "1.0.0"), 0);
	assert.ok(compareVersions("1.0.1", "1.0") > 0);
});

test("compareVersions detects real-world update scenario", () => {
	// 0.6.7 → 0.6.8 应判定为有更新
	assert.ok(compareVersions("0.6.8", "0.6.7") > 0);
	// 0.6.7-beta.1 → 0.6.7 正式版应判定为有更新
	assert.ok(compareVersions("0.6.7", "0.6.7-beta.1") > 0);
});

// ── selectRecommendedAsset ─────────────────────────────

test("selectRecommendedAsset returns undefined for empty list", () => {
	assert.equal(selectRecommendedAsset([]), undefined);
});

test("selectRecommendedAsset picks matching platform asset", () => {
	const assets: AppUpdateAsset[] = [
		{ name: "OmpDeck-0.6.7-x64-setup.exe", url: "https://example.com/win.exe", size: 100 },
		{ name: "OmpDeck-0.6.7-arm64.dmg", url: "https://example.com/mac.dmg", size: 100 },
		{ name: "OmpDeck-0.6.7-x64.AppImage", url: "https://example.com/linux.AppImage", size: 100 },
	];
	// 函数会根据 process.platform/arch 选择；这里只验证它返回了一个非空结果
	const result = selectRecommendedAsset(assets);
	assert.ok(result !== undefined, "should return a recommended asset");
	// selectRecommendedAsset 通过 spread 创建新对象，用 name 匹配而非引用相等
	const names = assets.map((a) => a.name);
	assert.ok(names.includes(result.name), "result should match one of the input assets by name");
});

test("selectRecommendedAsset prefers setup exe on Windows installed", () => {
	if (process.platform !== "win32") return; // 仅 Windows 适用
	const assets: AppUpdateAsset[] = [
		{ name: "OmpDeck-0.6.7-x64.zip", url: "https://example.com/zip", size: 100 },
		{ name: "OmpDeck-0.6.7-x64-setup.exe", url: "https://example.com/setup.exe", size: 100 },
	];
	const result = selectRecommendedAsset(assets, "installed");
	assert.ok(result !== undefined);
	assert.ok(result.name.includes("setup"), "installed type should prefer setup exe");
});
