import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";

import { STALE_TEMP_FILE_MIN_AGE_MS, cleanupStaleTempFiles } from "./staleTempFileCleanup";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ompdeck-tmp-cleanup-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function createFile(name: string, ageMs = 0): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, "payload", "utf8");
	if (ageMs > 0) {
		const seconds = (Date.now() - ageMs) / 1000;
		await utimes(path, seconds, seconds);
	}
	return path;
}

test("只删陈旧的自定义 tmp：目标文件、非 tmp 命名的文件与目录都不动", async () => {
	const staleTmp = await createFile("settings.json.22088.tmp", STALE_TEMP_FILE_MIN_AGE_MS * 2);
	const freshTmp = await createFile("projects.json.4242.tmp");
	const target = await createFile("settings.json", STALE_TEMP_FILE_MIN_AGE_MS * 2);
	const unrelated = await createFile("notes.txt", STALE_TEMP_FILE_MIN_AGE_MS * 2);
	const tmpLikeDir = join(dir, "drafts.7.tmp");
	await mkdir(tmpLikeDir);

	const removed = await cleanupStaleTempFiles(dir);

	assert.deepEqual(
		removed.map((item) => item.path),
		[staleTmp],
	);
	// fresh tmp 必须保留：它可能是同进程刚开始、尚未 rename 的写入
	const remaining = (await readdir(dir)).map((name) => join(dir, name)).sort();
	assert.deepEqual(
		remaining,
		[freshTmp, target, unrelated, tmpLikeDir].sort(),
	);
});

test("目录不存在时按无可清理处理，不抛异常（首次启动路径）", async () => {
	const removed = await cleanupStaleTempFiles(join(dir, "missing-dir"));
	assert.deepEqual(removed, []);
});
