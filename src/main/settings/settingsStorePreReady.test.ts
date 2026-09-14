/**
 * 启动期 pre-ready 偏好单测：
 * 1) 启动路径（main/index.ts）对 userData/settings.json 只同步读一次，三个偏好判定共用同一份快照；
 * 2) 每个判定的默认值/降级语义与改动前逐字一致（文件缺失、JSON 非法 → 空对象 → 默认值）；
 * 3) 不传快照的调用方（运行期重建宠物窗）仍读最新盘面，不被启动快照污染。
 * node:fs 只包一层计数外壳，读写行为仍交给真实实现；electron 只 mock 到模块加载所需的最小面。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AppSettings } from "../../shared/types";

const fsCalls = vi.hoisted(() => ({ readFileSync: [] as string[] }));
const settingsPaths = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
	app: {
		getPath: (name: string) => (name === "userData" ? settingsPaths.userData : tmpdir()),
	},
	Menu: { setApplicationMenu: () => undefined },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return {
		...actual,
		readFileSync: (path: string, options?: BufferEncoding | null) => {
			fsCalls.readFileSync.push(path);
			return actual.readFileSync(path, options ?? undefined);
		},
	};
});

import {
	readDesktopSettingsSync,
	readElectronChromiumSandboxPreference,
	readPetEnabledPreference,
	readSingleInstancePreference,
} from "./SettingsStore";

let userDataDir = "";

/** 写入桌面 settings.json（对象走 JSON.stringify，字符串按原文写入以便构造非法 JSON）。 */
function writeSettings(content: unknown): string {
	const path = join(userDataDir, "settings.json");
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
	return path;
}

beforeEach(() => {
	userDataDir = mkdtempSync(join(tmpdir(), "ompdeck-settings-preready-"));
	settingsPaths.userData = userDataDir;
	fsCalls.readFileSync.length = 0;
});

afterEach(() => {
	rmSync(userDataDir, { recursive: true, force: true });
});

test("启动路径：三个 pre-ready 偏好共用一份快照，合计只同步读一次 settings.json", () => {
	const settingsPath = writeSettings({
		petEnabled: true,
		electronChromiumSandbox: true,
		singleInstance: false,
	});

	// 与 main/index.ts 的启动序列一致：先读一次快照，三个判定消费同一个对象。
	const snapshot = readDesktopSettingsSync();
	assert.equal(readPetEnabledPreference(snapshot), true);
	assert.equal(readElectronChromiumSandboxPreference(snapshot), true);
	assert.equal(readSingleInstancePreference(snapshot), false);

	assert.deepEqual(fsCalls.readFileSync, [settingsPath]);
});

test("文件缺失或 JSON 非法：三个判定各自回落默认值（宠物/沙箱 false，单实例 true）", () => {
	const snapshotMissing = readDesktopSettingsSync();
	assert.equal(readPetEnabledPreference(snapshotMissing), false);
	assert.equal(readElectronChromiumSandboxPreference(snapshotMissing), false);
	assert.equal(readSingleInstancePreference(snapshotMissing), true);
	assert.equal(fsCalls.readFileSync.length, 1, "快照读取失败也只是一次读盘");

	writeSettings("{ \"petEnabled\": true");
	const snapshotBroken = readDesktopSettingsSync();
	assert.equal(readPetEnabledPreference(snapshotBroken), false);
	assert.equal(readElectronChromiumSandboxPreference(snapshotBroken), false);
	assert.equal(readSingleInstancePreference(snapshotBroken), true);
});

test("判定语义不变：=== true 与 !== false，非布尔值不误判为开启", () => {
	const snapshot = {
		petEnabled: "yes",
		electronChromiumSandbox: 1,
		singleInstance: "no",
	} as unknown as Partial<AppSettings>;
	assert.equal(readPetEnabledPreference(snapshot), false);
	assert.equal(readElectronChromiumSandboxPreference(snapshot), false);
	assert.equal(readSingleInstancePreference(snapshot), true);

	assert.equal(readSingleInstancePreference({ singleInstance: false }), false);
	assert.equal(readPetEnabledPreference({ petEnabled: false }), false);
	assert.equal(readElectronChromiumSandboxPreference({ electronChromiumSandbox: false }), false);
});

test("不传快照的调用方（运行期重建宠物窗）仍读最新盘面", () => {
	writeSettings({ electronChromiumSandbox: true });
	assert.equal(readElectronChromiumSandboxPreference(), true);

	writeSettings({ electronChromiumSandbox: false });
	assert.equal(readElectronChromiumSandboxPreference(), false);

	assert.equal(fsCalls.readFileSync.length, 2, "每次无参调用都应重新读盘");

	// 对照证据：改动前的启动路径正是三次无参调用 → 三次读盘；现在由 index.ts 传同一份快照降为一次。
	readPetEnabledPreference();
	readSingleInstancePreference();
	assert.equal(fsCalls.readFileSync.length, 4);
});
