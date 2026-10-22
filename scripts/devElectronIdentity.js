// @ts-check
/**
 * 开发态 Electron 二进制品牌化。
 *
 * Windows 的 Toast 头部名称/图标和任务栏图标最终取自进程可执行文件的版本资源：
 * 直接跑 node_modules/electron/dist/electron.exe 时，即使设置了 AUMID、写了开始菜单
 * 快捷方式，Get-StartApps / 通知中心仍会显示 "Electron"+原子图标。
 *
 * 这里在 electron.exe 同目录生成一个 OmpDeck.exe 副本（资源目录不变），用 resedit
 * 替换图标和版本资源，再让 electron-vite 通过 ELECTRON_EXEC_PATH 启动它。
 * 只用于开发态；正式包由 electron-builder 直接产出品牌化 exe。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BRANDING_VERSION = 2;
const DEV_EXECUTABLE_NAME = "OmpDeck.exe";

/** @typedef {{ sourcePath: string; targetPath: string; iconPath: string; markerPath: string }} DevExecutablePaths */

/** @returns {DevExecutablePaths} */
function resolveDevExecutablePaths({ root = ROOT } = {}) {
	const distDir = path.join(root, "node_modules", "electron", "dist");
	return {
		sourcePath: path.join(distDir, "electron.exe"),
		targetPath: path.join(distDir, DEV_EXECUTABLE_NAME),
		iconPath: path.join(root, "build", "icon.ico"),
		markerPath: path.join(distDir, `${DEV_EXECUTABLE_NAME}.brand.json`),
	};
}

function readJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

/** @param {string} filePath */
function mtimeMs(filePath) {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

function isBrandedExecutableUpToDate(paths, electronVersion, appVersion) {
	const marker = readJson(paths.markerPath);
	if (!marker || marker.brandingVersion !== BRANDING_VERSION) return false;
	if (marker.electronVersion !== electronVersion || marker.appVersion !== appVersion) return false;
	const targetTime = mtimeMs(paths.targetPath);
	if (!targetTime) return false;
	return targetTime >= mtimeMs(paths.sourcePath) && targetTime >= mtimeMs(paths.iconPath);
}

/**
 * 生成/复用品牌化开发用 exe。失败时返回 undefined，调用方退回 electron.exe。
 * @returns {string | undefined}
 */
function ensureDevElectronExecutable({ root = ROOT, platform = process.platform, log = console } = {}) {
	if (platform !== "win32") return undefined;
	const paths = resolveDevExecutablePaths({ root });
	if (!fs.existsSync(paths.sourcePath)) return undefined;

	const electronPackage = readJson(path.join(root, "node_modules", "electron", "package.json"));
	const appPackage = readJson(path.join(root, "package.json"));
	const electronVersion = String(electronPackage?.version ?? "");
	const appVersion = String(appPackage?.version ?? "0.0.0");
	if (isBrandedExecutableUpToDate(paths, electronVersion, appVersion)) {
		return paths.targetPath;
	}

	try {
		log.log("[dev] 正在生成品牌化 Electron 启动器 OmpDeck.exe（首次启动需要几秒）…");
		const ResEdit = require("resedit");
		const source = fs.readFileSync(paths.sourcePath);
		// electron.exe 带 Authenticode 签名；复制后必然要重写资源，忽略证书解析即可。
		const exe = ResEdit.NtExecutable.from(source, { ignoreCert: true });
		const resources = ResEdit.NtExecutableResource.from(exe);

		if (fs.existsSync(paths.iconPath)) {
			const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(paths.iconPath));
			const iconData = iconFile.icons.map((icon) => icon.data);
			for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)) {
				ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
					resources.entries,
					group.id,
					group.lang,
					iconData,
				);
			}
		}

		const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
		for (const versionInfo of versionInfos) {
			const languages = versionInfo.getAllLanguagesForStringValues();
			const targets = languages.length > 0 ? languages : [{ lang: 1033, codepage: 1200 }];
			for (const language of targets) {
				versionInfo.setStringValues(language, {
					CompanyName: "HiHaWarzid",
					FileDescription: "OmpDeck",
					ProductName: "OmpDeck",
					InternalName: DEV_EXECUTABLE_NAME,
					OriginalFilename: DEV_EXECUTABLE_NAME,
					LegalCopyright: "Copyright (C) 2026 HiHaWarzid",
				});
				// Electron 的原版资源带 SquirrelAwareVersion，会让部分路径误判为 Squirrel 安装。
				versionInfo.removeStringValue(language, "SquirrelAwareVersion");
			}
			versionInfo.setFileVersion(appVersion, 1033);
			versionInfo.setProductVersion(appVersion, 1033);
			versionInfo.outputToResourceEntries(resources.entries);
		}

		resources.outputResource(exe);
		const output = Buffer.from(exe.generate());
		const tempPath = `${paths.targetPath}.${process.pid}.tmp`;
		fs.writeFileSync(tempPath, output);
		try {
			// 目标正在运行时无法覆盖，保留现有文件并提示重启；否则用临时文件原子替换。
			fs.rmSync(paths.targetPath, { force: true });
			fs.renameSync(tempPath, paths.targetPath);
		} catch (error) {
			fs.rmSync(tempPath, { force: true });
			if (fs.existsSync(paths.targetPath)) {
				log.warn(`[dev] OmpDeck.exe 正在使用，暂时沿用现有文件：${String(error)}`);
				return paths.targetPath;
			}
			throw error;
		}

		fs.writeFileSync(
			paths.markerPath,
			JSON.stringify({ brandingVersion: BRANDING_VERSION, electronVersion, appVersion }),
			"utf8",
		);
		log.log("[dev] 已生成品牌化 Electron 启动器。");
		return paths.targetPath;
	} catch (error) {
		log.warn(`[dev] 生成品牌化 Electron 启动器失败，回退 electron.exe：${String(error)}`);
		return undefined;
	}
}

module.exports = {
	DEV_EXECUTABLE_NAME,
	ensureDevElectronExecutable,
	resolveDevExecutablePaths,
};
