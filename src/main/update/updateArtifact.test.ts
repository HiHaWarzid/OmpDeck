/**
 * UpdateArtifactDownloader 的不变式测试。
 *
 * 用假传输通道 + 假写流做确定性断言，不起任何真实网络：
 * 1. 流中断（response error / aborted）→ reject、清理 temp、最终路径不留半成品；
 * 2. 超时 → reject 而不是永久 pending；
 * 3. 同一资产并发只传输一次，两个调用拿到同一 promise/结果；
 * 4. write() 返回 false 时必须先等 drain，之后才继续写；
 * 5. 进度回调次数由时间预算决定，与 chunk 数无关。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import type { AppUpdateAsset, AppUpdateDownloadProgress } from "../../shared/types";
import {
	UpdateArtifactDownloader,
	type UpdateArtifactWriteStream,
	type UpdateDownloadRequest,
	type UpdateDownloadResponse,
	type UpdateDownloadTransport,
} from "./updateArtifact";

// ── 测试脚手架 ────────────────────────────────────────

/** 假体的监听器形参：`never[]` 让任意具体监听器都能赋值进来（事件名/载荷各不相同）。 */
type AnyListener = (...args: never[]) => void;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function makeTempDir() {
	const dir = await mkdtemp(join(tmpdir(), "ompdeck-update-"));
	tempDirs.push(dir);
	return dir;
}

function makeAsset(name = "OmpDeck-1.0.0-x64.zip", size = 0): AppUpdateAsset {
	return { name, url: "https://example.com/download", size };
}

/** 记录事件顺序的假写流；slowWrites 指定前几块写入返回 false（模拟慢盘）。 */
class RecordingWriteStream implements UpdateArtifactWriteStream {
	/** 元素是 "write" / "drain"，顺序本身就是背压是否被尊重的证据。 */
	readonly log: string[] = [];
	private readonly emitter = new EventEmitter();
	private readonly inner;
	private pendingSlowWrites: number;

	constructor(path: string, slowWrites = 0) {
		this.inner = createWriteStream(path);
		this.pendingSlowWrites = slowWrites;
		this.inner.on("close", () => this.emitter.emit("close"));
		this.inner.on("error", (error: Error) => this.emitter.emit("error", error));
	}

	write(chunk: Buffer): boolean {
		this.log.push("write");
		this.inner.write(chunk);
		if (this.pendingSlowWrites > 0) {
			this.pendingSlowWrites -= 1;
			return false;
		}
		return true;
	}

	/** 由测试显式排水，不依赖真实计时器。 */
	releaseDrain() {
		this.log.push("drain");
		this.emitter.emit("drain");
	}

	writeCount() {
		return this.log.filter((entry) => entry === "write").length;
	}

	end() {
		this.inner.end();
	}

	destroy() {
		this.inner.destroy();
	}

	on(event: string, listener: AnyListener): void {
		this.emitter.on(event, listener as unknown as (...args: unknown[]) => void);
	}

	once(event: string, listener: AnyListener): void {
		this.emitter.once(event, listener as unknown as (...args: unknown[]) => void);
	}
}

class FakeResponse implements UpdateDownloadResponse {
	readonly statusCode: number;
	readonly headers: Record<string, string | string[] | undefined>;
	pauseCount = 0;
	resumeCount = 0;
	private readonly emitter = new EventEmitter();

	constructor(statusCode = 200, headers: Record<string, string | string[] | undefined> = {}) {
		this.statusCode = statusCode;
		this.headers = headers;
	}

	on(event: string, listener: AnyListener): void {
		this.emitter.on(event, listener as unknown as (...args: unknown[]) => void);
	}

	pause() {
		this.pauseCount += 1;
	}

	resume() {
		this.resumeCount += 1;
	}

	emitData(chunk: Buffer) {
		this.emitter.emit("data", chunk);
	}

	emitEnd() {
		this.emitter.emit("end");
	}

	emitError(error: Error) {
		this.emitter.emit("error", error);
	}

	emitAborted() {
		this.emitter.emit("aborted");
	}
}

class FakeRequest implements UpdateDownloadRequest {
	readonly url: string;
	readonly headers: Record<string, string> = {};
	redirectCount = 0;
	aborted = false;
	ended = false;
	private readonly emitter = new EventEmitter();

	constructor(url: string) {
		this.url = url;
	}

	on(event: string, listener: AnyListener): void {
		this.emitter.on(event, listener as unknown as (...args: unknown[]) => void);
	}

