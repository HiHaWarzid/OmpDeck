import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * electron 假体：UpdateManager 依赖 app/net/shell，vitest node 环境无法加载真实 electron。
 * 下载/安装用例用假响应驱动真实的 UpdateArtifactDownloader（真实 fs temp + rename）。
 *
 * vi.mock 工厂在 import 求值之前就会执行，工厂里引用 node:events 会命中 TDZ
 * （报错为 `Cannot access '__vi_import_1__' before initialization`），
 * 所以假事件源手写在 vi.hoisted 内部，不使用任何 import。
 */
const electronMock = vi.hoisted(() => {
	type Listener = (...args: never[]) => void;

	const requests: RequestRecord[] = [];

	class FakeEmitter {
		private readonly listeners = new Map<string, Listener[]>();

		on(event: string, listener: Listener) {
			const list = this.listeners.get(event) ?? [];
			list.push(listener);
			this.listeners.set(event, list);
		}

		once(event: string, listener: Listener) {
			const wrapped: Listener = (...args) => {
				this.off(event, wrapped);
				listener(...args);
			};
			this.on(event, wrapped);
		}

		off(event: string, listener: Listener) {
			const list = this.listeners.get(event);
			if (!list) return;
			const index = list.indexOf(listener);
			if (index >= 0) list.splice(index, 1);
		}

		emit(event: string, ...args: unknown[]) {
			// 复制一份再遍历：监听器里可能退订（once 包装），原地遍历会跳过后继监听器。
			for (const listener of [...(this.listeners.get(event) ?? [])]) {
				(listener as (...fnArgs: unknown[]) => void)(...args);
			}
		}
	}

	class FakeResponse extends FakeEmitter {
		statusCode = 200;
		headers: Record<string, string> = {};
		pauseCount = 0;
		resumeCount = 0;

		pause() {
			this.pauseCount += 1;
		}

		resume() {
			this.resumeCount += 1;
		}
	}

	type RequestRecord = {
		url: string;
		headers: Record<string, string>;
		redirects: number;
		ended: boolean;
		aborted: boolean;
		emitResponse: (statusCode: number, body: Buffer[], headers?: Record<string, string>) => void;
		emitError: (error: Error) => void;
	};

	class FakeClientRequest extends FakeEmitter {
		private readonly headers: Record<string, string> = {};
		private readonly response = new FakeResponse();

		constructor(url: string) {
			super();
			const record: RequestRecord = {
				url,
				headers: this.headers,
				redirects: 0,
				ended: false,
				aborted: false,
				emitResponse: (statusCode, body, headers = {}) => {
					this.response.statusCode = statusCode;
					this.response.headers = headers;
					this.emit("response", this.response);
					for (const chunk of body) this.response.emit("data", chunk);
					this.response.emit("end");
				},
				emitError: (error: Error) => this.emit("error", error),
			};
			requests.push(record);
		}

		setHeader(name: string, value: string) {
			this.headers[name] = value;
		}

		followRedirect() {
			const current = requests[requests.length - 1];
			if (current) current.redirects += 1;
		}

		abort() {
			const current = requests[requests.length - 1];
			if (current) current.aborted = true;
			this.emit("abort");
		}

		end() {
			const current = requests[requests.length - 1];
			if (current) current.ended = true;
		}
	}

	return {
		requests,
		openPath: vi.fn(async (_path: string) => ""),
		downloadDir: "",
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
		app: {
			getPath: (name: string) => (name === "userData" ? electronMock.downloadDir : process.cwd()),
			getVersion: () => "0.0.0-test",
		},
		net: { request: (options: { url: string }) => new FakeClientRequest(options.url) },
		shell: { openPath: (path: string) => electronMock.openPath(path) },
		BrowserWindow: class {},
	};
});

vi.mock("electron", () => electronMock);

import {
	UpdateManager,
	normalizeVersion,
	parseVersion,
	compareVersions,
	selectRecommendedAsset,
} from "./UpdateManager";
import type { AppUpdateAsset } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";

// 每次下载测试用独立临时目录当 userData/updates，避免跨用例串文件。
const tempDirs: string[] = [];

