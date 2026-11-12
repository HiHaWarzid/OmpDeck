import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager, type PiModelsFile } from "./ConfigManager";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "auth-config-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function readProviders(raw: string): PiModelsFile["providers"] {
	return (parseDocument(raw).toJS() as PiModelsFile).providers;
}

describe("Auth 页写入 models.yml", () => {
	it("保留注释和其它字段，只改 apiKey", async () => {
		await writeFile(
			join(dir, "models.yml"),
			[
				"# keep this comment",
				"providers:",
				"  openai:",
				"    baseUrl: https://api.openai.com/v1",
				"    models:",
				"      - id: gpt-4o",
			].join("\n"),
		);

		const manager = new ConfigManager(dir);
		expect(
			(await manager.saveAuthConfig({ openai: { key: "OPENAI_API_KEY" } })).valid,
		).toBe(true);

		const raw = await readFile(join(dir, "models.yml"), "utf8");
		expect(raw).toContain("# keep this comment");
		const providers = readProviders(raw);
		expect(providers.openai.apiKey).toBe("OPENAI_API_KEY");
		expect(providers.openai.baseUrl).toBe("https://api.openai.com/v1");
		expect(providers.openai.models.map((model) => model.id)).toEqual(["gpt-4o"]);

		// models.json 同步为 yml 的完整视图，供 Models 页读取。
		const modelsJson = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as PiModelsFile;
		expect(modelsJson.providers.openai.apiKey).toBe("OPENAI_API_KEY");
	});

	it("!command 原样保存；删除 key 保留 provider 与模型", async () => {
		const manager = new ConfigManager(dir);
		await manager.saveModelsConfig({
			providers: {
				commandcode: {
					baseUrl: "https://api.commandcode.ai/provider",
					models: [{ id: "deepseek/deepseek-v4.1-flash" }],
				},
			},
		});

		await manager.saveAuthConfig({
			commandcode: { key: "!security find-generic-password -s commandcode -w" },
		});
		let providers = readProviders(await readFile(join(dir, "models.yml"), "utf8"));
		expect(providers.commandcode.apiKey).toBe(
			"!security find-generic-password -s commandcode -w",
		);

		await manager.saveAuthConfig({});
		providers = readProviders(await readFile(join(dir, "models.yml"), "utf8"));
		expect(providers.commandcode.apiKey).toBeUndefined();
		expect(providers.commandcode.models.map((model) => model.id)).toEqual([
			"deepseek/deepseek-v4.1-flash",
		]);
	});

	it("getAuth 只读 models.yml，不再回退废弃的 auth.json", async () => {
		await writeFile(
			join(dir, "models.yml"),
			"providers:\n  openai:\n    apiKey: yml-key\n    models:\n      - id: gpt-4o\n",
		);
		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({ openai: { type: "api_key", key: "legacy-key" } }),
		);

		const manager = new ConfigManager(dir);
		const auth = await manager.getAuthConfig();
		expect(auth.parsed).toEqual({ openai: { key: "yml-key" } });
		expect(auth.raw).toContain("yml-key");
	});

	it("models.yml 不存在时从 models.json 建基线并生成两份文件", async () => {
		await writeFile(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					commandcode: {
						baseUrl: "https://api.commandcode.ai/provider",
						models: [{ id: "deepseek/deepseek-v4.1-flash" }],
					},
				},
			}),
		);
		const manager = new ConfigManager(dir);

		expect(
			(await manager.saveAuthConfig({ commandcode: { key: "COMMANDCODE_API_KEY" } })).valid,
		).toBe(true);
		const ymlProviders = readProviders(await readFile(join(dir, "models.yml"), "utf8"));
		expect(ymlProviders.commandcode.apiKey).toBe("COMMANDCODE_API_KEY");
		expect(ymlProviders.commandcode.models.map((model) => model.id)).toEqual([
			"deepseek/deepseek-v4.1-flash",
		]);
		const jsonProviders = JSON.parse(
			await readFile(join(dir, "models.json"), "utf8"),
		) as PiModelsFile;
		expect(jsonProviders.providers.commandcode.apiKey).toBe("COMMANDCODE_API_KEY");
	});

	it("providers/provider 为显式 null 与空文件也能补出 key", async () => {
		await writeFile(join(dir, "models.yml"), "providers:\n");
		const manager = new ConfigManager(dir);
		expect((await manager.saveAuthConfig({ openai: { key: "sk" } })).valid).toBe(true);
		expect(readProviders(await readFile(join(dir, "models.yml"), "utf8")).openai.apiKey).toBe("sk");

		await writeFile(join(dir, "models.yml"), "providers:\n  openai:\n");
		expect((await manager.saveAuthConfig({ openai: { key: "sk-null" } })).valid).toBe(true);
		expect(readProviders(await readFile(join(dir, "models.yml"), "utf8")).openai.apiKey).toBe(
			"sk-null",
		);

		await writeFile(join(dir, "models.yml"), "");
		expect((await manager.saveAuthConfig({ openai: { key: "sk-empty" } })).valid).toBe(true);
		expect(readProviders(await readFile(join(dir, "models.yml"), "utf8")).openai.apiKey).toBe(
			"sk-empty",
		);
	});

	it("models.yml 损坏时拒绝保存，不覆盖原文件", async () => {
		const broken = "providers: [unclosed\n";
		await writeFile(join(dir, "models.yml"), broken);
		const manager = new ConfigManager(dir);

		const result = await manager.saveAuthConfig({ openai: { key: "sk" } });
		expect(result.valid).toBe(false);
		expect(await readFile(join(dir, "models.yml"), "utf8")).toBe(broken);
	});
});

