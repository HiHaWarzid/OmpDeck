import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "./ConfigManager";

let dir: string;
let manager: ConfigManager;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "config-export-")));
	manager = new ConfigManager(dir);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("export/import extended package", () => {
	it("export includes trust entries and both omp slots", async () => {
		await manager.setProjectTrustDecision("C:\\Work\\proj", true);
		await manager.applyOmpDefault("openai/gpt-4o", "high");

		const pkg = JSON.parse(await manager.exportConfig());
		expect(pkg.files["trust.json"]).toEqual({ "C:\\Work\\proj": true });
		expect(pkg.files["config.yml"].modelRoles.default).toBe("openai/gpt-4o:high");
		expect(pkg.files["config.yml"].defaultThinkingLevel).toBe("high");
	});

	it("import restores trust and roles atomically, package wins", async () => {
		const first = new ConfigManager(dir);
		await first.setProjectTrustDecision("C:\\Work\\proj", true);
		await first.applyOmpDefault("openai/gpt-4o", "high");
		const exported = await first.exportConfig();

		const target = await realpath(await mkdtemp(join(tmpdir(), "config-import-")));
		try {
			const restored = new ConfigManager(target);
			expect((await restored.importConfig(exported)).valid).toBe(true);
			expect(await restored.getProjectTrustDecision("C:\\Work\\proj")).toBe(true);
			expect(await restored.readOmpDefaultModel()).toEqual({
				selector: "openai/gpt-4o:high",
				provider: "openai",
				model: "gpt-4o",
				thinkingLevel: "high",
			});
			expect(await restored.getOmpDefaultThinkingLevel()).toBe("high");
		} finally {
			await rm(target, { recursive: true, force: true });
		}
	});

	it("import ignores invalid roles and non-boolean trust entries", async () => {
		const pkg = JSON.stringify({
			files: {
				"config.yml": {
					modelRoles: { default: "openai/gpt-4o:low", nope: "x", vision: "" },
				},
				"trust.json": { "C:\\A": true, "C:\\B": "yes" },
			},
		});
		expect((await manager.importConfig(pkg)).valid).toBe(true);
		expect((await manager.readOmpDefaultModel()).selector).toBe("openai/gpt-4o:low");
		expect(await manager.getProjectTrustDecision("C:\\A")).toBe(true);
		expect(await manager.getProjectTrustDecision("C:\\B")).toBe(null);
	});

	it("legacy package without new keys restores the three JSON files only", async () => {
		const pkg = JSON.stringify({
			files: {
				"models.json": { providers: {} },
				"auth.json": {},
				"settings.json": { theme: "dark" },
			},
		});
		expect((await manager.importConfig(pkg)).valid).toBe(true);
		expect((await manager.getSettingsConfig()).parsed).toEqual({ theme: "dark" });
		expect(await manager.getProjectTrustDecision("C:\\Work\\proj")).toBe(null);
	});
});