	setHeader(name: string, value: string) {
		this.headers[name] = value;
	}

	followRedirect() {
		this.redirectCount += 1;
	}

	abort() {
		this.aborted = true;
		// 真实 ClientRequest 被 abort 后会派发 abort 事件；假体照做，用来验证不会重复 settle。
		this.emitter.emit("abort");
	}

	end() {
		this.ended = true;
	}

	respond(response: UpdateDownloadResponse) {
		this.emitter.emit("response", response);
	}
}

class FakeTransport {
	readonly requests: FakeRequest[] = [];
	readonly transport: UpdateDownloadTransport = (url) => {
		const request = new FakeRequest(url);
		this.requests.push(request);
		return request;
	};
}

type Harness = {
	dir: string;
	transport: FakeTransport;
	progress: AppUpdateDownloadProgress[];
	downloader: UpdateArtifactDownloader;
};

async function makeHarness(overrides: {
	timeoutMs?: number;
	progressIntervalMs?: number;
	now?: () => number;
} = {}): Promise<Harness> {
	const dir = await makeTempDir();
	const transport = new FakeTransport();
	const progress: AppUpdateDownloadProgress[] = [];
	const downloader = new UpdateArtifactDownloader({
		downloadDir: dir,
		transport: transport.transport,
		userAgent: "OmpDeck/test",
		onProgress: (entry) => progress.push(entry),
		...overrides,
	});
	return { dir, transport, progress, downloader };
}

// ── 1. 流中断 ─────────────────────────────────────────

test("response error 中途断流：reject、清理 temp、最终路径无半成品", async () => {
	const { dir, transport, progress, downloader } = await makeHarness({ timeoutMs: 5_000 });
	const asset = makeAsset("OmpDeck-1.0.0-x64.zip", 8);
	const promise = downloader.fetchToFile(asset);
	const response = new FakeResponse(200, { "content-length": "8" });
	transport.requests[0].respond(response);
	response.emitData(Buffer.from("1234"));
	response.emitError(new Error("socket hang up"));

	await assert.rejects(promise, /socket hang up/);
	assert.deepEqual(await readdir(dir), []);
	assert.equal(downloader.isVerified(join(dir, asset.name)), false);
	assert.equal(progress.filter((entry) => entry.state === "failed").length, 1);
	assert.equal(progress.some((entry) => entry.state === "completed"), false);
});

test("response aborted 中途断流：reject、清理 temp、最终路径无半成品", async () => {
	const { dir, transport, progress, downloader } = await makeHarness({ timeoutMs: 5_000 });
	const asset = makeAsset();
	const promise = downloader.fetchToFile(asset);
	const response = new FakeResponse(200, {});
	transport.requests[0].respond(response);
	response.emitData(Buffer.alloc(16, 1));
	response.emitAborted();

	await assert.rejects(promise, /下载中断/);
	assert.deepEqual(await readdir(dir), []);
	assert.equal(progress.filter((entry) => entry.state === "failed").length, 1);
});

test("HTTP 非 2xx：reject 且不落任何文件", async () => {
	const { dir, transport, downloader } = await makeHarness({ timeoutMs: 5_000 });
	const promise = downloader.fetchToFile(makeAsset("OmpDeck-1.0.0-x64.zip", 8));
	transport.requests[0].respond(new FakeResponse(404, {}));

	await assert.rejects(promise, /HTTP 404/);
	assert.deepEqual(await readdir(dir), []);
});

// ── 2. 超时 ───────────────────────────────────────────

test("超时：reject 而不是永久 pending，且不留文件", async () => {
	const { dir, transport, downloader } = await makeHarness({ timeoutMs: 30 });
	const asset = makeAsset();
	const promise = downloader.fetchToFile(asset);
	// 请求已发出但既无 response 也无 error（网络假死）。
	assert.equal(transport.requests.length, 1);
	assert.equal(transport.requests[0].ended, true);

	await assert.rejects(promise, /下载超时（30ms）/);
	assert.equal(transport.requests[0].aborted, true);
	assert.deepEqual(await readdir(dir), []);
});

// ── 3. 单飞 ───────────────────────────────────────────