describe("导出/导入凭据", () => {
	it("导出包不含 apiKey 与 auth.json；导入保留目标机器已有 key 并镜像 models.yml", async () => {
		const source = new ConfigManager(dir);
		await source.saveModelsConfig({
			providers: {
				openai: {
					baseUrl: "https://api.openai.com/v1",
					models: [{ id: "gpt-4o" }],
				},
			},
		});
		await source.saveAuthConfig({ openai: { key: "sk-source" } });
		const pkg = JSON.parse(await source.exportConfig()) as {
			files: Record<string, unknown>;
		};
		expect(pkg.files["auth.json"]).toBeUndefined();
		const exportedModels = pkg.files["models.json"] as PiModelsFile;
		expect(exportedModels.providers.openai.apiKey).toBeUndefined();
		expect(exportedModels.providers.openai.models).toEqual([{ id: "gpt-4o" }]);

		const targetDir = await mkdtemp(join(tmpdir(), "auth-config-target-"));
		try {
			const target = new ConfigManager(targetDir);
			await target.saveModelsConfig({
				providers: {
					openai: {
						baseUrl: "https://api.openai.com/v1",
						apiKey: "sk-target",
						models: [{ id: "gpt-4o" }],
					},
				},
			});

			const result = await target.importConfig(JSON.stringify(pkg));
			expect(result.valid).toBe(true);
			const providers = readProviders(
				await readFile(join(targetDir, "models.yml"), "utf8"),
			);
			expect(providers.openai.apiKey).toBe("sk-target");
			// 旧包里的空 apiKey 等同“未提供”，不能把目标机器已有的 key 清空。
			const legacyPkg = JSON.parse(JSON.stringify(pkg)) as {
				files: { "models.json": PiModelsFile };
			};
			legacyPkg.files["models.json"].providers.openai.apiKey = "";
			expect((await target.importConfig(JSON.stringify(legacyPkg))).valid).toBe(true);
			const afterLegacy = readProviders(
				await readFile(join(targetDir, "models.yml"), "utf8"),
			);
			expect(afterLegacy.openai.apiKey).toBe("sk-target");
			// 旧包携带的 auth.json 不再恢复成可被 omp 读取的凭据文件。
			expect(existsSync(join(targetDir, "auth.json"))).toBe(false);
		} finally {
			await rm(targetDir, { recursive: true, force: true });
		}
	});
});