afterEach(async () => {
	electronMock.requests.length = 0;
	electronMock.openPath.mockClear();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeManager() {
	const dir = await mkdtemp(join(tmpdir(), "ompdeck-manager-"));
	tempDirs.push(dir);
	electronMock.downloadDir = dir;
	return {
		dir,
		manager: new UpdateManager({
			appLogger: electronMock.logger as unknown as AppLogger,
			getMainWindow: () => null,
		}),
	};
}

/**
 * 等下载真正发出请求：downloadUpdateAsset 先 await mkdir，net.request 在之后的微任务里才被调用，
 * 调用点同步断言会拿到空数组。
 */
async function waitForRequest(index = 0) {
	await vi.waitFor(() => {
		assert.ok(electronMock.requests.length > index, "download request not issued yet");
	});
	return electronMock.requests[index];
}

// ── normalizeVersion ───────────────────────────────────

test("normalizeVersion removes v prefix", () => {
	assert.equal(normalizeVersion("v1.0.0"), "1.0.0");
	assert.equal(normalizeVersion("V2.3.4"), "2.3.4");
});

test("normalizeVersion trims whitespace", () => {
	assert.equal(normalizeVersion("  1.0.0  "), "1.0.0");
	assert.equal(normalizeVersion("\t1.0.0\n"), "1.0.0");
});

test("normalizeVersion leaves bare version unchanged", () => {
	assert.equal(normalizeVersion("1.0.0"), "1.0.0");
});

// ── parseVersion ───────────────────────────────────────

test("parseVersion parses simple semver", () =>	assert.deepEqual(parseVersion("1.2.3"), { main: [1, 2, 3], pre: [] }));

test("parseVersion parses pre-release", () => {
	const result = parseVersion("1.2.3-beta.1");
	assert.deepEqual(result.main, [1, 2, 3]);
	assert.deepEqual(result.pre, ["beta", 1]);
});

test("parseVersion handles v prefix and whitespace", () => {
	assert.deepEqual(parseVersion(" v1.0.0 "), { main: [1, 0, 0], pre: [] });
});

test("parseVersion treats pre-release separators consistently", () => {
	// 1.0.0-rc.2 has pre = ["rc", 2]
	const result = parseVersion("1.0.0-rc.2");
	assert.deepEqual(result.pre, ["rc", 2]);
});

// ── compareVersions ────────────────────────────────────

test("compareVersions returns 0 for equal versions", () => {
	assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
	assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
	assert.equal(compareVersions("  0.6.7 ", "0.6.7"), 0);
});

test("compareVersions distinguishes major/minor/patch", () => {
	assert.ok(compareVersions("2.0.0", "1.0.0") > 0);
	assert.ok(compareVersions("1.1.0", "1.0.0") > 0);
	assert.ok(compareVersions("1.0.1", "1.0.0") > 0);
	assert.ok(compareVersions("1.0.0", "2.0.0") < 0);
	assert.ok(compareVersions("1.0.0", "1.1.0") < 0);
	assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
});

test("compareVersions treats release > pre-release", () => {
	// 正式版 > pre-release
	assert.ok(compareVersions("1.0.0", "1.0.0-beta.1") > 0);
	assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
});

test("compareVersions compares pre-release segments", () => {
	// 数字 pre-release 按数值比较
	assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.1") > 0);
	assert.ok(compareVersions("1.0.0-beta.1", "1.0.0-beta.2") < 0);
	// 字符串 pre-release 按字典序
	assert.ok(compareVersions("1.0.0-rc.1", "1.0.0-beta.1") > 0);
	assert.ok(compareVersions("1.0.0-beta.1", "1.0.0-rc.1") < 0);
});

test("compareVersions handles different segment counts", () => {
	// 1.0 vs 1.0.0 → 缺失段视为 0
	assert.equal(compareVersions("1.0", "1.0.0"), 0);
	assert.ok(compareVersions("1.0.1", "1.0") > 0);
});

test("compareVersions detects real-world update scenario", () => {
	// 0.6.7 → 0.6.8 应判定为有更新
	assert.ok(compareVersions("0.6.8", "0.6.7") > 0);
	// 0.6.7-beta.1 → 0.6.7 正式版应判定为有更新
	assert.ok(compareVersions("0.6.7", "0.6.7-beta.1") > 0);
});

// ── selectRecommendedAsset ─────────────────────────────

test("selectRecommendedAsset returns undefined for empty list", () => {
	assert.equal(selectRecommendedAsset([]), undefined);
});

test("selectRecommendedAsset picks matching platform asset", () => {
	const assets: AppUpdateAsset[] = [
		{ name: "OmpDeck-0.6.7-x64-setup.exe", url: "https://example.com/win.exe", size: 100 },
		{ name: "OmpDeck-0.6.7-arm64.dmg", url: "https://example.com/mac.dmg", size: 100 },
		{ name: "OmpDeck-0.6.7-x64.AppImage", url: "https://example.com/linux.AppImage", size: 100 },
	];
	// 函数会根据 process.platform/arch 选择；这里只验证它返回了一个非空结果
	const result = selectRecommendedAsset(assets);
	assert.ok(result !== undefined, "should return a recommended asset");
	// selectRecommendedAsset 通过 spread 创建新对象，用 name 匹配而非引用相等
	const names = assets.map((a) => a.name);
	assert.ok(names.includes(result.name), "result should match one of the input assets by name");
});

test("selectRecommendedAsset prefers setup exe on Windows installed", () => {
	if (process.platform !== "win32") return; // 仅 Windows 适用
	const assets: AppUpdateAsset[] = [
		{ name: "OmpDeck-0.6.7-x64.zip", url: "https://example.com/zip", size: 100 },
		{ name: "OmpDeck-0.6.7-x64-setup.exe", url: "https://example.com/setup.exe", size: 100 },
	];
	const result = selectRecommendedAsset(assets, "installed");
	assert.ok(result !== undefined);
	assert.ok(result.name.includes("setup"), "installed type should prefer setup exe");
});

// ── downloadUpdateAsset / installDownloadedUpdate ──────

const UPDATE_ASSET: AppUpdateAsset = {
	name: "OmpDeck-0.0.1-x64.zip",
	url: "https://example.com/OmpDeck.zip",
	size: 8,
};

test("downloadUpdateAsset 落盘到 userData/updates 且不留 .part", async () => {
	const { dir, manager } = await makeManager();
	const pending = manager.downloadUpdateAsset(UPDATE_ASSET);
	const request = await waitForRequest();
	assert.equal(request.headers["User-Agent"], "OmpDeck/0.0.0-test");

	request.emitResponse(200, [Buffer.from("abcdefgh")]);
	const result = await pending;
	const updatesDir = join(dir, "updates");
	assert.equal(result.filePath, join(updatesDir, UPDATE_ASSET.name));
	assert.equal(result.assetName, UPDATE_ASSET.name);
	assert.equal(await readFile(result.filePath, "utf8"), "abcdefgh");
	assert.deepEqual(await readdir(updatesDir), [UPDATE_ASSET.name]);
});

test("并发下载同一资产只发一次请求", async () => {
	const { manager } = await makeManager();
	const first = manager.downloadUpdateAsset(UPDATE_ASSET);
	const second = manager.downloadUpdateAsset(UPDATE_ASSET);
	const request = await waitForRequest();

	request.emitResponse(200, [Buffer.from("abcdefgh")]);
	const [a, b] = await Promise.all([first, second]);
	assert.deepEqual(a, b);
	// 第二次调用复用第一次的在途 promise，全程只发出一条请求。
	assert.equal(electronMock.requests.length, 1);
});

test("installDownloadedUpdate 只接受本次成功传输并 rename 的文件", async () => {
	const { dir, manager } = await makeManager();
	const pending = manager.downloadUpdateAsset(UPDATE_ASSET);
	const request = await waitForRequest();
	request.emitResponse(200, [Buffer.from("abcdefgh")]);
	const result = await pending;

	// 手写一个「看起来像更新包」的残留文件：没有本次传输记录，必须拒绝。
	const stalePath = join(dir, "updates", "OmpDeck-0.0.0-x64.zip");
	await writeFile(stalePath, "truncated");
	await assert.rejects(manager.installDownloadedUpdate(stalePath), /未通过校验/);
	await assert.rejects(manager.installDownloadedUpdate("/tmp/anything.exe"), /未通过校验/);
	assert.equal(electronMock.openPath.mock.calls.length, 0);

	await manager.installDownloadedUpdate(result.filePath);
	assert.deepEqual(electronMock.openPath.mock.calls, [[result.filePath]]);
});

test("中途断流：reject 且最终路径不存在半成品", async () => {
	const { dir, manager } = await makeManager();
	const pending = manager.downloadUpdateAsset(UPDATE_ASSET);
	const request = await waitForRequest();
	request.emitResponse(200, [Buffer.from("abcd")]);
	request.emitError(new Error("socket hang up"));

	await assert.rejects(pending, /socket hang up/);
	assert.deepEqual(await readdir(join(dir, "updates")), []);
	await assert.rejects(
		manager.installDownloadedUpdate(join(dir, "updates", UPDATE_ASSET.name)),
		/未通过校验/,
	);
	assert.equal(electronMock.openPath.mock.calls.length, 0);
});
