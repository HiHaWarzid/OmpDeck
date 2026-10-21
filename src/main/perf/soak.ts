/**
 * 长时运行基线（8 小时 soak）：每 30 秒把主进程与所有 Electron 进程的内存/CPU
 * 采样追加到 userData 下的 JSONL。默认关闭，只在 PIDECK_PERF_SOAK=1 时启动。
 *
 * 只记录数字，不做任何 UI 或网络行为；采样失败必须静默降级——诊断设施不能干扰
 * 被诊断的进程。
 */
import { app, type ProcessMetric } from "electron";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const SAMPLE_INTERVAL_MS = 30_000;

function summarizeProcesses(metrics: ProcessMetric[]) {
	let workingSetKb = 0;
	let cpuPercent = 0;
	for (const metric of metrics) {
		workingSetKb += metric.memory?.workingSetSize ?? 0;
		cpuPercent += metric.cpu?.percentCPUUsage ?? 0;
	}
	return {
		processCount: metrics.length,
		rendererCount: metrics.filter((metric) => metric.type === "Tab").length,
		workingSetMb: Math.round(workingSetKb / 1024),
		cpuPercent: Number(cpuPercent.toFixed(1)),
	};
}

/** 启动采样，返回停止函数；未开启或已在运行时为空操作。 */
export function startSoakRecorder(): () => void {
	if (process.env.PIDECK_PERF_SOAK !== "1") return () => undefined;

	const dir = app.getPath("userData");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filePath = join(dir, `perf-soak-${process.pid}-${stamp}.jsonl`);
	let stopped = false;

	const sample = () => {
		if (stopped) return;
		const memory = process.memoryUsage();
		const line = JSON.stringify({
			at: new Date().toISOString(),
			uptimeSec: Math.round(process.uptime()),
			main: {
				rssMb: Math.round(memory.rss / 1024 / 1024),
				heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
				externalMb: Math.round(memory.external / 1024 / 1024),
				activeResources: process.getActiveResourcesInfo?.().length ?? 0,
			},
			processes: summarizeProcesses(app.getAppMetrics()),
		});
		void appendFile(filePath, `${line}\n`, "utf8").catch(() => undefined);
	};

	void mkdir(dir, { recursive: true })
		.then(() => {
			console.log(`[perf] soak recorder -> ${filePath}`);
			sample();
		})
		.catch(() => undefined);

	const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
	timer.unref?.();

	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
