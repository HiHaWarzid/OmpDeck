import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";

import {
	WINDOWS_APP_USER_MODEL_ID,
	WINDOWS_DEV_APP_USER_MODEL_ID,
	buildWindowsShortcutScript,
	ensureWindowsAppUserModelShortcut,
	resolveWindowsAppUserModelId,
	resolveWindowsShortcutSpec,
} from "./windowsAppIdentity";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-app-identity-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function baseInput(root: string) {
	return {
		isPackaged: true,
		execPath: join(root, "OmpDeck.exe"),
		appPath: join(root, "app"),
		appVersion: "0.0.0-test",
		appDataDir: join(root, "appdata"),
		userDataDir: join(root, "userdata"),
		iconPath: join(root, "build", "icon.ico"),
		platform: "win32" as const,
	};
}

test("安装版快捷方式直接指向 exe，图标取 exe 内嵌资源", () => {
	const root = makeTempDir();
	const input = baseInput(root);
	const spec = resolveWindowsShortcutSpec(input);

	assert.equal(spec.target, input.execPath);
	assert.equal(spec.arguments, "");
	assert.equal(spec.workingDirectory, root);
	assert.equal(spec.iconLocation, `${input.execPath},0`);
	assert.equal(spec.updateTarget, true);
	assert.equal(spec.appId, WINDOWS_APP_USER_MODEL_ID);
	assert.equal(resolveWindowsAppUserModelId(true), WINDOWS_APP_USER_MODEL_ID);
});

test("开发态快捷方式带项目路径参数，图标取构建产物 ICO", () => {
	const root = makeTempDir();
	const input = { ...baseInput(root), isPackaged: false, execPath: join(root, "electron.exe") };
	const spec = resolveWindowsShortcutSpec(input);

	assert.equal(spec.target, input.execPath);
	assert.equal(spec.arguments, `"${input.appPath}"`);
	assert.equal(spec.workingDirectory, input.appPath);
	assert.equal(spec.iconLocation, `${input.iconPath},0`);
	assert.equal(spec.appId, WINDOWS_DEV_APP_USER_MODEL_ID);
	assert.match(spec.shortcutPath, /OmpDeck Dev\.lnk$/);
	assert.equal(resolveWindowsAppUserModelId(false), WINDOWS_DEV_APP_USER_MODEL_ID);
});

test("便携版用用户双击的原始 exe，而不是解压后的临时进程", () => {
	const root = makeTempDir();
	const portable = join(root, "OmpDeck Portable.exe");
	const input = { ...baseInput(root), portableExecutableFile: portable };
	const spec = resolveWindowsShortcutSpec(input);

	assert.equal(spec.target, portable);
	assert.equal(spec.arguments, "");
	assert.equal(spec.workingDirectory, root);
	assert.equal(spec.iconLocation, `${portable},0`);
});

test("开发态可修正独立快捷方式，便携版不篡改已有快捷方式", () => {
	const root = makeTempDir();
	const devInput = { ...baseInput(root), isPackaged: false };
	const first = resolveWindowsShortcutSpec(devInput);
	mkdirSync(dirname(first.shortcutPath), { recursive: true });
	writeFileSync(first.shortcutPath, "");

	const devSpec = resolveWindowsShortcutSpec(devInput);
	assert.equal(devSpec.updateTarget, true);
	assert.equal(devSpec.updateIcon, true);
	const portableSpec = resolveWindowsShortcutSpec({
		...devInput,
		portableExecutableFile: join(root, "portable.exe"),
	});
	assert.equal(portableSpec.updateTarget, false);
	assert.equal(portableSpec.updateIcon, false);
});

test("安装版已有快捷方式时仍允许修正安装路径与图标", () => {
	const root = makeTempDir();
	const input = baseInput(root);
	const first = resolveWindowsShortcutSpec(input);
	mkdirSync(dirname(first.shortcutPath), { recursive: true });
	writeFileSync(first.shortcutPath, "");

	const spec = resolveWindowsShortcutSpec(input);
	assert.equal(spec.updateTarget, true);
	assert.equal(spec.updateIcon, true);
});

test("快捷方式脚本为单引号路径做 PowerShell 转义", () => {
	const spec = resolveWindowsShortcutSpec(baseInput(makeTempDir()));
	const script = buildWindowsShortcutScript({
		...spec,
		target: "C:\\Program Files\\O'Brien\\OmpDeck.exe",
		updateTarget: false,
	});

	assert.match(script, /C:\\Program Files\\O''Brien\\OmpDeck\.exe/);
	assert.match(script, /\$updateTarget = \$false/);
	assert.match(script, /PKEY_AppUserModel_ID/);
});

test("非 Windows 平台不启动 PowerShell", async () => {
	const root = makeTempDir();
	const result = await ensureWindowsAppUserModelShortcut({
		...baseInput(root),
		platform: "linux",
	});

	assert.deepEqual(result, { status: "skipped", reason: "unsupported-platform" });
});
