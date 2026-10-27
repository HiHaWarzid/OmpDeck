import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
		await manager.trustStore.setDecision("C:\\Work\\proj", true);
		await manager.rolesStore.applyDefault("openai/gpt-4o", "high");

		const pkg = JSON.parse(await manager.exportConfig());
		expect(pkg.files["trust.json"]).toEqual({ "C:\\Work\\proj": true });
		expect(pkg.files["config.yml"].modelRoles.default).toBe("openai/gpt-4o:high");
		expect(pkg.files["config.yml"].defaultThinkingLevel).toBe("high");
	});

	it("import restores trust and roles atomically, package wins", async () => {
		const first = new ConfigManager(dir);
		await first.trustStore.setDecision("C:\\Work\\proj", true);
		await first.rolesStore.applyDefault("openai/gpt-4o", "high");
		const exported = await first.exportConfig();

		const target = await realpath(await mkdtemp(join(tmpdir(), "config-import-")));
		try {
			const restored = new ConfigManager(target);
			expect((await restored.importConfig(exported)).valid).toBe(true);
			expect(await restored.trustStore.getDecision("C:\\Work\\proj")).toBe(true);
			expect(await restored.rolesStore.readDefaultModel()).toEqual({
				selector: "openai/gpt-4o:high",
				provider: "openai",
				model: "gpt-4o",
				thinkingLevel: "high",
			});
			expect(await restored.rolesStore.readDefaultThinkingLevel()).toBe("high");
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
		expect((await manager.rolesStore.readDefaultModel()).selector).toBe("openai/gpt-4o:low");
		expect(await manager.trustStore.getDecision("C:\\A")).toBe(true);
		expect(await manager.trustStore.getDecision("C:\\B")).toBe(null);
	});

	it("legacy package ignores settings.json (omp no longer reads it)", async () => {
		const pkg = JSON.stringify({
			files: {
				"models.json": { providers: {} },
				"auth.json": {},
				"settings.json": { theme: "dark" },
			},
		});
		expect((await manager.importConfig(pkg)).valid).toBe(true);
		// settings.json 已不是 omp 的读取源：导入不应把它搬进 config.yml
		expect((await manager.ompConfig.read()).parsed).toEqual({});
		expect(await manager.trustStore.getDecision("C:\\Work\\proj")).toBe(null);
		// auth.json 同样不再恢复：凭据只认 models.yml。
		expect(existsSync(join(dir, "auth.json"))).toBe(false);
	});

	it("import applies editable settings from config.yml and keeps other keys", async () => {
		await manager.ompConfig.patch({
			set: [
				{ path: "auth.broker.token", value: "keep-me" },
				{ path: "retry.maxRetries", value: 9 },
			],
		});
		const pkg = JSON.stringify({
			files: {
				"config.yml": {
					enabledModels: ["openai/gpt-4o"],
					retry: { baseDelayMs: 250 },
					compaction: { enabled: false },
				},
			},
		});
		expect((await manager.importConfig(pkg)).valid).toBe(true);
		const parsed = (await manager.ompConfig.read()).parsed;
		expect(parsed.enabledModels).toEqual(["openai/gpt-4o"]);
		// 包内缺失的 retry.maxRetries 保持目标原值（只写给出项）
		expect(parsed.retry).toEqual({ maxRetries: 9, baseDelayMs: 250 });
		expect(parsed.compaction).toEqual({ enabled: false });
		expect(parsed.auth).toEqual({ broker: { token: "keep-me" } });
	});
	it("rejects the whole package when the existing config.yml is unparsable", async () => {
		const broken = "modelRoles: [unclosed\n";
		await writeFile(join(dir, "config.yml"), broken);
		await manager.trustStore.setDecision("C:\\Existing", true);

		const pkg = JSON.stringify({
			files: {
				"config.yml": {
					modelRoles: { default: "openai/gpt-4o:high" },
					retry: { maxRetries: 2 },
				},
				"trust.json": { "C:\\New": true },
			},
		});
		const result = await manager.importConfig(pkg);
		expect(result.valid).toBe(false);
		// 预检发生在任何写入之前：文件与受影响状态都保持原样
		expect(await readFile(join(dir, "config.yml"), "utf8")).toBe(broken);
		expect(await manager.trustStore.getDecision("C:\\New")).toBeNull();
		expect(await manager.trustStore.getDecision("C:\\Existing")).toBe(true);
	});

	it("export includes editable settings but no credential keys", async () => {
		await manager.ompConfig.patch({
			set: [
				{ path: "enabledModels", value: ["openai/gpt-4o"] },
				{ path: "compaction.keepRecentTokens", value: 1234 },
				{ path: "auth.broker.token", value: "secret" },
			],
		});
		const pkg = JSON.parse(await manager.exportConfig());
		expect(pkg.files["config.yml"].enabledModels).toEqual(["openai/gpt-4o"]);
		expect(pkg.files["config.yml"].compaction).toEqual({ keepRecentTokens: 1234 });
		expect(pkg.files["config.yml"].auth).toBeUndefined();
	});

	it("round-trips presets, cycle order and fallback chains", async () => {
		await manager.rolesStore.applyDefault("openai/gpt-4o", "high");
		await manager.rolesStore.saveModelPreset("fast-lane");
		await manager.rolesStore.setCycleOrder(["smol", "default"]);
		await manager.rolesStore.setFallbackChains({ default: ["openai/gpt-4o-mini"] });
		const exported = await manager.exportConfig();
		const pkg = JSON.parse(exported);
		expect(pkg.files["config.yml"].modelPresets["fast-lane"].modelRoles.default).toBe(
			"openai/gpt-4o:high",
		);
		expect(pkg.files["config.yml"].cycleOrder).toEqual(["smol", "default"]);
		expect(pkg.files["config.yml"].retry.fallbackChains).toEqual({
			default: ["openai/gpt-4o-mini"],
		});

		const target = await realpath(await mkdtemp(join(tmpdir(), "config-import-extras-")));
		try {
			const restored = new ConfigManager(target);
			expect((await restored.importConfig(exported)).valid).toBe(true);
			expect(Object.keys(await restored.rolesStore.readModelPresets())).toEqual(["fast-lane"]);
			expect(await restored.rolesStore.readCycleOrder()).toEqual(["smol", "default"]);
			expect(await restored.rolesStore.readFallbackChains()).toEqual({
				default: ["openai/gpt-4o-mini"],
			});
		} finally {
			await rm(target, { recursive: true, force: true });
		}
	});
});
