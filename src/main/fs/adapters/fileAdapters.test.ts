import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { execFile as ExecFileType } from "node:child_process";

import { LocalFileAdapter } from "./localFileAdapter";
import { WslFileAdapter } from "./wslFileAdapter";

// ── WslFileAdapter：mock execFile 验证参数拼装 ─────────────

type ExecCall = { command: string; args: string[]; options: Record<string, unknown> };

function makeMockExec() {
	const calls: ExecCall[] = [];
	const mockExec = ((_command: string, args: string[], options: Record<string, unknown>, callback: (err: Error | null, stdout?: string) => void) => {
		calls.push({ command: _command, args, options });
		// 默认成功：stdout 空
		callback(null, "");
		return { stdin: { end: () => {} } } as unknown as ReturnType<typeof ExecFileType>;
	}) as unknown as typeof ExecFileType;
	return { calls, mockExec };
}

function makeAdapter(execFileImpl: typeof ExecFileType) {
	return new WslFileAdapter({
		distro: "Ubuntu",
		user: "ethan",
		wslExePath: "C:\\Windows\\System32\\wsl.exe",
		wslShell: false,
		execFileImpl,
	});
}

test("WslFileAdapter read builds cat command with distro/user prefix", async () => {
	const { calls, mockExec } = makeMockExec();
	const adapter = makeAdapter(mockExec);

	await adapter.read("/home/ethan/session.jsonl");

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].args, [
		"-d", "Ubuntu", "-u", "ethan", "cat", "/home/ethan/session.jsonl",
	]);
	assert.equal(calls[0].command, "C:\\Windows\\System32\\wsl.exe");
	assert.equal(calls[0].options.shell, false);
	assert.equal(calls[0].options.timeout, 10_000);
});

test("WslFileAdapter readHead builds head -c command", async () => {
	const { calls, mockExec } = makeMockExec();
	const adapter = makeAdapter(mockExec);

	await adapter.readHead("/f.jsonl", 4096);

	assert.deepEqual(calls[0].args, [
		"-d", "Ubuntu", "-u", "ethan", "head", "-c", "4096", "--", "/f.jsonl",
	]);
	assert.equal(calls[0].options.timeout, 5_000);
});

test("WslFileAdapter write pipes content to stdin of tee command", async () => {
	const { calls, mockExec } = makeMockExec();
	const adapter = makeAdapter(mockExec);

	await adapter.write("/f.jsonl", "content");

	assert.deepEqual(calls[0].args, ["-d", "Ubuntu", "-u", "ethan", "tee", "/f.jsonl"]);
	assert.equal(calls[0].options.timeout, 10_000);
});

test("WslFileAdapter stat parses stat -c output into mtimeMs/size", async () => {
	const { mockExec } = makeMockExec();
	// 覆写默认成功回调：返回 "1700000000 1234"
	const execWithOutput = ((_command: string, args: string[], _options: Record<string, unknown>, callback: (err: Error | null, stdout?: string) => void) => {
		callback(null, "1700000000 1234\n");
		return { stdin: { end: () => {} } } as unknown as ReturnType<typeof ExecFileType>;
	}) as unknown as typeof ExecFileType;
	const adapter = makeAdapter(execWithOutput);

	const version = await adapter.stat("/f.jsonl");

	assert.equal(version.mtimeMs, 1700000000 * 1000);
	assert.equal(version.size, 1234);
});

test("WslFileAdapter exists returns true on success, false on error", async () => {
	const calls: ExecCall[] = [];
	const execSuccess = ((_c: string, args: string[], _o: Record<string, unknown>, cb: (e: Error | null) => void) => {
		calls.push({ command: _c, args, options: _o });
		cb(null);
		return { stdin: { end: () => {} } } as unknown as ReturnType<typeof ExecFileType>;
	}) as unknown as typeof ExecFileType;
	const okAdapter = makeAdapter(execSuccess);
	assert.equal(await okAdapter.exists("/exists.jsonl"), true);

	const execFail = ((_c: string, args: string[], _o: Record<string, unknown>, cb: (e: Error | null) => void) => {
		cb(new Error("not found"));
		return { stdin: { end: () => {} } } as unknown as ReturnType<typeof ExecFileType>;
	}) as unknown as typeof ExecFileType;
	const failAdapter = makeAdapter(execFail);
	assert.equal(await failAdapter.exists("/missing.jsonl"), false);

	assert.deepEqual(calls[0].args, ["-d", "Ubuntu", "-u", "ethan", "test", "-f", "/exists.jsonl"]);
});

