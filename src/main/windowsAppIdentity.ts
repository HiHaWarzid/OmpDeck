/**
 * Windows 任务栏 / 通知头部的应用身份注册。
 *
 * 只设置 `app.setAppUserModelId()` 还不够：Windows 会按 AppUserModelID 去开始菜单
 * 找带同 ID 的 .lnk，并用该快捷方式的图标作为任务栏和 Toast 左上角图标。
 * 开发态、便携版、未安装直接跑 `win-unpacked` 时没有这个快捷方式，系统就回退到
 * electron.exe 的默认图标，且 BrowserWindow 的 `icon` 也压不过 AUMID 的解析结果。
 *
 * 这里在首次启动时补建/修正当前用户的开始菜单快捷方式，并写入
 * `System.AppUserModel.ID`。已经由 NSIS 安装器创建的快捷方式只补属性，不改目标，
 * 避免开发版/便携版把已安装应用的快捷方式劫持走。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WINDOWS_APP_USER_MODEL_ID = "com.hihawarzid.omp-deck";
const SHORTCUT_NAME = "OmpDeck.lnk";
const IDENTITY_SCHEMA = 1;

export type WindowsAppIdentityInput = {
	isPackaged: boolean;
	execPath: string;
	appPath: string;
	appVersion: string;
	appDataDir: string;
	userDataDir: string;
	iconPath: string;
	/** electron-builder 便携版会指向用户双击的原始 exe；不能使用解压后的临时 exe。 */
	portableExecutableFile?: string;
	platform?: NodeJS.Platform;
};

export type WindowsShortcutSpec = {
	shortcutPath: string;
	target: string;
	arguments: string;
	workingDirectory: string;
	iconLocation: string;
	appId: string;
	/** true 时允许改动已有快捷方式的目标；false 只补 AUMID。 */
	updateTarget: boolean;
	/** true 时同步图标；开发态命中安装版快捷方式时不覆盖其图标。 */
	updateIcon: boolean;
};

export type WindowsAppIdentityResult =
	| { status: "skipped"; reason: "unsupported-platform" | "already-registered" }
	| { status: "registered"; shortcutPath: string }
	| { status: "failed"; error: string };

type IdentityMarker = {
	schema: number;
	appVersion: string;
	spec: Omit<WindowsShortcutSpec, "updateTarget" | "updateIcon">;
};

export function resolveWindowsShortcutSpec(
	input: WindowsAppIdentityInput,
): WindowsShortcutSpec {
	const isPortable = Boolean(input.portableExecutableFile);
	const target = isPortable
		? (input.portableExecutableFile as string)
		: input.execPath;
	const shortcutPath = join(
		input.appDataDir,
		"Microsoft",
		"Windows",
		"Start Menu",
		"Programs",
		SHORTCUT_NAME,
	);
	// 开发态（electron.exe + 项目目录）需要参数；安装版/便携版直接启动 exe。
	const launchArguments = input.isPackaged
		? ""
		: `"${input.appPath}"`;
	const shortcutExists = existsSync(shortcutPath);
	// 已有快捷方式可能是安装器建的：开发版/便携版只补 AUMID，不改目标或图标。
	// 安装版则允许修正旧的安装路径和图标。
	const ownsShortcut = !shortcutExists || (input.isPackaged && !isPortable);
	return {
		shortcutPath,
		target,
		arguments: launchArguments,
		workingDirectory: input.isPackaged ? dirname(target) : input.appPath,
		iconLocation: `${input.isPackaged ? input.execPath : input.iconPath},0`,
		appId: WINDOWS_APP_USER_MODEL_ID,
		updateTarget: ownsShortcut,
		updateIcon: ownsShortcut,
	};
}

function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * PowerShell 无法直接写 .lnk 的 `System.AppUserModel.ID`，必须走
 * IPropertyStore。C# 代码通过 Add-Type 内联编译，避免引入原生依赖。
 */
const PROPERTY_STORE_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;

namespace OmpDeck {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropertyKey {
    public Guid fmtid;
    public uint pid;
  }

