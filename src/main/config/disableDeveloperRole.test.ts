import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "./ConfigManager";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "disable-developer-role-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const modelsYml = `providers:
  commandcode:
    baseUrl: "https://api.commandcode.ai/provider/v1"
    api: openai-completions
    compat:
      supportsDeveloperRole: true
      supportsReasoningEffort: true
    models:
      - id: deepseek/deepseek-v4.1-flash
        name: DeepSeek Flash
`;

describe("ConfigManager.disableDeveloperRole", () => {
	it("把 provider 的 supportsDeveloperRole 关闭，并同步写入 models.json 与 models.yml", async () => {
		await writeFile(join(dir, "models.yml"), modelsYml, "utf8");
		const manager = new ConfigManager(dir);

		expect(await manager.disableDeveloperRole("commandcode")).toBe(true);

		const yml = parseDocument(await readFile(join(dir, "models.yml"), "utf8")).toJS() as {
			providers: Record<string, { compat?: Record<string, unknown> }>;
		};
		expect(yml.providers.commandcode.compat).toMatchObject({
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
		});
		const json = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as {
			providers: Record<string, { compat?: Record<string, unknown> }>;
		};
		expect(json.providers.commandcode.compat?.supportsDeveloperRole).toBe(false);
	});

	it("已是 false 或 provider 不存在时不改写配置", async () => {
		await writeFile(
			join(dir, "models.yml"),
			modelsYml.replace("supportsDeveloperRole: true", "supportsDeveloperRole: false"),
			"utf8",
		);
		const before = await readFile(join(dir, "models.yml"), "utf8");
		const manager = new ConfigManager(dir);

		expect(await manager.disableDeveloperRole("commandcode")).toBe(false);
		expect(await manager.disableDeveloperRole("missing")).toBe(false);
		expect(await readFile(join(dir, "models.yml"), "utf8")).toBe(before);
	});
});
