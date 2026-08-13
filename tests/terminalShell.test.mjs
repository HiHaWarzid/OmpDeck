import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function loadTerminalSessionManagerModule() {
	const source = readFileSync(
		"src/main/terminal/TerminalSessionManager.ts",
		"utf8",
	);
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	});
	const sandbox = {
		exports: {},
		require: (name) => {
			if (name === "node-pty") return {};
			if (name === "node:crypto") return { randomUUID: () => "id" };
			if (name === "../../shared/ipc") return { ipcChannels: {} };
			// 当前实现额外引入 node:child_process(execSync) 与 node:fs(existsSync)
			// 做 Git Bash / WSL 探测；stub 掉使候选列表保持确定性的三个固定项。
			if (name === "node:child_process") return { execSync: () => { throw new Error("stubbed: skip wsl detection"); } };
			if (name === "node:fs") return { existsSync: () => false };
			return require(name);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "TerminalSessionManager.ts",
	});
	return sandbox.exports;
}

test("uses the macOS user shell as a login shell", () => {
	const { getTerminalShellCandidates } = loadTerminalSessionManagerModule();

	const candidates = getTerminalShellCandidates("darwin", {
		SHELL: "/bin/zsh",
		PATH: "/usr/bin:/bin",
	});

	assert.deepEqual(plain(candidates[0]), {
		shell: "zsh",
		command: "/bin/zsh",
		args: ["-l"],
	});
});

test("keeps Windows shell candidates unchanged", () => {
	const { getTerminalShellCandidates } = loadTerminalSessionManagerModule();

	const candidates = getTerminalShellCandidates("win32", {});

	assert.deepEqual(
		plain(candidates.map((candidate) => candidate.command)),
		["pwsh.exe", "powershell.exe", "cmd.exe"],
	);
	assert.deepEqual(
		plain(candidates.map((candidate) => candidate.args)),
		[[], [], []],
	);
});
