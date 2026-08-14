import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 回归护栏：IPC 通道名只允许出现在 src/shared/ipc.ts 的通道表里。
 * 历史上出现过 preload / agentHandlers / index.ts / SettingsStore 里裸写
 * "agents:commands"、"projects:changed"、"settings:apply-window" 导致
 * 通道表失去权威性的问题——表之外出现字面量通道名即失败。
 */
const SRC_ROOT = "src";
const SKIP = new Set(["src/shared/ipc.ts"]);

function collectSourceFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (/(\.ts|\.tsx)$/.test(name)) {
			out.push(full);
		}
	}
	return out;
}

// ipcRenderer/ipcMain 的通道注册/调用、webContents.send、preload subscribe 后紧跟字符串字面量。
// 注意：webContents.on("did-start-loading") 等是 Electron 生命周期事件，不是 IPC 通道，不在禁令范围。
const CHANNEL_LITERAL_CALL =
	/(?:ipcRenderer|ipcMain)\.(?:invoke|send|sendSync|on|handle)\(\s*["'`]|webContents\.send\(\s*["'`]|subscribe\(\s*["'`]/;

test("src/ 中除通道表外不存在裸通道字符串", () => {
	const offenders = [];
	for (const file of collectSourceFiles(SRC_ROOT)) {
		if (SKIP.has(file)) continue;
		const source = readFileSync(file, "utf8");
		for (const [index, line] of source.split("\n").entries()) {
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
			if (CHANNEL_LITERAL_CALL.test(line)) {
				offenders.push(`${file}:${index + 1}: ${trimmed}`);
			}
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`裸通道字符串只允许出现在 src/shared/ipc.ts：\n${offenders.join("\n")}`,
	);
});
