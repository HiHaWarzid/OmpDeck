import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	/** 回归背景：omp 读的是 yml，镜像丢字段会让用户手工加的兼容配置在下次保存后静默失效。 */
	it("镜像无损：compat/thinking/thinkingLevelMap/input 等扩展字段全部落盘", async () => {
		const manager = new ConfigManager(dir);
		await manager.saveModelsConfig({
			providers: {
				minimax: {
					baseUrl: "https://api.minimax.cn/v1",
					apiKey: "sk-test",
					api: "openai-completions",
					compat: {
						supportsDeveloperRole: true,
						supportsReasoningEffort: false,
						reasoningEffortMap: { low: "low", high: "high" },
					},
					models: [
						{
							id: "MiniMax-M3",
							reasoning: true,
							contextWindow: 1000000,
							input: ["text", "image"],
							thinkingLevelMap: { xhigh: "max", low: null },
							thinking: {
								mode: "effort",
								efforts: ["low", "medium", "high", "xhigh", "max"],
								effortMap: { low: "low", xhigh: "xhigh" },
							},
						},
					],
				},
			},
		});

		const raw = await readFile(join(dir, "models.yml"), "utf8");
		const parsed = parseDocument(raw).toJS() as PiModelsFile;
		const provider = parsed.providers.minimax;
		// false 必须保留：compat 布尔开关不落盘等价于没配置
		expect(provider.compat).toEqual({
			supportsDeveloperRole: true,
			supportsReasoningEffort: false,
			reasoningEffortMap: { low: "low", high: "high" },
		});
		const model = provider.models![0];
		expect(model.input).toEqual(["text", "image"]);
		// null 必须保留：thinkingLevelMap 的 null 表示「禁用该档位映射」
		expect(model.thinkingLevelMap).toEqual({ xhigh: "max", low: null });
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			effortMap: { low: "low", xhigh: "xhigh" },
		});
	});

	it("models.json 缺失时回退读 yml：嵌套扩展字段完整读回而非误读成模型条目", async () => {
		const manager = new ConfigManager(dir);
		await manager.saveModelsConfig({
			providers: {
				minimax: {
					baseUrl: "https://api.minimax.cn/v1",
					api: "openai-completions",
					compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
					models: [
						{
							id: "MiniMax-M3",
							reasoning: true,
							thinking: {
								mode: "effort",
								effortMap: { high: "high" },
							},
						},
					],
				},
			},
		});
		await rm(join(dir, "models.json"), { force: true });

		const read = await manager.getModelsConfig();
		const provider = read.parsed?.providers.minimax;
		// 旧缩进解析器会把 compat 下的键读成一个 id 叫 supportsDeveloperRole 的模型
		expect(provider?.compat).toEqual({
			supportsDeveloperRole: true,
			supportsReasoningEffort: false,
		});
		expect(provider?.models).toHaveLength(1);
		expect(provider?.models?.[0]?.id).toBe("MiniMax-M3");
		expect(provider?.models?.[0]?.thinking).toEqual({
			mode: "effort",
			effortMap: { high: "high" },
		});
	});

	it("models.yml 语法损坏时回退读返回空 providers，不抛错不阻塞启动", async () => {
		const manager = new ConfigManager(dir);
		await writeFile(join(dir, "models.yml"), "providers:\n  bad: [unclosed\n", "utf8");

		const read = await manager.getModelsConfig();
		expect(read.parsed).toEqual({ providers: {} });
		// 孤儿化防护：yml 暂不可读时不得把空 providers 固化进 models.json。
		// 先让事件循环把可能存在的迁移写冲刷掉，再断言文件未产生。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(existsSync(join(dir, "models.json"))).toBe(false);
	});

	/** 钉住类型腐蚀回归：裸标量 id "20250101" 回读变 number 后会被字符串 id 过滤剔除。 */
	it("数值样/null/布尔样字符串值镜像时加引号，往返类型稳定", async () => {
		const manager = new ConfigManager(dir);
		await manager.saveModelsConfig({
			providers: {
				gateway: {
					apiKey: "20250101",
					models: [
						{ id: "20250101", name: "true" },
						{ id: "0x10", name: "~" },
						{ id: "5e3" },
					],
				},
			},
		});
		await rm(join(dir, "models.json"), { force: true });

		const read = await manager.getModelsConfig();
		const models = read.parsed?.providers.gateway.models ?? [];
		expect(models.map((model) => model.id)).toEqual(["20250101", "0x10", "5e3"]);
		expect(models.every((model) => typeof model.id === "string")).toBe(true);
		expect(models[0].name).toBe("true");
		expect(models[1].name).toBe("~");
		expect(read.parsed?.providers.gateway.apiKey).toBe("20250101");
		// 回退读会 fire-and-forget 地触发 models.json 迁移写；等它落盘再结束，
		// 避免异步写与 afterEach 的目录清理竞态
		await vi.waitFor(() => expect(existsSync(join(dir, "models.json"))).toBe(true));
	});

	/** 钉住指示符键/值回归：特殊键曾会让整份 yml 解析报错或静默结构腐蚀。 */
	it("指示符开头的键与逗号开头的值镜像后可无损读回", async () => {
		const manager = new ConfigManager(dir);
		const source: PiModelsFile = {
			providers: {
				weird: {
					apiKey: ",comma-start",
					models: [
						{
							id: "m1",
							"*weird*": "value",
							"- item": 1,
						},
					],
				},
			},
		};
		await manager.saveModelsConfig(source);

		const raw = await readFile(join(dir, "models.yml"), "utf8");
		const parsed = parseDocument(raw);
		expect(parsed.errors).toEqual([]);
		const model = (parsed.toJS() as PiModelsFile).providers.weird.models![0];
		expect(model["*weird*"]).toBe("value");
		expect(model["- item"]).toBe(1);
	});
});

describe("models.yml 镜像失败必须可见（不再静默吞掉）", () => {
	/**
	 * 让 models.yml 的写入失败：把它做成目录，写入时必然 EISDIR/EPERM。
	 * 这模拟真实场景（Windows 上被杀软/同步工具占用、权限不足），而不是注入 mock。
	 */
	async function breakYmlTarget(): Promise<void> {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(dir, "models.yml"), { recursive: true });
	}

	it("表单保存：models.json 已落盘，且返回结构化警告而不是假装成功", async () => {
		const manager = new ConfigManager(dir);
		await breakYmlTarget();

		const result = await manager.saveModelsConfig(models("openai"));

		// 保存本身是成功的：JSON 已写入，不能谎报「保存失败」让用户反复重试。
		expect(result.valid).toBe(true);
		expect(result.warnings?.[0]?.code).toBe("models-yml-mirror-failed");
		expect(result.warnings?.[0]?.detail).toBeTruthy();
		// 而 JSON 这份权威表示确实已更新。
		const json = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as PiModelsFile;
		expect(Object.keys(json.providers)).toContain("openai");
	});

	it("镜像成功时不产生任何警告（避免把正常路径也报成降级）", async () => {
		const manager = new ConfigManager(dir);
		const result = await manager.saveModelsConfig(models("openai"));
		expect(result.valid).toBe(true);
		expect(result.warnings).toBeUndefined();
	});

	it("原始 JSON 编辑路径同样返回警告", async () => {
		const manager = new ConfigManager(dir);
		await breakYmlTarget();

		const raw = JSON.stringify(models("openai"));
		const result = await manager.saveRawConfig("models.json", raw);

		expect(result.valid).toBe(true);
		expect(result.warnings?.[0]?.code).toBe("models-yml-mirror-failed");
	});
});
