import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OmpRolesStore } from "./OmpRolesStore";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-roles-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function createStore() {
	return new OmpRolesStore({ resolveConfigDir: () => dir });
}

async function writeConfigYaml(content: string) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "config.yml"), content, "utf8");
}

describe("OmpRolesStore", () => {
	it("readRolesState returns all-empty assignments when config.yml is missing", async () => {
		const roles = await createStore().readRolesState();
		expect(roles.default).toEqual({ selector: "" });
		expect(roles.vision).toEqual({ selector: "" });
		expect(Object.keys(roles).length).toBeGreaterThanOrEqual(9);
	});

	it("readRolesState parses selectors incl. thinking suffixes", async () => {
		await writeConfigYaml(
			"modelRoles:\n  default: commandcode/deepseek/deepseek-v4-flash:high\n  vision: openai/gpt-4o\n",
		);
		const roles = await createStore().readRolesState();
		expect(roles.default.thinkingLevel).toBe("high");
		expect(roles.default.provider).toBe("commandcode");
		expect(roles.vision.modelId).toBe("gpt-4o");
		expect(roles.smol).toEqual({ selector: "" });
	});

	it("applyRole writes a single slot and preserves other keys/comments", async () => {
		await writeConfigYaml("# keep me\nmodelRoles:\n  default: old/provider\nsetupVersion: 1\n");
		const store = createStore();
		const result = await store.applyRole("vision", "openai/gpt-4o", "low");
		expect(result.valid).toBe(true);

		const raw = await (await import("node:fs/promises")).readFile(
			join(dir, "config.yml"),
			"utf8",
		);
		expect(raw).toContain("# keep me");
		expect(raw).toContain("setupVersion: 1");
		expect(raw).toContain("vision: openai/gpt-4o:low");
		expect(raw).toContain("default: old/provider");
	});

	it("applyDefault writes both schema slots atomically in one document", async () => {
		await writeConfigYaml("modelRoles: {}\n");
		const store = createStore();
		expect((await store.applyDefault("openai/gpt-4o", "high")).valid).toBe(true);

		const model = await store.readDefaultModel();
		expect(model).toEqual({
			selector: "openai/gpt-4o:high",
			provider: "openai",
			model: "gpt-4o",
			thinkingLevel: "high",
		});
		expect(await store.readDefaultThinkingLevel()).toBe("high");
	});

	it("applyDefault without level removes the stale top-level thinking slot", async () => {
		await writeConfigYaml(
			"modelRoles:\n  default: old/provider:low\ndefaultThinkingLevel: low\n",
		);
		const store = createStore();
		expect((await store.applyDefault("openai/gpt-4o")).valid).toBe(true);
		expect(await store.readDefaultThinkingLevel()).toBeUndefined();
		expect((await store.readDefaultModel()).thinkingLevel).toBeUndefined();
	});

	it("clearRole(default) removes both modelRoles.default and the top-level slot", async () => {
		await writeConfigYaml(
			"modelRoles:\n  default: openai/gpt-4o:high\n  vision: openai/gpt-4o\ndefaultThinkingLevel: high\n",
		);
		const store = createStore();
		expect((await store.clearRole("default")).valid).toBe(true);
		const roles = await store.readRolesState();
		expect(roles.default).toEqual({ selector: "" });
		expect(roles.vision.selector).toBe("openai/gpt-4o"); // 其它角色不受影响
		expect(await store.readDefaultThinkingLevel()).toBeUndefined();
	});

	it("readDefaultModel falls back to top-level thinking when role has no suffix", async () => {
		await writeConfigYaml(
			"modelRoles:\n  default: openai/gpt-4o\ndefaultThinkingLevel: low\n",
		);
		const model = await createStore().readDefaultModel();
		expect(model.thinkingLevel).toBe("low");
	});

	it("config.yaml fallback naming is honored on read and write", async () => {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "config.yaml"), "modelRoles:\n  default: openai/gpt-4o\n", "utf8");
		const store = createStore();
		expect((await store.readDefaultModel()).provider).toBe("openai");
		await store.applyRole("vision", "openai/gpt-4o");
		expect(existsSync(join(dir, "config.yaml"))).toBe(true);
		expect(existsSync(join(dir, "config.yml"))).toBe(false);
	});

	it("migrateLegacyDefaultThinkingLevel fills only when config.yml lacks the slot", async () => {
		await writeConfigYaml("modelRoles: {}\n");
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({ defaultThinkingLevel: "high", theme: "dark" }),
			"utf8",
		);
		const store = createStore();
		await store.migrateLegacyDefaultThinkingLevel();
		expect(await store.readDefaultThinkingLevel()).toBe("high");
	});

	it("legacy migration never overrides an existing config.yml value", async () => {
		await writeConfigYaml("defaultThinkingLevel: low\n");
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({ defaultThinkingLevel: "high" }),
			"utf8",
		);
		const store = createStore();
		await store.migrateLegacyDefaultThinkingLevel();
		expect(await store.readDefaultThinkingLevel()).toBe("low");
	});

	it("legacy migration is a no-op when settings.json has no value", async () => {
		await writeConfigYaml("modelRoles: {}\n");
		await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
		await createStore().migrateLegacyDefaultThinkingLevel();
		expect(existsSync(join(dir, "config.yml"))).toBe(true);
	});
});