  // PROPVARIANT 在 x64 上包含 16 字节联合体，总大小 24 字节；
  // 只声明到指针会被 PropVariantClear 读越界。
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out PropertyKey pkey);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant pv);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant pv);
    [PreserveSig] int Commit();
  }

  public static class AppIdentity {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int SHGetPropertyStoreFromParsingName(
      string pszPath, IntPtr pbc, uint flags, ref Guid riid, out IPropertyStore ppv);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant pvar);

    public static void SetAppId(string lnkPath, string appId) {
      Guid iid = typeof(IPropertyStore).GUID;
      IPropertyStore store;
      int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);

      PropertyKey key = new PropertyKey();
      key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
      key.pid = 5; // PKEY_AppUserModel_ID

      PropVariant pv = new PropVariant();
      pv.vt = 31; // VT_LPWSTR
      pv.pointerValue = Marshal.StringToCoTaskMemUni(appId);
      try {
        hr = store.SetValue(ref key, ref pv);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        hr = store.Commit();
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      } finally {
        PropVariantClear(ref pv);
        Marshal.ReleaseComObject(store);
      }
    }
  }
}
`;

export function buildWindowsShortcutScript(spec: WindowsShortcutSpec): string {
	const updateTarget = spec.updateTarget;
	const updateIcon = spec.updateIcon;
	return [
		"$ErrorActionPreference = 'Stop'",
		`$lnkPath = ${psQuote(spec.shortcutPath)}`,
		`$target = ${psQuote(spec.target)}`,
		`$arguments = ${psQuote(spec.arguments)}`,
		`$workingDirectory = ${psQuote(spec.workingDirectory)}`,
		`$iconLocation = ${psQuote(spec.iconLocation)}`,
		`$appId = ${psQuote(spec.appId)}`,
		`$updateTarget = $${updateTarget ? "true" : "false"}`,
		`$updateIcon = $${updateIcon ? "true" : "false"}`,
		"New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lnkPath) | Out-Null",
		// PowerShell here-string 的结束符必须独占一行，缩进会破坏语法。
		`$source = @'\n${PROPERTY_STORE_CSHARP}\n'@`,
		"Add-Type -TypeDefinition $source",
		"$ws = New-Object -ComObject WScript.Shell",
		"$sc = $ws.CreateShortcut($lnkPath)",
		"$changed = $false",
		// 安装器建的快捷方式：开发版/便携版只补 AUMID，不改 TargetPath 或图标。
		"if ($updateTarget) {",
		"  if ($sc.TargetPath -ne $target) { $sc.TargetPath = $target; $changed = $true }",
		"  if ($sc.Arguments -ne $arguments) { $sc.Arguments = $arguments; $changed = $true }",
		"  if ($sc.WorkingDirectory -ne $workingDirectory) { $sc.WorkingDirectory = $workingDirectory; $changed = $true }",
		"}",
		"if ($updateIcon -and $sc.IconLocation -ne $iconLocation) { $sc.IconLocation = $iconLocation; $changed = $true }",
		"if ($sc.Description -ne 'OmpDeck') { $sc.Description = 'OmpDeck'; $changed = $true }",
		"if ($changed) { $sc.Save() }",
		"[OmpDeck.AppIdentity]::SetAppId($lnkPath, $appId)",
	].join("\n");
}

function readMarker(path: string): IdentityMarker | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as IdentityMarker;
		if (parsed?.schema !== IDENTITY_SCHEMA) return null;
		return parsed;
	} catch {
		return null;
	}
}

function isSameSpec(marker: IdentityMarker | null, spec: WindowsShortcutSpec, appVersion: string): boolean {
	if (!marker || marker.appVersion !== appVersion) return false;
	const { updateTarget: _updateTarget, updateIcon: _updateIcon, ...markerSpec } = spec;
	return JSON.stringify(marker.spec) === JSON.stringify(markerSpec);
}

/**
 * 幂等地补齐开始菜单快捷方式。首次运行会启动一次 PowerShell；之后通过 marker
 * 跳过，不进入启动关键路径的重复开销。
 */
export async function ensureWindowsAppUserModelShortcut(
	input: WindowsAppIdentityInput,
): Promise<WindowsAppIdentityResult> {
	if ((input.platform ?? process.platform) !== "win32") {
		return { status: "skipped", reason: "unsupported-platform" };
	}

	const spec = resolveWindowsShortcutSpec(input);
	const markerPath = join(input.userDataDir, "windows-app-identity.json");
	const marker = readMarker(markerPath);
	if (existsSync(spec.shortcutPath) && isSameSpec(marker, spec, input.appVersion)) {
		return { status: "skipped", reason: "already-registered" };
	}

	try {
		const script = buildWindowsShortcutScript(spec);
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		await execFileAsync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				encoded,
			],
			{ windowsHide: true, timeout: 15_000 },
		);
		mkdirSync(input.userDataDir, { recursive: true });
		const markerData: IdentityMarker = {
			schema: IDENTITY_SCHEMA,
			appVersion: input.appVersion,
			spec: {
				shortcutPath: spec.shortcutPath,
				target: spec.target,
				arguments: spec.arguments,
				workingDirectory: spec.workingDirectory,
				iconLocation: spec.iconLocation,
				appId: spec.appId,
			},
		};
		writeFileSync(markerPath, JSON.stringify(markerData), "utf8");
		return { status: "registered", shortcutPath: spec.shortcutPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { status: "failed", error: message };
	}
}