test("WslFileAdapter collectJsonl splits find output lines", async () => {
	const execWithOutput = ((_c: string, _args: string[], _o: Record<string, unknown>, cb: (e: Error | null, s?: string) => void) => {
		cb(null, "/a/1.jsonl\n/a/2.jsonl\n/b/3.jsonl\n");
		return { stdin: { end: () => {} } } as unknown as ReturnType<typeof ExecFileType>;
	}) as unknown as typeof ExecFileType;
	const adapter = makeAdapter(execWithOutput);

	const files = await adapter.collectJsonl("/sessions");

	assert.deepEqual(files, ["/a/1.jsonl", "/a/2.jsonl", "/b/3.jsonl"]);
});

test("WslFileAdapter rmDir is silent on failure", async () => {
	const execFail = ((_c: string, _args: string[], _o: Record<string, unknown>, cb: (e: Error | null) => void) => {
		cb(new Error("rm failed"));
		return { stdin: { end: () => {} } } as unknown as ReturnType<typeof ExecFileType>;
	}) as unknown as typeof ExecFileType;
	const adapter = makeAdapter(execFail);

	// 不抛错
	await adapter.rmDir("/dir");
});

// ── LocalFileAdapter：真实临时目录 round-trip ──────────────

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("LocalFileAdapter read/write/stat round-trip", async () => {
	const dir = makeTempDir("local-adapter-");
	try {
		const adapter = new LocalFileAdapter();
		const file = join(dir, "session.jsonl");
		await adapter.write(file, "line1\nline2\n");

		const raw = await adapter.read(file);
		assert.equal(raw, "line1\nline2\n");

		const version = await adapter.stat(file);
		assert.ok(version.size > 0);
		assert.ok(version.mtimeMs > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("LocalFileAdapter readHead returns only head bytes", async () => {
	const dir = makeTempDir("local-adapter-head-");
	try {
		const adapter = new LocalFileAdapter();
		const file = join(dir, "big.jsonl");
		await adapter.write(file, "0123456789");

		const head = await adapter.readHead(file, 4);
		assert.equal(head, "0123");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("LocalFileAdapter exists/existsDir distinguish file vs dir", async () => {
	const dir = makeTempDir("local-adapter-exists-");
	try {
		const adapter = new LocalFileAdapter();
		const file = join(dir, "a.jsonl");
		const subdir = join(dir, "sub");
		await adapter.write(file, "x");
		mkdirSync(subdir);

		assert.equal(await adapter.exists(file), true);
		assert.equal(await adapter.exists(join(dir, "missing")), false);
		assert.equal(await adapter.existsDir(subdir), true);
		assert.equal(await adapter.existsDir(file), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("LocalFileAdapter rm removes file, rmDir removes tree", async () => {
	const dir = makeTempDir("local-adapter-rm-");
	try {
		const adapter = new LocalFileAdapter();
		const file = join(dir, "a.jsonl");
		await adapter.write(file, "x");
		await adapter.rm(file);
		assert.equal(await adapter.exists(file), false);

		const subdir = join(dir, "sub");
		mkdirSync(subdir);
		writeFileSync(join(subdir, "nested.jsonl"), "y");
		await adapter.rmDir(subdir);
		assert.equal(await adapter.existsDir(subdir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("LocalFileAdapter copy duplicates file", async () => {
	const dir = makeTempDir("local-adapter-copy-");
	try {
		const adapter = new LocalFileAdapter();
		const src = join(dir, "src.jsonl");
		const dst = join(dir, "dst.jsonl");
		await adapter.write(src, "content");
		await adapter.copy(src, dst);

		assert.equal(readFileSync(dst, "utf8"), "content");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("LocalFileAdapter collectJsonl finds nested jsonl files", async () => {
	const dir = makeTempDir("local-adapter-collect-");
	try {
		const adapter = new LocalFileAdapter();
		mkdirSync(join(dir, "nested"));
		writeFileSync(join(dir, "a.jsonl"), "x");
		writeFileSync(join(dir, "nested", "b.jsonl"), "y");
		writeFileSync(join(dir, "nested", "c.txt"), "not jsonl");

		const files = await adapter.collectJsonl(dir);
		assert.equal(files.length, 2);
		assert.ok(files.some((f) => f.endsWith("a.jsonl")));
		assert.ok(files.some((f) => f.endsWith("nested" + "\\b.jsonl") || f.endsWith("nested/b.jsonl")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
