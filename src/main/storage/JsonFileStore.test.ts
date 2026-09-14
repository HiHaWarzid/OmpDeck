import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustStore } from "../config/TrustStore";
import { renameWithRetry } from "../utils/fsRetry";
import { JsonFileStore } from "./JsonFileStore";

let dir: string;
let filePath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "json-file-store-"));
	filePath = join(dir, "store.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function readJson(): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8"));
}

describe("JsonFileStore 原子性", () => {
	it("写 tmp 中途失败：目标文件保持上一次的完整内容，不出现半个 JSON", async () => {
		let failWrites = false;
		const store = new JsonFileStore<{ value: string }>(filePath, {
			io: {
				writeText: async (path, text) => {
					if (failWrites) throw new Error("injected write failure");
					await writeFile(path, text, "utf8");
				},
			},
		});
		await store.write({ value: "完整旧内容" });

		failWrites = true;
		await expect(store.write({ value: "新内容" })).rejects.toThrow("injected write failure");
		// 旧文件不仅是「存在」，而是可完整解析的旧值：没有截断/半写
		expect(await readJson()).toEqual({ value: "完整旧内容" });
		expect(await store.read({ value: "fallback" })).toEqual({ value: "完整旧内容" });
	});

	it("rename 失败：目标文件保持旧内容，且失败不污染后续写入", async () => {
		const seed = new JsonFileStore<{ value: string }>(filePath);
		await seed.write({ value: "旧" });

		let failRename = true;
		const flaky = new JsonFileStore<{ value: string }>(filePath, {
			io: {
				rename: async (from, to) => {
					if (failRename) throw new Error("injected rename failure");
					await renameWithRetry(from, to);
				},
			},
		});
		await expect(flaky.write({ value: "新" })).rejects.toThrow("injected rename failure");
		expect(await readJson()).toEqual({ value: "旧" });

		// 同一实例恢复可写：一次失败不留下毒化的队列/缓存
		failRename = false;
		await flaky.write({ value: "恢复" });
		expect(await readJson()).toEqual({ value: "恢复" });
		expect(await flaky.read({ value: "fallback" })).toEqual({ value: "恢复" });
	});
});

describe("JsonFileStore update 串行", () => {
	it("并发 update 同一路径不丢键（就地 read-modify-write 会丢）", async () => {
		const total = 25;
		const store = new JsonFileStore<Record<string, number>>(filePath);
		await Promise.all(
			Array.from({ length: total }, (_, index) =>
				store.update((current) => ({ ...(current ?? {}), [`k${index}`]: index })),
			),
		);

		const expected: Record<string, number> = {};
		for (let index = 0; index < total; index += 1) expected[`k${index}`] = index;
		expect(await readJson()).toEqual(expected);
	});

	it("update 基于队列内的最新内容：后一次看到前一次写入的键", async () => {
		const store = new JsonFileStore<Record<string, number>>(filePath);
		await store.update((current) => ({ ...(current ?? {}), a: 1 }));
		await store.update((current) => ({ ...(current ?? {}), b: 2 }));
		expect(await readJson()).toEqual({ a: 1, b: 2 });
	});
});

describe("JsonFileStore 读指纹", () => {
	it("外部改动（mtime/size 变化）后 read 返回新内容", async () => {
		const store = new JsonFileStore<{ value: string }>(filePath);
		await store.write({ value: "one" });
		expect((await store.read({ value: "fallback" })).value).toBe("one");

		// 绕过 store 直接改文件：指纹（size 必然变化）失效 → 重读重解析
		await writeFile(filePath, JSON.stringify({ value: "external-and-longer" }), "utf8");
		expect((await store.read({ value: "fallback" })).value).toBe("external-and-longer");
	});

	it("外部删除后 read 回落 fallback，readRaw 返回 null", async () => {
		const store = new JsonFileStore<{ value: string }>(filePath);
		await store.write({ value: "one" });
		await rm(filePath, { force: true });
		expect(await store.read({ value: "fallback" })).toEqual({ value: "fallback" });
		expect(await store.readRaw()).toBeNull();
	});

	it("内容损坏：read 回落 fallback，readRaw/update 抛错不静默覆盖", async () => {
		const store = new JsonFileStore<{ value: string }>(filePath);
		await writeFile(filePath, "{ 半个 JSON", "utf8");
		expect(await store.read({ value: "fallback" })).toEqual({ value: "fallback" });
		await expect(store.readRaw()).rejects.toThrow();
		await expect(store.update(() => ({ value: "overwrite" }))).rejects.toThrow();
		expect(await readFile(filePath, "utf8")).toBe("{ 半个 JSON");
	});
});

describe("真实 store 回归", () => {
	it("TrustStore setDecision 落盘后仍可读回（完整 JSON 往返）", async () => {
		const store = new TrustStore({ resolveConfigDir: () => dir });
		await store.setDecision("C:\\Work\\proj", true);
		expect(await store.getDecision("C:\\Work\\proj")).toBe(true);

		const parsed: unknown = JSON.parse(await readFile(join(dir, "trust.json"), "utf8"));
		expect(parsed).toEqual({ "C:\\Work\\proj": true });
	});

	it("TrustStore 并发决策在同一路径上不丢键（就地 RMW 会丢）", async () => {
		const store = new TrustStore({ resolveConfigDir: () => dir });
		await Promise.all([
			store.setDecision("C:\\A", true),
			store.setDecision("C:\\B", false),
			store.setDecision("C:\\C", true),
			store.ensureTrustedDirectory("C:\\D"),
		]);

		const { entries, ok } = await store.readTrust();
		expect(ok).toBe(true);
		expect(entries).toEqual({
			"C:\\A": true,
			"C:\\B": false,
			"C:\\C": true,
			"C:\\D": true,
		});
	});
});
