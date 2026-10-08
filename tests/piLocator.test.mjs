import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadPiLocatorModule(platform = process.platform) {
	const source = readFileSync("src/main/pi/PiLocator.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		Buffer,
		TextDecoder,
		exports: {},
		process: {
			...process,
			env: { ...process.env },
			platform,
		},
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: () => tmpdir() } };
			}
			return require(id);
		},
	};
	sandbox.global = sandbox;
	vm.runInNewContext(outputText, sandbox, {
		filename: "PiLocator.ts",
	});
	return sandbox.exports;
}

test("uses the pi shim bin directory as PATH prefix on macOS when node is beside the shim", () => {
	const root = join(tmpdir(), `pi-desktop-locator-${process.pid}-${Date.now()}`);
	const binDir = join(root, ".nvm", "versions", "node", "v22.22.1", "bin");
	mkdirSync(binDir, { recursive: true });
	const piPath = join(binDir, "pi");
	writeFileSync(piPath, "#!/usr/bin/env node\n", "utf8");
	writeFileSync(join(binDir, "node"), "", "utf8");

	try {
		const { PiLocator } = loadPiLocatorModule("darwin");
		const invocation = new PiLocator().createInvocation(piPath, ["--version"]);

		assert.equal(invocation.command, piPath);
		assert.deepEqual(invocation.args, ["--version"]);
		assert.equal(invocation.shell, false);
		assert.equal(invocation.pathPrefix, binDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("uses the pi cmd shim bin directory as PATH prefix on Windows when node.exe is beside the shim", () => {
	const root = join(tmpdir(), `pi-desktop-locator-win-${process.pid}-${Date.now()}`);
	const binDir = join(root, "nvm", "v22.22.1");
	mkdirSync(binDir, { recursive: true });
	const piPath = join(binDir, "pi.cmd");
	writeFileSync(piPath, "@echo off\r\nnode \"%~dp0\\node_modules\\pi\\bin.js\" %*\r\n", "utf8");
	writeFileSync(join(binDir, "node.exe"), "", "utf8");

	try {
		const { PiLocator } = loadPiLocatorModule("win32");
		const invocation = new PiLocator().createInvocation(piPath, ["--version"]);

		assert.match(invocation.command.toLowerCase(), /cmd\.exe$/);
		assert.equal(JSON.stringify(invocation.args.slice(0, 3)), JSON.stringify(["/d", "/s", "/c"]));
		assert.equal(invocation.shell, false);
		assert.equal(invocation.pathPrefix, binDir);
		assert.equal(invocation.windowsVerbatimArguments, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("places an explicit WSL cwd before the pi command", () => {
	const { PiLocator } = loadPiLocatorModule("win32");
	const invocation = new PiLocator().createInvocation(
		"wsl://Ubuntu-24.04/root/pi",
		["--mode", "rpc"],
		{ wslCwd: "/root/ba cli" },
	);

	assert.deepEqual(
		Array.from(invocation.args),
		["-d", "Ubuntu-24.04", "-u", "root", "--cd", "/root/ba cli", "pi", "--mode", "rpc"],
	);
	assert.equal(invocation.wsl.distro, "Ubuntu-24.04");
});

test("sanitizePiChildEnv strips shell HTTP(S) proxy env so omp long-streams bypass local proxies", () => {
	const { PiLocator } = loadPiLocatorModule("win32");
	const dirty = {
		PATH: "C:\\Windows",
		USERPROFILE: "C:\\Users\\EthanZhang",
		HTTPS_PROXY: "http://127.0.0.1:7897",
		HTTP_PROXY: "http://127.0.0.1:7897",
		ALL_PROXY: "socks5://127.0.0.1:1080",
		NO_PROXY: "localhost,127.0.0.1",
		https_proxy: "http://proxy.example:8080",
		no_proxy: "internal.example",
		NODE_OPTIONS: "--require /x/electron-vite/hook",
	};
	const clean = new PiLocator().sanitizePiChildEnv(dirty);

	// 桌面端 omp 子进程不应继承任何 shell 代理变量，否则 clash/v2rayN 等本地代理
	// 会按 idle timeout 掐断长流式 AI 请求（症状：socket connection was closed unexpectedly）。
	for (const key of [
		"HTTPS_PROXY",
		"HTTP_PROXY",
		"ALL_PROXY",
		"NO_PROXY",
		"https_proxy",
		"no_proxy",
	]) {
		assert.equal(clean[key], undefined, `${key} should be stripped`);
	}
	// 业务/宿主变量不动。
	assert.equal(clean.PATH, "C:\\Windows");
	assert.equal(clean.USERPROFILE, "C:\\Users\\EthanZhang");
	// NODE_OPTIONS 中的 electron-vite 钩子仍需被剥（与原逻辑保持一致）：
	// " --require /x/electron-vite/hook " 按空格分词后过滤掉含 electron/asar/electron-vite 的 token，
	// 留下 "--require"。
	assert.equal(clean.NODE_OPTIONS, "--require");
});

test("sanitizePiChildEnv keeps unrelated env untouched when no proxy is set", () => {
	const { PiLocator } = loadPiLocatorModule("win32");
	const input = { PATH: "C:\\Windows", FOO: "bar" };
	const clean = new PiLocator().sanitizePiChildEnv(input);
	assert.equal(clean.PATH, "C:\\Windows");
	assert.equal(clean.FOO, "bar");
});
