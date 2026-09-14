import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager, type PiModelsFile } from "./ConfigManager";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "models-yml-mirror-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 每次保存都走真实 rename：残留的 tmp 会以 `<name>.<pid>.tmp` 形式留在同目录。 */
async function tmpLeftovers(): Promise<string[]> {
	const names = await readdir(dir);
	return names.filter((name) => name.endsWith(".tmp"));
}

function models(providerName: string): PiModelsFile {
	return {
		providers: {
			[providerName]: {
				baseUrl: `https://${providerName}.example.com/v1`,
				models: [{ id: `${providerName}-model`, name: `${providerName} model` }],
			},
		},
	};
}

describe("ConfigManager models.yml 镜像写", () => {
	it("saveModelsConfig 后 models.yml 可完整读回（与 models.json 同源）", async () => {
		const manager = new ConfigManager(dir);
		expect((await manager.saveModelsConfig(models("openai"))).valid).toBe(true);

		const raw = await readFile(join(dir, "models.yml"), "utf8");
		const parsed = parseDocument(raw).toJS() as {
			providers: Record<string, { baseUrl?: string; models?: Array<{ id: string }> }>;
		};
		expect(Object.keys(parsed.providers)).toEqual(["openai"]);
		expect(parsed.providers.openai.baseUrl).toBe("https://openai.example.com/v1");
		expect(parsed.providers.openai.models?.map((model) => model.id)).toEqual([
			"openai-model",
		]);
		expect(await tmpLeftovers()).toEqual([]);
	});

	it("并发保存同一 models.yml：落盘是某一次保存的完整镜像，且不留 tmp", async () => {
		const manager = new ConfigManager(dir);
		await Promise.all([
			manager.saveModelsConfig(models("alpha")),
			manager.saveModelsConfig(models("beta")),
		]);

		const raw = await readFile(join(dir, "models.yml"), "utf8");
		const parsed = parseDocument(raw).toJS() as {
			providers: Record<string, { models?: Array<{ id: string }> }>;
		};
		const providers = Object.keys(parsed.providers);
		// 两次保存的镜像内容互不混合：最终只可能是 alpha 或 beta 的完整一份
		expect(providers.length).toBe(1);
		const winner = providers[0];
		expect(["alpha", "beta"]).toContain(winner);
		expect(parsed.providers[winner].models?.map((model) => model.id)).toEqual([
			`${winner}-model`,
		]);
		expect(await tmpLeftovers()).toEqual([]);
	});

	it("saveRawConfig 的 models.yml 同步失败时不破坏已有镜像", async () => {
		const manager = new ConfigManager(dir);
		await manager.saveModelsConfig(models("first"));
		const before = await readFile(join(dir, "models.yml"), "utf8");

		// 合法 JSON 但缺 providers：models.json 照常落盘，models.yml 同步抛错被吞掉，
		// 旧镜像保持完整（不是半个 YAML，也不是被清空）
		expect((await manager.saveRawConfig("models.json", JSON.stringify({ other: true }))).valid).toBe(
			true,
		);
		expect(await readFile(join(dir, "models.yml"), "utf8")).toBe(before);
		expect(await tmpLeftovers()).toEqual([]);
	});

	it("镜像格式不变：键顺序与缩进与历史实现一致", async () => {
		const manager = new ConfigManager(dir);
		await manager.saveModelsConfig({
			providers: {
				openai: {
					baseUrl: "https://api.example.com",
					apiKey: "sk-test",
					api: "openai-completions",
					models: [{ id: "gpt-4o", name: "GPT-4o", reasoning: true, contextWindow: 128000 }],
				},
			},
		});
		// 落盘必须是同一份纯文本（非 JSON 包装），末行换行符保留
		const raw = await readFile(join(dir, "models.yml"), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(raw.startsWith("providers:\n")).toBe(true);
		expect(raw).toContain("  openai:\n");
		expect(raw).toContain("        reasoning: true\n");
	});
});
