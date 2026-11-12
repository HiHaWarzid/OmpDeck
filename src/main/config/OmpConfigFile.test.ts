import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OmpConfigFile, resolveOmpConfigFileName } from "./OmpConfigFile";
import { OmpRolesStore } from "./OmpRolesStore";

let dir: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "omp-config-")));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function newFile(): OmpConfigFile {
	return new OmpConfigFile({ resolveConfigDir: () => dir });
}

describe("OmpConfigFile", () => {
	it("writes a dot path while keeping comments and unrelated keys", async () => {
		await writeFile(
			join(dir, "config.yml"),
			[
				"# 用户注释必须保留",
				"retry:",
				"  maxRetries: 3 # 行尾注释",
				"customKey: keep-me",
			].join("\n"),
		);

		const result = await newFile().patch({
			set: [{ path: "retry.baseDelayMs", value: 750 }],
		});
		expect(result).toEqual({ valid: true });

		const raw = await readFile(join(dir, "config.yml"), "utf8");
		expect(raw).toContain("# 用户注释必须保留");
		expect(raw).toContain("# 行尾注释");
		expect(raw).toContain("customKey: keep-me");
		const parsed = await newFile().read();
		expect(parsed.parsed.retry).toEqual({ maxRetries: 3, baseDelayMs: 750 });
	});

	it("unset removes the key and prunes the empty parent", async () => {
		await writeFile(join(dir, "config.yml"), "retry:\n  maxRetries: 3\ncustomKey: keep-me\n");

		const result = await newFile().patch({ unset: ["retry.maxRetries"] });
		expect(result).toEqual({ valid: true });
		expect(await readFile(join(dir, "config.yml"), "utf8")).toBe("customKey: keep-me\n");
	});

	it("aborts without touching an unparsable file", async () => {
		const broken = "retry: [unclosed\n";
		await writeFile(join(dir, "config.yml"), broken);

		const result = await newFile().patch({ set: [{ path: "retry.maxRetries", value: 1 }] });
		expect(result.valid).toBe(false);
		expect(await readFile(join(dir, "config.yml"), "utf8")).toBe(broken);
	});

	it("reports a diagnostic for a non-mapping document", async () => {
		await writeFile(join(dir, "config.yml"), "- a\n- b\n");
		const parsed = await newFile().read();
		expect(parsed.parsed).toEqual({});
		expect(parsed.diagnostic?.message).toContain("映射");
	});

	it("rejects a raw save of unparsable YAML and keeps the old file", async () => {
		const file = newFile();
		await writeFile(join(dir, "config.yml"), "retry:\n  maxRetries: 3\n");

		const rejected = await file.writeRaw("retry: [unclosed\n");
		expect(rejected.valid).toBe(false);
		expect(await readFile(join(dir, "config.yml"), "utf8")).toBe("retry:\n  maxRetries: 3\n");

		const accepted = await file.writeRaw("# comment\nretry:\n  maxRetries: 4\n");
		expect(accepted).toEqual({ valid: true });
		expect(await readFile(join(dir, "config.yml"), "utf8")).toContain("maxRetries: 4");
	});

	it("prefers an existing config.yml when both spellings exist", async () => {
		const yml = join(dir, "config.yml");
		const yaml = join(dir, "config.yaml");
		await writeFile(yml, "retry:\n  maxRetries: 1\n");
		await writeFile(yaml, "retry:\n  maxRetries: 9\n");
		expect(resolveOmpConfigFileName(dir)).toBe("config.yml");
		expect((await newFile().read()).parsed.retry).toEqual({ maxRetries: 1 });

		await newFile().patch({ set: [{ path: "retry.baseDelayMs", value: 500 }] });
		expect(await readFile(yml, "utf8")).toContain("baseDelayMs: 500");
		expect(await readFile(yaml, "utf8")).toBe("retry:\n  maxRetries: 9\n");
	});

	it("updates an existing legacy config.yaml when config.yml is absent", async () => {
		const yaml = join(dir, "config.yaml");
		await writeFile(yaml, "retry:\n  maxRetries: 2\n");
		expect(resolveOmpConfigFileName(dir)).toBe("config.yaml");

		await newFile().patch({ set: [{ path: "retry.baseDelayMs", value: 500 }] });
		expect(await readFile(yaml, "utf8")).toContain("baseDelayMs: 500");
	});
});

describe("OmpRolesStore config file resolution", () => {
	it("writes roles to the same file OmpConfigFile reads when both exist", async () => {
		await writeFile(join(dir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o:high\n");
		const yaml = join(dir, "config.yaml");
		await writeFile(yaml, "modelRoles:\n  default: openai/gpt-4o\n");

		const roles = new OmpRolesStore({ resolveConfigDir: () => dir });
		expect((await roles.applyDefault("anthropic/claude-sonnet-4-5")).valid).toBe(true);

		expect(await readFile(join(dir, "config.yml"), "utf8")).toContain(
			"anthropic/claude-sonnet-4-5",
		);
		expect(await readFile(yaml, "utf8")).toBe("modelRoles:\n  default: openai/gpt-4o\n");
	});
});
