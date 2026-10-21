#!/usr/bin/env node
/**
 * 启动打包后的应用并运行 PIDECK_PERF_SOAK 采样。
 *
 * 用法：node scripts/perf/soak.mjs [--duration=8h] [--open-session]
 * 默认 30 分钟，Ctrl+C 提前结束并打印摘要。产物在 .perf-results/user-data/。
 *
 * 注意：这是真实 GUI 进程；脚本只负责启动/收尾，不驱动界面。
 * --duration 支持 30s / 30m / 8h。
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import electronPath from "electron";

const root = process.cwd();
const resultsDir = join(root, ".perf-results");
const userDataDir = join(resultsDir, "user-data");

function parseDuration(value) {
	const match = /^(\d+)(s|m|h)$/.exec(value ?? "");
	if (!match) return 30 * 60 * 1000;
	const amount = Number(match[1]);
	const unit = match[2];
	return amount * (unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

const durationArg = process.argv.find((arg) => arg.startsWith("--duration="));
const durationMs = parseDuration(durationArg?.split("=")[1]);

const child = spawn(electronPath, [".", `--user-data-dir=${userDataDir}`], {
	cwd: root,
	env: { ...process.env, PIDECK_PERF: "1", PIDECK_PERF_SOAK: "1" },
	stdio: "inherit",
});

let stopping = false;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	child.kill();
	setTimeout(() => process.exit(code), 1500).unref?.();
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
child.on("exit", (code) => {
	stopping = true;
	void printSummary().finally(() => process.exit(code ?? 0));
});

const deadline = setTimeout(() => stop(0), durationMs);
deadline.unref?.();

async function printSummary() {
	const dir = join(userDataDir);
	let files = [];
	try {
		files = (await readdir(dir)).filter((name) => /^perf-soak-.*\.jsonl$/.test(name));
	} catch {
		console.log("no soak samples found");
		return;
	}
	for (const name of files) {
		const lines = (await readFile(join(dir, name), "utf8")).trim().split("\n").filter(Boolean);
		if (lines.length < 2) {
			console.log(`${name}: ${lines.length} sample(s)`);
			continue;
		}
		const first = JSON.parse(lines[0]);
		const last = JSON.parse(lines[lines.length - 1]);
		const delta = (key) => last[key] - first[key];
		console.log(
			`${name}: ${lines.length} samples, ${Math.round(delta("uptimeSec") / 60)} min, ` +
				`renderer RSS ${first.processes.workingSetMb}→${last.processes.workingSetMb} MB, ` +
				`main RSS ${first.main.rssMb}→${last.main.rssMb} MB, ` +
				`active resources ${first.main.activeResources}→${last.main.activeResources}`,
		);
	}
}