test("并发下载同一资产：只传输一次，两个调用拿到同一 promise 与结果", async () => {
	const { dir, transport, downloader } = await makeHarness({ timeoutMs: 5_000 });
	const asset = makeAsset("OmpDeck-1.0.0-x64.zip", 8);
	const first = downloader.fetchToFile(asset);
	const second = downloader.fetchToFile(asset);
	assert.equal(first, second);
	assert.equal(transport.requests.length, 1);
	assert.equal(transport.requests[0].headers["User-Agent"], "OmpDeck/test");

	const response = new FakeResponse(200, { "content-length": "8" });
	transport.requests[0].respond(response);
	response.emitData(Buffer.from("abcdefgh"));
	response.emitEnd();

	const [a, b] = await Promise.all([first, second]);
	assert.deepEqual(a, b);
	assert.equal(a.filePath, join(dir, asset.name));
	assert.equal(a.bytes, 8);
	assert.equal(await readFile(a.filePath, "utf8"), "abcdefgh");
	// 只有最终文件，没有 .part 残留。
	assert.deepEqual(await readdir(dir), [asset.name]);
	assert.equal(downloader.isVerified(a.filePath), true);
});

test("传输结束后释放单飞占位，允许重新下载", async () => {
	const { transport, downloader } = await makeHarness({ timeoutMs: 5_000 });
	const asset = makeAsset();
	const first = downloader.fetchToFile(asset);
	const response = new FakeResponse(200, {});
	transport.requests[0].respond(response);
	response.emitEnd();
	await first;

	const second = downloader.fetchToFile(asset);
	assert.equal(transport.requests.length, 2);
	assert.notEqual(second, first);
	const retry = new FakeResponse(200, {});
	transport.requests[1].respond(retry);
	retry.emitEnd();
	await second;
});

// ── 4. 背压 ───────────────────────────────────────────

test("背压：write 返回 false 时先等 drain 再继续写", async () => {
	const dir = await makeTempDir();
	const asset = makeAsset("OmpDeck-1.0.0-x64.zip");
	const stream = new RecordingWriteStream(join(dir, `${asset.name}.part`), 1);
	const transport = new FakeTransport();
	const downloader = new UpdateArtifactDownloader({
		downloadDir: dir,
		transport: transport.transport,
		userAgent: "OmpDeck/test",
		onProgress: () => {},
		timeoutMs: 5_000,
		// 注入假写流：只有它能让 write 确定性地返回 false，从而断言背压顺序。
		openWriteStream: () => stream,
	});
	const promise = downloader.fetchToFile(asset);
	const response = new FakeResponse(200, {});
	transport.requests[0].respond(response);
	for (let index = 0; index < 5; index += 1) response.emitData(Buffer.from(`c${index}xx`));

	// 首块 write 返回 false：后续块必须排队等 drain，drain 之前不得再写。
	assert.equal(stream.writeCount(), 1);
	assert.equal(stream.log.includes("drain"), false);
	assert.equal(response.pauseCount, 1);

	stream.releaseDrain();
	assert.equal(stream.writeCount(), 5);
	assert.equal(stream.log.indexOf("drain"), 1);
	assert.equal(response.resumeCount, 1);

	response.emitEnd();
	const result = await promise;
	assert.equal(result.bytes, 20);
	assert.equal(await readFile(join(dir, asset.name), "utf8"), "c0xxc1xxc2xxc3xxc4xx");
});

// ── 5. 进度节流 ───────────────────────────────────────

test("进度回调次数由时间预算决定，与 chunk 数无关", async () => {
	async function countProgressEmits(chunkCount: number, msPerChunk: number) {
		let elapsed = 0;
		const { transport, progress, downloader } = await makeHarness({
			timeoutMs: 5_000,
			progressIntervalMs: 100,
			now: () => elapsed,
		});
		const promise = downloader.fetchToFile(makeAsset());
		const response = new FakeResponse(200, {});
		transport.requests[0].respond(response);
		for (let index = 0; index < chunkCount; index += 1) {
			response.emitData(Buffer.alloc(1));
			elapsed += msPerChunk;
		}
		response.emitEnd();
		await promise;
		assert.equal(progress.filter((entry) => entry.state === "completed").length, 1);
		assert.equal(progress.at(-1)?.percent, 100);
		return progress.filter((entry) => entry.state === "downloading").length;
	}

	// 同样 1000ms 的时间预算：50 块和 500 块应当推送同样多次进度（都被 100ms 间隔节流）。
	const sparse = await countProgressEmits(50, 20);
	const dense = await countProgressEmits(500, 2);
	assert.equal(sparse, dense);
	assert.equal(dense <= 11, true);
});
