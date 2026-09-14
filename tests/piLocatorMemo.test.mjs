/**
 * PiLocator.getSearchDirs / getCommandBinDir 记忆化的源码审查套件。
 * vm 沙箱把 node:child_process 与 node:fs 换成计数端口（不真的 fork / readdir），
 * 断言：输入不变时第二次调用不再探测且结果逐字相同；输入变化时必须重算；
 * 同一 command 的 createInvocation 只 stat 一次 shim 与 node。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * 加载 PiLocator.ts，注入计数端口。
 * 返回的 sandbox 用于在用例中改写输入（如 process.env.PATH）。
 */
function loadPiLocatorModule({ platform = process.platform, env = {}, home = tmpdir(), now = Date.now } = {}) {
	const counters = { execFileSync: [], readdirSync: [], existsSync: [] };
	const sandbox = {
		Buffer,
		TextDecoder,
		// 只暴露 now()：用例靠推进时钟验证保鲜期，PiLocator 不使用其它 Date 能力。
		Date: { now },
		exports: {},
		process: { ...process, env: { ...env }, platform },
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: () => home } };
			}
			if (id === "node:path") {
				// 宿主可能是 Windows，必须按被模拟的平台选 posix/win32 实现，
				// 否则 delimiter 与 join 语义会和 platform 分支矛盾（PATH 拆不开、目录被反斜杠化）。
				const path = require("node:path");
				return platform === "win32" ? path.win32 : path.posix;
			}
			if (id === "node:fs") {
				return {
					existsSync: (path) => {
						counters.existsSync.push(String(path));
						return existsSync(path);
					},
					readdirSync: (path, options) => {
						counters.readdirSync.push(String(path));
						return readdirSync(path, options);
					},
				};
			}
			if (id === "node:child_process") {
				return {
					// 登录 shell 探测端口：记录调用，返回可辨识的假 PATH，避免测试真的 fork。
					execFileSync: (file, args) => {
						counters.execFileSync.push([file, ...args].join(" "));
						return "/from/login/shell/bin\n";
					},
					execFile: () => {
						throw new Error("同步路径不应调用 execFile");
					},
				};
			}
			return require(id);
		},
	};
	sandbox.global = sandbox;

	const source = readFileSync("src/main/pi/PiLocator.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(outputText, sandbox, { filename: "PiLocator.ts" });
	return { PiLocator: sandbox.exports.PiLocator, counters, sandbox };
}

test("输入不变时第二次 getSearchDirs 不再 fork 登录 shell、不再 readdir，结果逐字相同", () => {
	const home = join(tmpdir(), `ompdeck-locator-home-${process.pid}-${Date.now()}`);
	const { PiLocator, counters } = loadPiLocatorModule({
		platform: "darwin",
		env: { PATH: "/usr/bin:/bin", HOME: home },
		home,
	});
	const locator = new PiLocator();

	const first = locator.getSearchDirs();
	assert.equal(counters.execFileSync.length, 1, "首次必须探一次登录 shell PATH");
	assert.equal(counters.readdirSync.length, 3, "首次必须扫描 mise/nvm/fnm 的 node 安装目录");
	assert.ok(first.includes("/from/login/shell/bin"), "登录 shell PATH 仍并入候选目录");
	assert.ok(first.includes("/usr/bin"), "PATH 仍拆成候选目录");

	const second = locator.getSearchDirs();
	assert.deepEqual(second, first);
	assert.equal(counters.execFileSync.length, 1, "输入未变不得再次 fork 登录 shell");
	assert.equal(counters.readdirSync.length, 3, "输入未变不得再次 readdir");
});

test("输入（PATH）变化后重算，结果跟随新输入", () => {
	const home = join(tmpdir(), `ompdeck-locator-env-${process.pid}-${Date.now()}`);
	const { PiLocator, counters, sandbox } = loadPiLocatorModule({
		platform: "linux",
		env: { PATH: "/opt/toolchain/bin", HOME: home },
		home,
	});
	const locator = new PiLocator();

	const before = locator.getSearchDirs();
	assert.ok(before.includes("/opt/toolchain/bin"));
	assert.ok(!before.includes("/opt/custom/bin"));
	const forksAfterFirst = counters.execFileSync.length;
	const readdirAfterFirst = counters.readdirSync.length;

	sandbox.process.env.PATH = "/opt/custom/bin";
	const after = locator.getSearchDirs();
	assert.ok(after.includes("/opt/custom/bin"), "PATH 变化后必须重算并纳入新目录");
	assert.ok(!after.includes("/opt/toolchain/bin"), "旧 PATH 目录不应残留");
	assert.equal(counters.execFileSync.length, forksAfterFirst + 1, "输入变化必须重新探测登录 shell");
	assert.equal(
		counters.readdirSync.length,
		readdirAfterFirst + 2,
		"输入变化必须重新扫描 mise/nvm 的 node 安装目录",
	);
});

test("超过保鲜期后即使输入不变也重算（共享实例的「重新检测」仍能看到最新盘面）", () => {
	const home = join(tmpdir(), `ompdeck-locator-ttl-${process.pid}-${Date.now()}`);
	let clock = 1_000_000;
	const { PiLocator, counters } = loadPiLocatorModule({
		platform: "darwin",
		env: { PATH: "/opt/toolchain/bin", HOME: home },
		home,
		now: () => clock,
	});
	const locator = new PiLocator();

	const first = locator.getSearchDirs();
	const forksAfterFirst = counters.execFileSync.length;

	clock += 4_000;
	assert.deepEqual(locator.getSearchDirs(), first, "保鲜期内（5s）复用缓存");
	assert.equal(counters.execFileSync.length, forksAfterFirst);

	clock += 6_000;
	locator.getSearchDirs();
	assert.equal(counters.execFileSync.length, forksAfterFirst + 1, "过期后必须重新探测");
});

test("同一 command 的 createInvocation 只 stat 一次 shim 与 node，换 command 才重算", () => {
	const root = join(tmpdir(), `ompdeck-locator-win-${process.pid}-${Date.now()}`);
	const binDir = join(root, "nvm", "v22.22.1");
	const otherBinDir = join(root, "nvm", "v20.19.0");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(otherBinDir, { recursive: true });
	const piPath = join(binDir, "omp.cmd");
	const otherPiPath = join(otherBinDir, "omp.cmd");
	writeFileSync(piPath, "@echo off\r\n", "utf8");
	writeFileSync(join(binDir, "node.exe"), "", "utf8");
	writeFileSync(otherPiPath, "@echo off\r\n", "utf8");
	writeFileSync(join(otherBinDir, "node.exe"), "", "utf8");

	try {
		const { PiLocator, counters } = loadPiLocatorModule({ platform: "win32", env: {}, home: root });
		const locator = new PiLocator();

		// 一次 agent 启动的形状：业务命令 + --version 各调一次 createInvocation。
		const start = locator.createInvocation(piPath, ["--mode", "rpc"]);
		const afterFirst = counters.existsSync.length;
		const version = locator.createInvocation(piPath, ["--version"]);

		assert.equal(start.pathPrefix, binDir);
		assert.equal(version.pathPrefix, binDir);
		assert.equal(counters.existsSync.length, afterFirst, "同 command 第二次不应再 stat");
		assert.equal(counters.existsSync.filter((path) => path === piPath).length, 1);

		const other = locator.createInvocation(otherPiPath, ["--version"]);
		assert.equal(other.pathPrefix, otherBinDir, "换 command 必须重算");
		assert.ok(counters.existsSync.length > afterFirst);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
