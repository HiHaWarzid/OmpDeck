import { describe, expect, it } from "vitest";
import { detectModelListCommand, parseLegacyModelTable, parseModelsJson } from "./piModels";

describe("pi model list command detection", () => {
	it("prefers the legacy flag when help lists --list-models", () => {
		expect(detectModelListCommand("Usage: omp [options]\n  --list-models  List models\n")).toEqual({
			mode: "table",
			args: ["--list-models"],
		});
	});

	it("detects the models subcommand on new pi (no --list-models flag)", () => {
		// 真实 18.10 help 片段：子命令带缩进与说明，标志位行以 `-` 开头。
		const help = [
			"Options:",
			"  --models=<value>  Comma-separated model patterns for Ctrl+P cycling",
			"Commands:",
			"  models            List, search, and refresh available models",
			"  bench             Benchmark models: TTFT/prefill vs decode",
		].join("\n");
		expect(detectModelListCommand(help)).toEqual({ mode: "json", args: ["models", "--json"] });
	});

	it("returns undefined when neither form is exposed (no guessing, no hung subprocess)", () => {
		expect(detectModelListCommand("Usage: omp [options]\n  --models=<value>\n")).toBeUndefined();
	});
});

describe("parseModelsJson", () => {
	const payload = {
		models: [
			{
				provider: "commandcode",
				kind: "chat",
				id: "deepseek/deepseek-v4.1-flash",
				selector: "commandcode/deepseek/deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				contextWindow: 1_000_000,
				reasoning: true,
				thinking: ["low", "high"],
				input: ["text", "image"],
			},
			{ provider: "opencode", id: "no-name", input: ["text"], reasoning: false },
			{ provider: "minimax", id: "MiniMax-M2.5", name: "MiniMax M2.5", input: ["text"] },
			// 畸形条目：缺 provider / id 必须跳过，不能让 undefined 流进 set_model。
			{ id: "orphan" },
			{ provider: "broken" },
			null,
		],
	};

	it("maps provider/id/name and derives reasoning + image support", () => {
		const models = parseModelsJson(JSON.stringify(payload));
		expect(models).toEqual([
			{
				provider: "commandcode",
				id: "deepseek/deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				contextWindow: 1_000_000,
				reasoning: true,
				supportsImages: true,
			},
			{ provider: "opencode", id: "no-name", name: "opencode/no-name", reasoning: false, supportsImages: false },
			{
				provider: "minimax",
				id: "MiniMax-M2.5",
				name: "MiniMax M2.5",
				reasoning: false,
				supportsImages: false,
			},
		]);
	});

	it("keeps the plain model id (matches models.yml id, so set_model resolves)", () => {
		// models.yml 里 minimax 段的 id 就是 `MiniMax-M3`，不能退化成 selector/provider 前缀形式。
		const models = parseModelsJson(JSON.stringify({ models: [{ provider: "minimax", id: "MiniMax-M3" }] }));
		expect(models[0]).toMatchObject({ provider: "minimax", id: "MiniMax-M3" });
	});

	it("returns [] on non-JSON output instead of throwing", () => {
		expect(parseModelsJson("Usage: omp models\n")).toEqual([]);
		expect(parseModelsJson("")).toEqual([]);
	});
});

describe("parseLegacyModelTable", () => {
	it("reads thinking/images from the last two columns", () => {
		const table = [
			"provider        model              context  max-out  thinking  images",
			"minimax         MiniMax-M2.5       200000   8192     yes       no",
			"commandcode     deepseek-v4-flash  1000000  128000   no        yes",
		].join("\n");
		expect(parseLegacyModelTable(table)).toEqual([
			{
				provider: "minimax",
				id: "MiniMax-M2.5",
				name: "minimax/MiniMax-M2.5",
				reasoning: true,
				supportsImages: false,
			},
			{
				provider: "commandcode",
				id: "deepseek-v4-flash",
				name: "commandcode/deepseek-v4-flash",
				reasoning: false,
				supportsImages: true,
			},
		]);
	});

	it("ignores header-only output", () => {
		expect(parseLegacyModelTable("provider model context max-out thinking images")).toEqual([]);
	});
});
